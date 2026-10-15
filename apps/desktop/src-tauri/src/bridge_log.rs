//! Bridge log file. The sidecar logs to stderr only; a Windows GUI app has no console, so without
//! this file an installed build would keep no bridge logs at all (needed by simulator testers).
//!
//! * Location: `<data dir>/logs/bridge.log` (Windows: `%APPDATA%\dev.flightsimapp.desktop\logs`).
//! * One previous file is kept as `bridge.1.log` (rotated at app start).
//! * Capped per app run; the current session token is redacted if it ever appeared in a line
//!   (the bridge never logs it — defence in depth).

use std::path::{Path, PathBuf};

use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};

pub const FILE: &str = "bridge.log";
pub const PREVIOUS: &str = "bridge.1.log";
pub const MAX_BYTES: u64 = 20 * 1024 * 1024;

/// Create the log directory and rotate the previous run's file. None when the directory is unusable
/// (logging is then skipped; it never blocks the bridge).
pub fn prepare(dir: &Path) -> Option<PathBuf> {
    std::fs::create_dir_all(dir).ok()?;
    let path = dir.join(FILE);
    if path.exists() {
        let _ = std::fs::rename(&path, dir.join(PREVIOUS));
    }
    Some(path)
}

pub fn redact(line: &str, secret: &str) -> String {
    if secret.len() >= 16 && line.contains(secret) {
        line.replace(secret, "[redacted]")
    } else {
        line.to_string()
    }
}

/// Append `header` and then every stderr line of one bridge process to `path`, until EOF or until
/// the file reaches `max_bytes`. In debug builds lines are also echoed to the shell's stderr.
pub async fn copy(reader: impl AsyncRead + Unpin, path: PathBuf, header: String, secret: String, max_bytes: u64) {
    let file = tokio::fs::OpenOptions::new().create(true).append(true).open(&path).await;
    let mut lines = BufReader::new(reader).lines();
    let Ok(mut file) = file else {
        while let Ok(Some(_)) = lines.next_line().await {} // keep draining so the bridge never blocks
        return;
    };
    let mut size = file.metadata().await.map(|m| m.len()).unwrap_or(0);
    let mut full = false;
    let _ = file.write_all(format!("{header}\n").as_bytes()).await;
    while let Ok(Some(line)) = lines.next_line().await {
        let line = redact(&line, &secret);
        if cfg!(debug_assertions) {
            eprintln!("{line}");
        }
        if full {
            continue;
        }
        size += line.len() as u64 + 1;
        if size > max_bytes {
            full = true;
            let _ = file.write_all(b"[bridge log size limit reached; further lines dropped until the next app start]\n").await;
            continue;
        }
        let _ = file.write_all(format!("{line}\n").as_bytes()).await;
    }
    let _ = file.flush().await;
}

/// UTC timestamp `YYYY-MM-DDTHH:MM:SSZ` without extra dependencies.
pub fn utc_now() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let (days, rem) = (secs / 86_400, secs % 86_400);
    // Civil-from-days (Howard Hinnant), valid for the Unix era.
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("flightsim-bridge-log-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn rotation_keeps_one_previous_file() {
        let dir = temp_dir("rotate");
        let path = prepare(&dir).unwrap();
        std::fs::write(&path, "run 1").unwrap();
        prepare(&dir).unwrap();
        std::fs::write(&path, "run 2").unwrap();
        prepare(&dir).unwrap();
        assert!(!path.exists());
        assert_eq!(std::fs::read_to_string(dir.join(PREVIOUS)).unwrap(), "run 2");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn token_is_redacted() {
        let token = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
        assert_eq!(redact(&format!("hello {token} x"), token), "hello [redacted] x");
        assert_eq!(redact("short", ""), "short");
    }

    #[tokio::test]
    async fn copies_lines_with_header_and_stops_at_the_cap() {
        let dir = temp_dir("copy");
        let path = prepare(&dir).unwrap();
        let input: &[u8] = b"line one\nsecret-token-0123456789 here\nline three is long enough to pass the cap\n";
        copy(input, path.clone(), "=== start ===".into(), "secret-token-0123456789".into(), 60).await;
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.starts_with("=== start ===\nline one\n[redacted] here\n"), "{text}");
        assert!(text.contains("size limit reached"));
        assert!(!text.contains("line three"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn utc_timestamp_shape() {
        let t = utc_now();
        assert_eq!(t.len(), 20);
        assert!(t.starts_with("20") && t.ends_with('Z'));
    }
}
