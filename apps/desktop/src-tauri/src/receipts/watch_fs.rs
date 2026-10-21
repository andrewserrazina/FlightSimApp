//! Read-only file-system access for the GSX receipt watcher (S2-06 PR 1).
//!
//! Same rules as `scan`: the fixed Receipts root, `<group>/…` at most two levels deep, `.html`/`.htm`,
//! at most 2 MB, links and reparse points never followed. Unlike `scan`, listing reads only metadata;
//! file contents are read later, once, after the stability gate. Nothing here writes, renames, moves,
//! locks or deletes anything. On Windows, files are opened with full sharing so GSX is never blocked.

use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use super::fuel::MAX_RECEIPT_BYTES;
use super::scan::{has_html_extension, is_link, Skipped, MAX_DEPTH, MAX_FILES_PER_SCAN};
use super::watch::{IoFailure, ListedFile, Listing, Meta, RootState, WatchFs};
use crate::store::format_unix_utc;

pub struct RealFs {
    pub root: PathBuf,
}

fn meta_of(m: &fs::Metadata) -> Meta {
    let mtime_ns = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos().min(i64::MAX as u128) as i64).unwrap_or(0);
    Meta { size: m.len(), mtime_ns }
}

fn classify(e: &std::io::Error) -> IoFailure {
    // ERROR_SHARING_VIOLATION (32) / ERROR_LOCK_VIOLATION (33): GSX is still writing.
    if cfg!(windows) && matches!(e.raw_os_error(), Some(32) | Some(33)) {
        return IoFailure::Busy;
    }
    match e.kind() {
        std::io::ErrorKind::NotFound => IoFailure::NotFound,
        std::io::ErrorKind::PermissionDenied => IoFailure::PermissionDenied,
        k => IoFailure::Other(k.to_string()),
    }
}

impl RealFs {
    /// Absolute path for a watcher-relative path, only if it is a plain `group/…/file` path inside the root.
    fn resolve(&self, rel: &str) -> Option<PathBuf> {
        let p = Path::new(rel);
        let parts: Vec<_> = p.components().collect();
        if parts.len() < 2 || parts.len() > MAX_DEPTH + 1 || !parts.iter().all(|c| matches!(c, Component::Normal(_))) {
            return None;
        }
        Some(self.root.join(p))
    }

    /// Watcher-relative `/`-separated path for an absolute path reported by notifications.
    pub fn relative(&self, abs: &Path) -> Option<String> {
        let rel = abs.strip_prefix(&self.root).ok()?;
        let parts: Vec<String> = rel.components().map(|c| match c {
            Component::Normal(s) => s.to_str().map(str::to_string),
            _ => None,
        }).collect::<Option<Vec<_>>>()?;
        (parts.len() >= 2 && parts.len() <= MAX_DEPTH + 1).then(|| parts.join("/"))
    }
}

impl WatchFs for RealFs {
    fn list(&self) -> Listing {
        let mut out = Listing::default();
        let meta = match fs::symlink_metadata(&self.root) {
            Ok(m) => m,
            Err(e) => {
                out.root = match classify(&e) {
                    IoFailure::NotFound => RootState::NotFound,
                    IoFailure::PermissionDenied => RootState::AccessDenied,
                    other => RootState::Unavailable(other.describe()),
                };
                return out;
            }
        };
        if is_link(&meta) || !meta.is_dir() {
            out.root = RootState::Unavailable("The Receipts folder is a link or not a folder; it is not followed.".into());
            return out;
        }
        let entries = match fs::read_dir(&self.root) {
            Ok(r) => r,
            Err(e) => {
                out.root = match classify(&e) {
                    IoFailure::PermissionDenied => RootState::AccessDenied,
                    other => RootState::Unavailable(other.describe()),
                };
                return out;
            }
        };
        out.root = RootState::Found;
        let mut groups = vec![];
        for e in entries {
            match e {
                Ok(e) => {
                    if let Ok(m) = fs::symlink_metadata(e.path()) {
                        if !is_link(&m) && m.is_dir() {
                            if let Some(name) = e.file_name().to_str() {
                                groups.push(name.to_string());
                            }
                        }
                    } else {
                        // Cannot tell what it is: absence below it must not be read as deletion.
                        out.incomplete.push(e.file_name().to_string_lossy().into_owned());
                    }
                }
                Err(_) => out.incomplete.push(String::new()),
            }
        }
        groups.sort();
        for g in groups {
            self.walk(&g, &self.root.join(&g), "", 1, &mut out);
            if out.truncated {
                break;
            }
        }
        out.files.sort_by(|a, b| a.rel.cmp(&b.rel));
        out
    }

    fn stat(&self, rel: &str) -> Result<Meta, IoFailure> {
        let path = self.resolve(rel).ok_or(IoFailure::NotAFile)?;
        let m = fs::symlink_metadata(&path).map_err(|e| classify(&e))?;
        if is_link(&m) || !m.is_file() {
            return Err(IoFailure::NotAFile);
        }
        Ok(meta_of(&m))
    }

    fn read(&self, rel: &str) -> Result<Vec<u8>, IoFailure> {
        let path = self.resolve(rel).ok_or(IoFailure::NotAFile)?;
        let mut opts = fs::OpenOptions::new();
        opts.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE: never block GSX.
            opts.share_mode(0x1 | 0x2 | 0x4);
        }
        let f = opts.open(&path).map_err(|e| classify(&e))?;
        let mut bytes = vec![];
        f.take(MAX_RECEIPT_BYTES as u64 + 1).read_to_end(&mut bytes).map_err(|e| classify(&e))?;
        Ok(bytes)
    }
}

impl RealFs {
    fn walk(&self, group: &str, dir: &Path, prefix: &str, depth: usize, out: &mut Listing) {
        let rel_dir = format!("{group}/{prefix}").trim_end_matches('/').to_string();
        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => {
                out.incomplete.push(rel_dir.clone());
                out.skipped.push(Skipped { group: group.into(), file_name: prefix.trim_end_matches('/').into(), reason: "folder not readable".into() });
                return;
            }
        };
        let mut items = vec![];
        for e in entries {
            match e {
                Ok(e) => items.push(e),
                Err(_) => out.incomplete.push(rel_dir.clone()),
            }
        }
        items.sort_by_key(|e| e.file_name());
        for entry in items {
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                out.skipped.push(Skipped { group: group.into(), file_name: entry.file_name().to_string_lossy().into_owned(), reason: "file name is not valid Unicode".into() });
                continue;
            };
            let rel = format!("{prefix}{name}");
            let m = match fs::symlink_metadata(entry.path()) {
                Ok(m) => m,
                Err(_) => {
                    out.incomplete.push(format!("{group}/{rel}"));
                    continue;
                }
            };
            if is_link(&m) {
                out.skipped.push(Skipped { group: group.into(), file_name: rel, reason: "link not followed".into() });
                continue;
            }
            if m.is_dir() {
                if depth < MAX_DEPTH {
                    self.walk(group, &entry.path(), &format!("{rel}/"), depth + 1, out);
                }
                continue;
            }
            if !m.is_file() || !has_html_extension(&entry.path()) {
                continue;
            }
            if m.len() > MAX_RECEIPT_BYTES as u64 {
                out.skipped.push(Skipped { group: group.into(), file_name: rel, reason: "larger than the receipt size limit".into() });
                continue;
            }
            if out.files.len() >= MAX_FILES_PER_SCAN {
                out.truncated = true;
                return;
            }
            let modified_at_utc = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| format_unix_utc(d.as_secs() as i64));
            out.files.push(ListedFile { rel: format!("{group}/{rel}"), group: group.into(), file_name: rel, meta: meta_of(&m), modified_at_utc });
        }
    }
}
