//! Session material in OS secure storage (Windows Credential Manager, macOS Keychain, Linux kernel
//! keyring via keyutils). The webview can store/read/delete exactly ONE item — the auth session —
//! under a fixed service/account name; it cannot address arbitrary credentials. Values are never
//! logged. If secure storage is unavailable the call fails and the app keeps the session in memory
//! only (the user signs in again next launch) — it never falls back to localStorage or files.
//!
//! Chunked format (S1-06). Windows Credential Manager limits a credential to 2560 bytes and the
//! `keyring` crate stores UTF-16 there, i.e. at most 1280 characters — less than one Supabase
//! session. The session is therefore split into small chunk entries plus a head entry:
//!
//! * head  `supabase-auth-session`            = `v1:<generation>:<chunks>:<length>:<fnv1a64 hex>`
//! * chunk `supabase-auth-session.g<gen>.c<i>` = up to [`CHUNK_CHARS`] characters
//!
//! A write puts the chunks of the *other* generation first and switches the head last, so a crash
//! mid-write leaves the previous session readable. A head whose chunks are missing, the wrong size
//! or fail the checksum is treated as "no session" (the user signs in again) and cleaned up — a
//! damaged entry can never be returned, crash the app or touch local flight data. Values written by
//! S1-05 (a single unchunked JSON value) are still read.

use serde::Serialize;
use std::sync::Mutex;

const SERVICE: &str = "dev.flightsimapp.desktop";
// Tests use their own account so `cargo test` never touches a developer's real saved session.
#[cfg(not(test))]
const ACCOUNT: &str = "supabase-auth-session";
#[cfg(test)]
const ACCOUNT: &str = "supabase-auth-session-test";
const MAX_VALUE_BYTES: usize = 16 * 1024;
/// Characters per chunk: 1000 UTF-16 code units = 2000 bytes, below Windows' 2560-byte limit.
const CHUNK_CHARS: usize = 1000;
const MAX_CHUNKS: usize = 40; // > 16 KiB / 1000 chars, with headroom for multi-unit characters
const HEAD_PREFIX: &str = "v1:";

/// One write/read/delete at a time across all commands (the TS adapter also serialises writes).
static LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecureError {
    pub message: String,
}

impl SecureError {
    fn new(message: impl Into<String>) -> Self {
        Self { message: message.into() }
    }
}

/// Minimal credential store, so the chunking rules are tested on every platform.
pub(crate) trait CredStore {
    fn get(&self, account: &str) -> Result<Option<String>, SecureError>;
    fn set(&self, account: &str, value: &str) -> Result<(), SecureError>;
    fn delete(&self, account: &str) -> Result<(), SecureError>;
}

struct KeyringStore;

fn err(e: keyring::Error) -> SecureError {
    // keyring errors do not contain the secret; keep only the category.
    match e {
        keyring::Error::NoStorageAccess(_) | keyring::Error::PlatformFailure(_) => SecureError::new("Secure credential storage is not available on this system."),
        other => SecureError::new(format!("Secure credential storage error ({}).", kind(&other))),
    }
}

fn kind(e: &keyring::Error) -> &'static str {
    match e {
        keyring::Error::NoEntry => "no entry",
        keyring::Error::BadEncoding(_) => "bad encoding",
        keyring::Error::TooLong(..) => "too long",
        keyring::Error::Invalid(..) => "invalid",
        keyring::Error::Ambiguous(_) => "ambiguous",
        _ => "other",
    }
}

impl CredStore for KeyringStore {
    fn get(&self, account: &str) -> Result<Option<String>, SecureError> {
        match keyring::Entry::new(SERVICE, account).map_err(err)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            // Undecodable bytes in our slot: treat like a damaged entry (fail safe, never surface it).
            Err(keyring::Error::BadEncoding(_)) => Ok(Some(String::new())),
            Err(e) => Err(err(e)),
        }
    }
    fn set(&self, account: &str, value: &str) -> Result<(), SecureError> {
        keyring::Entry::new(SERVICE, account).map_err(err)?.set_password(value).map_err(err)
    }
    fn delete(&self, account: &str) -> Result<(), SecureError> {
        match keyring::Entry::new(SERVICE, account).map_err(err)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(err(e)),
        }
    }
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    // Integrity check against torn/truncated entries (the keychain itself is the trust boundary).
    bytes.iter().fold(0xcbf2_9ce4_8422_2325_u64, |h, b| (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3))
}

fn chunk_account(account: &str, generation: u8, index: usize) -> String {
    format!("{account}.g{generation}.c{index}")
}

#[derive(Debug, PartialEq, Eq)]
struct Head {
    generation: u8,
    chunks: usize,
    length: usize,
    checksum: u64,
}

fn parse_head(raw: &str) -> Option<Head> {
    let rest = raw.strip_prefix(HEAD_PREFIX)?;
    let mut parts = rest.split(':');
    let generation = parts.next()?.parse::<u8>().ok().filter(|g| *g <= 1)?;
    let chunks = parts.next()?.parse::<usize>().ok().filter(|c| (1..=MAX_CHUNKS).contains(c))?;
    let length = parts.next()?.parse::<usize>().ok().filter(|l| *l <= MAX_VALUE_BYTES)?;
    let checksum = u64::from_str_radix(parts.next()?, 16).ok()?;
    parts.next().is_none().then_some(Head { generation, chunks, length, checksum })
}

fn split_chunks(value: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut count = 0;
    for (i, _) in value.char_indices() {
        if count == CHUNK_CHARS {
            out.push(&value[start..i]);
            start = i;
            count = 0;
        }
        count += 1;
    }
    out.push(&value[start..]);
    out
}

fn delete_generation<S: CredStore>(store: &S, account: &str, generation: u8) {
    for i in 0..MAX_CHUNKS {
        let _ = store.delete(&chunk_account(account, generation, i));
    }
}

fn delete_all<S: CredStore>(store: &S, account: &str) -> Result<(), SecureError> {
    store.delete(account)?; // head first: a crash mid-delete leaves nothing that reads as a session
    delete_generation(store, account, 0);
    delete_generation(store, account, 1);
    Ok(())
}

pub(crate) fn read_session<S: CredStore>(store: &S, account: &str) -> Result<Option<String>, SecureError> {
    let Some(raw) = store.get(account)? else { return Ok(None) };
    if raw.starts_with('{') {
        return Ok(Some(raw)); // S1-05 unchunked value (fits within non-Windows limits)
    }
    let assembled = parse_head(&raw).and_then(|head| {
        let mut value = String::with_capacity(head.length);
        for i in 0..head.chunks {
            value.push_str(&store.get(&chunk_account(account, head.generation, i)).ok()??);
        }
        (value.len() == head.length && fnv1a64(value.as_bytes()) == head.checksum).then_some(value)
    });
    if assembled.is_none() {
        // Damaged or foreign entry: never returned; removed so the next sign-in starts clean.
        let _ = delete_all(store, account);
    }
    Ok(assembled)
}

pub(crate) fn write_session<S: CredStore>(store: &S, account: &str, value: &str) -> Result<(), SecureError> {
    if value.len() > MAX_VALUE_BYTES {
        return Err(SecureError::new("Session data is too large."));
    }
    let previous = store.get(account).ok().flatten().and_then(|h| parse_head(&h));
    let generation = previous.as_ref().map_or(0, |h| 1 - h.generation);
    let chunks = split_chunks(value);
    if chunks.len() > MAX_CHUNKS {
        return Err(SecureError::new("Session data is too large."));
    }
    delete_generation(store, account, generation); // stale leftovers of an interrupted write
    for (i, chunk) in chunks.iter().enumerate() {
        store.set(&chunk_account(account, generation, i), chunk)?;
    }
    store.set(account, &format!("{HEAD_PREFIX}{generation}:{}:{}:{:x}", chunks.len(), value.len(), fnv1a64(value.as_bytes())))?;
    if previous.is_some() {
        delete_generation(store, account, 1 - generation);
    }
    Ok(())
}

fn locked<T>(f: impl FnOnce() -> Result<T, SecureError>) -> Result<T, SecureError> {
    let _guard = LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    f()
}

#[tauri::command]
pub fn secure_session_get() -> Result<Option<String>, SecureError> {
    locked(|| read_session(&KeyringStore, ACCOUNT))
}

#[tauri::command]
pub fn secure_session_set(value: String) -> Result<(), SecureError> {
    locked(|| write_session(&KeyringStore, ACCOUNT, &value))
}

#[tauri::command]
pub fn secure_session_delete() -> Result<(), SecureError> {
    locked(|| delete_all(&KeyringStore, ACCOUNT))
}

/// Probe used by the UI to explain whether sessions can persist across restarts.
#[tauri::command]
pub fn secure_storage_status() -> bool {
    let probe = keyring::Entry::new(SERVICE, if cfg!(test) { "probe-test" } else { "probe" });
    match probe {
        Ok(e) => {
            let ok = e.set_password("ok").is_ok() && e.get_password().map(|v| v == "ok").unwrap_or(false);
            let _ = e.delete_credential();
            ok
        }
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    /// In-memory store with Windows' effective per-entry limit (1280 UTF-16 code units).
    #[derive(Default)]
    struct MemStore {
        entries: RefCell<BTreeMap<String, String>>,
        fail_set_after: RefCell<Option<usize>>,
        fail_get: RefCell<bool>,
    }

    impl CredStore for MemStore {
        fn get(&self, account: &str) -> Result<Option<String>, SecureError> {
            if *self.fail_get.borrow() {
                return Err(SecureError::new("Secure credential storage is not available on this system."));
            }
            Ok(self.entries.borrow().get(account).cloned())
        }
        fn set(&self, account: &str, value: &str) -> Result<(), SecureError> {
            if let Some(n) = self.fail_set_after.borrow_mut().as_mut() {
                if *n == 0 {
                    return Err(SecureError::new("Secure credential storage error (other)."));
                }
                *n -= 1;
            }
            if value.encode_utf16().count() > 1280 {
                return Err(SecureError::new("Secure credential storage error (too long)."));
            }
            self.entries.borrow_mut().insert(account.into(), value.into());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<(), SecureError> {
            self.entries.borrow_mut().remove(account);
            Ok(())
        }
    }

    fn session(len: usize) -> String {
        let body: String = "a".repeat(len.saturating_sub(21)); // wrapper below is 21 chars
        format!("{{\"flightsim-auth\":\"{body}\"}}")
    }

    #[test]
    fn tests_never_use_the_real_session_entry() {
        assert_ne!(ACCOUNT, "supabase-auth-session");
    }

    #[test]
    fn a_real_sized_session_round_trips_within_windows_entry_limits() {
        let s = MemStore::default();
        for len in [25, 1280, 2209, 2972, 9_000, MAX_VALUE_BYTES] {
            let v = session(len);
            write_session(&s, "acct", &v).unwrap();
            assert_eq!(read_session(&s, "acct").unwrap().as_deref(), Some(v.as_str()), "len {len}");
            assert!(s.entries.borrow().values().all(|e| e.encode_utf16().count() <= 1280));
        }
    }

    #[test]
    fn an_unchunked_real_session_would_not_fit_a_windows_entry() {
        // The S1-05 bug this format fixes: one entry per session fails on Windows.
        let s = MemStore::default();
        assert!(s.set("acct", &session(2_209)).is_err());
    }

    #[test]
    fn multibyte_text_is_split_on_character_boundaries() {
        let s = MemStore::default();
        let v = format!("{{\"x\":\"{}\"}}", "ü✈️漢".repeat(700));
        write_session(&s, "acct", &v).unwrap();
        assert_eq!(read_session(&s, "acct").unwrap(), Some(v));
    }

    #[test]
    fn stale_session_is_replaced_and_old_chunks_removed() {
        let s = MemStore::default();
        write_session(&s, "acct", &session(9_000)).unwrap();
        write_session(&s, "acct", "{\"small\":true}").unwrap();
        assert_eq!(read_session(&s, "acct").unwrap().as_deref(), Some("{\"small\":true}"));
        assert_eq!(s.entries.borrow().len(), 2, "head + one chunk; the 9 old chunks are gone");
    }

    #[test]
    fn an_interrupted_write_keeps_the_previous_session() {
        let s = MemStore::default();
        let old = session(3_000);
        write_session(&s, "acct", &old).unwrap();
        *s.fail_set_after.borrow_mut() = Some(2); // dies after 2 of the new chunks, before the head
        assert!(write_session(&s, "acct", &session(5_000)).is_err());
        *s.fail_set_after.borrow_mut() = None;
        assert_eq!(read_session(&s, "acct").unwrap(), Some(old));
        write_session(&s, "acct", "{\"next\":1}").unwrap();
        assert_eq!(read_session(&s, "acct").unwrap().as_deref(), Some("{\"next\":1}"));
    }

    #[test]
    fn truncated_missing_or_corrupted_chunks_read_as_no_session_and_are_cleaned_up() {
        for damage in ["truncate", "missing", "flip", "extra"] {
            let s = MemStore::default();
            write_session(&s, "acct", &session(3_000)).unwrap();
            let key = chunk_account("acct", 0, 1);
            {
                let mut e = s.entries.borrow_mut();
                let v = e.get(&key).cloned().unwrap();
                match damage {
                    "truncate" => {
                        e.insert(key.clone(), v[..v.len() - 5].to_string());
                    }
                    "missing" => {
                        e.remove(&key);
                    }
                    "flip" => {
                        e.insert(key.clone(), v.replacen('a', "b", 1));
                    }
                    _ => {
                        e.insert(key.clone(), format!("{v}zz"));
                    }
                }
            }
            assert_eq!(read_session(&s, "acct").unwrap(), None, "{damage}");
            assert!(s.entries.borrow().is_empty(), "{damage}: damaged entries removed");
        }
    }

    #[test]
    fn malformed_heads_are_never_returned() {
        for head in ["", "null", "25 bytes of nonsense!!!!!", "v1:", "v1:2:1:10:abc", "v1:0:0:0:0", "v1:0:999:10:abc", "v1:0:1:99999999:abc", "v1:0:1:10:zz", "v1:0:1:10:abc:extra"] {
            let s = MemStore::default();
            s.entries.borrow_mut().insert("acct".into(), head.into());
            assert_eq!(read_session(&s, "acct").unwrap(), None, "{head:?}");
        }
    }

    #[test]
    fn s1_05_unchunked_values_are_still_read() {
        let s = MemStore::default();
        s.entries.borrow_mut().insert("acct".into(), "{\"flightsim-auth\":\"x\"}".into());
        assert_eq!(read_session(&s, "acct").unwrap().as_deref(), Some("{\"flightsim-auth\":\"x\"}"));
        write_session(&s, "acct", &session(3_000)).unwrap(); // upgraded on next write
        assert!(s.entries.borrow()["acct"].starts_with(HEAD_PREFIX));
    }

    #[test]
    fn read_failures_surface_as_a_category_without_secrets() {
        let s = MemStore::default();
        write_session(&s, "acct", "{\"secret\":\"token-value\"}").unwrap();
        *s.fail_get.borrow_mut() = true;
        let e = read_session(&s, "acct").unwrap_err();
        assert!(!e.message.contains("token-value"));
    }

    #[test]
    fn write_failure_reports_an_error_and_keeps_the_old_session() {
        let s = MemStore::default();
        write_session(&s, "acct", "{\"old\":1}").unwrap();
        *s.fail_set_after.borrow_mut() = Some(0);
        let e = write_session(&s, "acct", "{\"secret\":\"new-token\"}").unwrap_err();
        assert!(!e.message.contains("new-token"));
        *s.fail_set_after.borrow_mut() = None;
        assert_eq!(read_session(&s, "acct").unwrap().as_deref(), Some("{\"old\":1}"));
    }

    #[test]
    fn oversized_values_are_rejected_without_touching_storage() {
        let s = MemStore::default();
        assert!(write_session(&s, "acct", &"x".repeat(MAX_VALUE_BYTES + 1)).is_err());
        assert!(s.entries.borrow().is_empty());
    }

    #[test]
    fn delete_removes_head_and_every_chunk() {
        let s = MemStore::default();
        write_session(&s, "acct", &session(9_000)).unwrap();
        write_session(&s, "acct", &session(4_000)).unwrap();
        delete_all(&s, "acct").unwrap();
        assert!(s.entries.borrow().is_empty());
        assert_eq!(read_session(&s, "acct").unwrap(), None);
    }

    #[test]
    fn concurrent_updates_leave_one_complete_session() {
        let s = std::sync::Arc::new(Mutex::new(MemStore::default()));
        let writers: Vec<_> = (0..8)
            .map(|i| {
                let s = s.clone();
                std::thread::spawn(move || {
                    let store = s.lock().unwrap();
                    write_session(&*store, "acct", &format!("{{\"writer\":{i},\"pad\":\"{}\"}}", "p".repeat(2_000 + i * 300))).unwrap();
                })
            })
            .collect();
        for w in writers {
            w.join().unwrap();
        }
        let store = s.lock().unwrap();
        let v = read_session(&*store, "acct").unwrap().expect("a complete session");
        assert!(v.starts_with("{\"writer\":"));
        assert!(store.entries.borrow().keys().all(|k| k == "acct" || k.starts_with("acct.g")));
    }

    /// Real OS store (Windows Credential Manager in CI): a full-size session must persist.
    #[test]
    fn round_trips_when_available() {
        if !secure_storage_status() {
            // CI sets this on Windows so a silently skipped Credential Manager test cannot pass.
            assert!(std::env::var_os("FLIGHTSIM_REQUIRE_SECURE_STORAGE").is_none(), "secure storage required but unavailable");
            eprintln!("secure storage unavailable in this environment; round-trip not exercised");
            return;
        }
        let big = session(2_972); // the largest real session observed (with PKCE verifiers)
        secure_session_set(big.clone()).unwrap();
        assert_eq!(secure_session_get().unwrap(), Some(big));
        secure_session_set("{\"replaced\":true}".into()).unwrap();
        assert_eq!(secure_session_get().unwrap().as_deref(), Some("{\"replaced\":true}"));
        secure_session_delete().unwrap();
        assert_eq!(secure_session_get().unwrap(), None);
        secure_session_delete().unwrap(); // idempotent
        println!("secure storage round-trip exercised with a 2972-char session");
    }
}

// SimuNet credentials are a SECOND fixed keyring namespace, independent of
// Turnline Supabase authentication and its separate flight cloud-sync consent.
// The webview can only write/delete the fixed SimuNet credential; there is NO
// command that returns the credential text to JavaScript.
#[cfg(not(test))]
const SIMUNET_KEY_ACCOUNT: &str = "simunet-operator-api-key";
#[cfg(test)]
const SIMUNET_KEY_ACCOUNT: &str = "simunet-operator-api-key-test";
#[cfg(not(test))]
const SIMUNET_CONSENT_ACCOUNT: &str = "simunet-telemetry-consent";
#[cfg(test)]
const SIMUNET_CONSENT_ACCOUNT: &str = "simunet-telemetry-consent-test";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimuNetCredentialStatus {
    pub credential_saved: bool,
    pub telemetry_enabled: bool,
    pub sender_available: bool,
}

fn simunet_status_from<S: CredStore>(store: &S) -> Result<SimuNetCredentialStatus, SecureError> {
    let credential_saved = store.get(SIMUNET_KEY_ACCOUNT)?
        .is_some_and(|value| !value.trim().is_empty());
    let telemetry_enabled = credential_saved
        && store.get(SIMUNET_CONSENT_ACCOUNT)?.as_deref() == Some("enabled");
    Ok(SimuNetCredentialStatus {
        credential_saved,
        telemetry_enabled,
        // A native allowlisted HTTPS sender is NOT implemented in this PR.
        sender_available: false,
    })
}

#[tauri::command]
pub fn simunet_credential_status() -> Result<SimuNetCredentialStatus, SecureError> {
    locked(|| simunet_status_from(&KeyringStore))
}

#[tauri::command]
pub fn simunet_credential_save(value: String) -> Result<SimuNetCredentialStatus, SecureError> {
    locked(|| {
        if value.is_empty() || value.trim() != value || value.len() > 512
            || value.chars().any(char::is_whitespace)
        {
            return Err(SecureError::new("Enter a valid SimuNet operator key."));
        }
        // A new operator key never inherits consent from the previous operator.
        KeyringStore.delete(SIMUNET_CONSENT_ACCOUNT)?;
        KeyringStore.set(SIMUNET_KEY_ACCOUNT, &value)?;
        simunet_status_from(&KeyringStore)
    })
}

#[tauri::command]
pub fn simunet_credential_set_consent(enabled: bool) -> Result<SimuNetCredentialStatus, SecureError> {
    locked(|| {
        if enabled && !simunet_status_from(&KeyringStore)?.credential_saved {
            return Err(SecureError::new("Save a SimuNet operator key before enabling consent."));
        }
        if enabled {
            KeyringStore.set(SIMUNET_CONSENT_ACCOUNT, "enabled")?;
        } else {
            KeyringStore.delete(SIMUNET_CONSENT_ACCOUNT)?;
        }
        simunet_status_from(&KeyringStore)
    })
}

#[tauri::command]
pub fn simunet_credential_disconnect() -> Result<SimuNetCredentialStatus, SecureError> {
    locked(|| {
        // Revoke consent first. A failed credential deletion is still off.
        KeyringStore.delete(SIMUNET_CONSENT_ACCOUNT)?;
        KeyringStore.delete(SIMUNET_KEY_ACCOUNT)?;
        simunet_status_from(&KeyringStore)
    })
}
