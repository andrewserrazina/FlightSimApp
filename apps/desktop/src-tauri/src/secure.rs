//! Session material in OS secure storage (Windows Credential Manager, macOS Keychain, Linux kernel
//! keyring via keyutils). The webview can store/read/delete exactly ONE item — the auth session —
//! under a fixed service/account name; it cannot address arbitrary credentials. Values are never
//! logged. If secure storage is unavailable the call fails and the app keeps the session in memory
//! only (the user signs in again next launch) — it never falls back to localStorage or files.

use serde::Serialize;

const SERVICE: &str = "dev.flightsimapp.desktop";
const ACCOUNT: &str = "supabase-auth-session";
const MAX_VALUE_BYTES: usize = 16 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecureError {
    pub message: String,
}

fn err(e: keyring::Error) -> SecureError {
    // keyring errors do not contain the secret; keep only the category.
    let message = match e {
        keyring::Error::NoStorageAccess(_) | keyring::Error::PlatformFailure(_) => "Secure credential storage is not available on this system.".into(),
        other => format!("Secure credential storage error ({}).", kind(&other)),
    };
    SecureError { message }
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

fn entry() -> Result<keyring::Entry, SecureError> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(err)
}

#[tauri::command]
pub fn secure_session_get() -> Result<Option<String>, SecureError> {
    match entry()?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(err(e)),
    }
}

#[tauri::command]
pub fn secure_session_set(value: String) -> Result<(), SecureError> {
    if value.len() > MAX_VALUE_BYTES {
        return Err(SecureError { message: "Session data is too large.".into() });
    }
    entry()?.set_password(&value).map_err(err)
}

#[tauri::command]
pub fn secure_session_delete() -> Result<(), SecureError> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(err(e)),
    }
}

/// Probe used by the UI to explain whether sessions can persist across restarts.
#[tauri::command]
pub fn secure_storage_status() -> bool {
    let probe = keyring::Entry::new(SERVICE, "probe");
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

    #[test]
    fn rejects_oversized_values_without_touching_storage() {
        assert!(secure_session_set("x".repeat(MAX_VALUE_BYTES + 1)).is_err());
    }

    /// Round-trip where the platform store exists (skips with a message where it does not, e.g.
    /// sandboxed CI without keyutils).
    #[test]
    fn round_trips_when_available() {
        if !secure_storage_status() {
            eprintln!("secure storage unavailable in this environment; round-trip not exercised");
            return;
        }
        secure_session_set("{\"test\":true}".into()).unwrap();
        assert_eq!(secure_session_get().unwrap().as_deref(), Some("{\"test\":true}"));
        secure_session_delete().unwrap();
        assert_eq!(secure_session_get().unwrap(), None);
        secure_session_delete().unwrap(); // idempotent
    }
}
