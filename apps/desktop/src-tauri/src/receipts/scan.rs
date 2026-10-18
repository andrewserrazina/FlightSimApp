//! Read-only discovery of GSX Pro receipt files (S2-05).
//!
//! Lists `<root>/<group>/…/*.html` and reads each file's bytes for import. It never writes, renames,
//! moves, locks or deletes anything; it does not follow symbolic links or junctions; it skips files that
//! are too large, have another extension, or sit deeper than two levels below a group folder.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::fuel::MAX_RECEIPT_BYTES;
use crate::store::format_unix_utc;

/// Files read per scan, at most.
pub const MAX_FILES_PER_SCAN: usize = 2_000;
pub(crate) const MAX_DEPTH: usize = 2;

#[derive(Debug, Clone)]
pub struct ScannedFile {
    pub group: String,
    /// Path relative to the group folder, `/`-separated.
    pub file_name: String,
    pub size: u64,
    pub modified_at_utc: Option<String>,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RootStatus {
    Found,
    NotFound,
    AccessDenied,
    Error,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    pub group: String,
    pub file_name: String,
    pub reason: String,
}

#[derive(Debug)]
pub struct ScanResult {
    pub root_status: RootStatus,
    pub detail: Option<String>,
    pub files: Vec<ScannedFile>,
    pub skipped: Vec<Skipped>,
    pub truncated: bool,
}

/// `%APPDATA%\Virtuali\GSX\Receipts` (Roaming application data on Windows); None elsewhere.
pub fn default_root() -> Option<PathBuf> {
    let appdata = std::env::var_os("APPDATA")?;
    Some(PathBuf::from(appdata).join("Virtuali").join("GSX").join("Receipts"))
}

pub(crate) fn is_link(meta: &fs::Metadata) -> bool {
    meta.file_type().is_symlink() || is_reparse_point(meta)
}

#[cfg(windows)]
fn is_reparse_point(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_meta: &fs::Metadata) -> bool {
    false
}

fn modified_utc(meta: &fs::Metadata) -> Option<String> {
    let secs = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() as i64;
    Some(format_unix_utc(secs))
}

pub(crate) fn has_html_extension(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("html") || e.eq_ignore_ascii_case("htm"))
}

pub fn scan(root: &Path) -> ScanResult {
    let mut out = ScanResult { root_status: RootStatus::Found, detail: None, files: vec![], skipped: vec![], truncated: false };
    let meta = match fs::symlink_metadata(root) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            out.root_status = RootStatus::NotFound;
            return out;
        }
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            out.root_status = RootStatus::AccessDenied;
            return out;
        }
        Err(e) => {
            out.root_status = RootStatus::Error;
            out.detail = Some(e.kind().to_string());
            return out;
        }
    };
    if is_link(&meta) || !meta.is_dir() {
        out.root_status = RootStatus::Error;
        out.detail = Some("The Receipts folder is a link or not a folder; it is not followed.".into());
        return out;
    }
    let groups = match fs::read_dir(root) {
        Ok(r) => r,
        Err(e) => {
            out.root_status = if e.kind() == std::io::ErrorKind::PermissionDenied { RootStatus::AccessDenied } else { RootStatus::Error };
            out.detail = Some(e.kind().to_string());
            return out;
        }
    };
    let mut dirs: Vec<(String, PathBuf)> = groups
        .flatten()
        .filter_map(|e| {
            let m = fs::symlink_metadata(e.path()).ok()?;
            (!is_link(&m) && m.is_dir()).then(|| (e.file_name().to_string_lossy().into_owned(), e.path()))
        })
        .collect();
    dirs.sort();
    for (group, dir) in dirs {
        walk(&group, &dir, "", 1, &mut out);
        if out.truncated {
            break;
        }
    }
    out
}

fn walk(group: &str, dir: &Path, prefix: &str, depth: usize, out: &mut ScanResult) {
    let Ok(entries) = fs::read_dir(dir) else {
        out.skipped.push(Skipped { group: group.into(), file_name: prefix.trim_end_matches('/').into(), reason: "folder not readable".into() });
        return;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let rel = format!("{prefix}{name}");
        let Ok(meta) = fs::symlink_metadata(entry.path()) else { continue };
        if is_link(&meta) {
            out.skipped.push(Skipped { group: group.into(), file_name: rel, reason: "link not followed".into() });
            continue;
        }
        if meta.is_dir() {
            if depth < MAX_DEPTH {
                walk(group, &entry.path(), &format!("{rel}/"), depth + 1, out);
            }
            continue;
        }
        if !meta.is_file() || !has_html_extension(&entry.path()) {
            continue;
        }
        if meta.len() > MAX_RECEIPT_BYTES as u64 {
            out.skipped.push(Skipped { group: group.into(), file_name: rel, reason: "larger than the receipt size limit".into() });
            continue;
        }
        if out.files.len() >= MAX_FILES_PER_SCAN {
            out.truncated = true;
            return;
        }
        // Opened read-only; at most the size limit + 1 byte is read even if the file grows meanwhile.
        let mut bytes = Vec::with_capacity(meta.len() as usize);
        match fs::File::open(entry.path()).and_then(|f| f.take(MAX_RECEIPT_BYTES as u64 + 1).read_to_end(&mut bytes)) {
            Ok(_) if bytes.len() > MAX_RECEIPT_BYTES => out.skipped.push(Skipped { group: group.into(), file_name: rel, reason: "larger than the receipt size limit".into() }),
            Ok(_) => out.files.push(ScannedFile { group: group.into(), file_name: rel, size: bytes.len() as u64, modified_at_utc: modified_utc(&meta), bytes }),
            Err(e) => out.skipped.push(Skipped { group: group.into(), file_name: rel, reason: format!("not readable ({})", e.kind()) }),
        }
    }
}
