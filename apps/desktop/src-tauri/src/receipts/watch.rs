//! Automatic GSX receipt watcher (S2-06 PR 1).
//!
//! Imports new GSX receipt files automatically, exactly once, without ever changing GSX's files. It does
//! no matching, creates no expenses and confirms no currency: imported receipts land in the S2-05 review
//! queue exactly as if the user had pressed "Scan".
//!
//! Design:
//! * [`Engine`] is a pure, deterministic state machine. It takes metadata observations from a
//!   [`WatchFs`] and a millisecond clock, and returns files ready to import and bookkeeping updates.
//!   It is unit-tested without a real file system.
//! * File-system notifications are only hints that a path may have changed. Periodic reconciliation
//!   scans are authoritative.
//! * Stability gate: a file is read only after the same (size, mtime) was observed on
//!   `stable_observations` consecutive polls at least `poll_ms` apart, and is re-checked after reading.
//! * Deletion is concluded only from successful, complete listings in which the file is absent
//!   `vanish_after` times in a row. A missing folder, a permission error, an I/O failure, an
//!   unreadable sub-folder or a truncated listing never counts as deletion.
//! * [`run_loop`] serialises every trigger (notifications, timers, manual scans, flight and turnaround
//!   close) through one channel on one thread, so the same file is never imported concurrently. The
//!   store's SHA-256 uniqueness is a second, independent guard.

use std::collections::{BTreeMap, BTreeSet};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;

use super::fuel::MAX_RECEIPT_BYTES;
use super::scan::{RootStatus, Skipped};

// ---------------------------------------------------------------- file-system port

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub size: u64,
    /// Modification time, nanoseconds since the Unix epoch (0 when the OS does not report one).
    pub mtime_ns: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IoFailure {
    NotFound,
    PermissionDenied,
    /// Another process (GSX) holds the file; retry later.
    Busy,
    /// A directory, link or path outside the receipt layout.
    NotAFile,
    Other(String),
}

impl IoFailure {
    pub fn describe(&self) -> String {
        match self {
            IoFailure::NotFound => "not found".into(),
            IoFailure::PermissionDenied => "permission denied".into(),
            IoFailure::Busy => "in use by another program".into(),
            IoFailure::NotAFile => "not a receipt file".into(),
            IoFailure::Other(s) => s.clone(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum RootState {
    #[default]
    Found,
    NotFound,
    AccessDenied,
    /// Exists but could not be read (I/O error, not a folder, a link …).
    Unavailable(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListedFile {
    /// `group/…/file`, `/`-separated.
    pub rel: String,
    pub group: String,
    /// Path below the group folder.
    pub file_name: String,
    pub meta: Meta,
    pub modified_at_utc: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Listing {
    pub root: RootState,
    pub files: Vec<ListedFile>,
    pub skipped: Vec<Skipped>,
    /// Relative folders (or `""` for the root) that could not be fully read: absence below them proves nothing.
    pub incomplete: Vec<String>,
    pub truncated: bool,
}

pub trait WatchFs {
    fn list(&self) -> Listing;
    fn stat(&self, rel: &str) -> Result<Meta, IoFailure>;
    /// At most `MAX_RECEIPT_BYTES + 1` bytes.
    fn read(&self, rel: &str) -> Result<Vec<u8>, IoFailure>;
}

// ---------------------------------------------------------------- engine

#[derive(Debug, Clone)]
pub struct WatchConfig {
    pub poll_ms: u64,
    /// Consecutive equal observations (each at least `poll_ms` apart) before reading.
    pub stable_observations: u32,
    /// Give up on a file that has not settled after this long (it is retried at the next reconciliation).
    pub give_up_ms: u64,
    pub reconcile_ms: u64,
    /// Back-off after a busy / permission / I/O failure; after the last step the file waits for the next reconciliation.
    pub backoff_ms: Vec<u64>,
    /// Consecutive complete listings without the file before it is recorded as vanished.
    pub vanish_after: u32,
}

impl Default for WatchConfig {
    fn default() -> Self {
        WatchConfig { poll_ms: 3_000, stable_observations: 2, give_up_ms: 120_000, reconcile_ms: 300_000, backoff_ms: vec![3_000, 10_000, 30_000], vanish_after: 2 }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FileState {
    Pending,
    Unstable,
    Imported,
    Duplicate,
    Skipped,
    Failed,
    Vanished,
}

impl FileState {
    pub fn as_str(self) -> &'static str {
        match self {
            FileState::Pending => "pending",
            FileState::Unstable => "unstable",
            FileState::Imported => "imported",
            FileState::Duplicate => "duplicate",
            FileState::Skipped => "skipped",
            FileState::Failed => "failed",
            FileState::Vanished => "vanished",
        }
    }
    pub fn parse(s: &str) -> Option<FileState> {
        Some(match s {
            "pending" => FileState::Pending,
            "unstable" => FileState::Unstable,
            "imported" => FileState::Imported,
            "duplicate" => FileState::Duplicate,
            "skipped" => FileState::Skipped,
            "failed" => FileState::Failed,
            "vanished" => FileState::Vanished,
            _ => return None,
        })
    }
    /// The file at this (size, mtime) needs no further work.
    fn settled(self) -> bool {
        matches!(self, FileState::Imported | FileState::Duplicate | FileState::Skipped)
    }
}

/// What the store remembers about one file path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownFile {
    pub rel: String,
    pub meta: Option<Meta>,
    pub state: FileState,
}

/// Bookkeeping change for one path (persisted to `receipt_files`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileUpdate {
    pub rel: String,
    pub meta: Option<Meta>,
    pub state: FileState,
    pub detail: Option<String>,
}

/// A stable file, read once, ready for import.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ready {
    pub rel: String,
    pub group: String,
    pub file_name: String,
    pub meta: Meta,
    pub modified_at_utc: Option<String>,
    pub bytes: Vec<u8>,
}

/// Where a candidate file lives (from a listing or a notification).
struct Where {
    group: String,
    file_name: String,
    modified_at_utc: Option<String>,
}

#[derive(Debug, Clone)]
struct Gate {
    group: String,
    file_name: String,
    modified_at_utc: Option<String>,
    last: Option<Meta>,
    observations: u32,
    last_poll_ms: u64,
    created_ms: u64,
    retry_at_ms: u64,
    failures: usize,
}

/// Outcome of one reconciliation listing, for health reporting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScanOutcome {
    Ok { files: usize, truncated: bool, incomplete: bool },
    FolderMissing,
    AccessDenied,
    Unavailable(String),
}

/// Split `group/…/file.html` into its group and the path below it; None if it is not a receipt path.
pub fn split_rel(rel: &str) -> Option<(String, String)> {
    let parts: Vec<&str> = rel.split('/').collect();
    if parts.len() < 2 || parts.len() > super::scan::MAX_DEPTH + 1 || parts.iter().any(|p| p.is_empty() || *p == "." || *p == "..") {
        return None;
    }
    let file = parts.last()?;
    let lower = file.to_ascii_lowercase();
    if !(lower.ends_with(".html") || lower.ends_with(".htm")) {
        return None;
    }
    Some((parts[0].to_string(), parts[1..].join("/")))
}

fn under(rel: &str, prefixes: &[String]) -> bool {
    prefixes.iter().any(|p| p.is_empty() || rel == p || rel.starts_with(&format!("{p}/")))
}

pub struct Engine {
    pub cfg: WatchConfig,
    known: BTreeMap<String, KnownFile>,
    gate: BTreeMap<String, Gate>,
    hinted: BTreeSet<String>,
    absent: BTreeMap<String, u32>,
}

impl Engine {
    pub fn new(cfg: WatchConfig, known: Vec<KnownFile>) -> Engine {
        Engine { cfg, known: known.into_iter().map(|k| (k.rel.clone(), k)).collect(), gate: BTreeMap::new(), hinted: BTreeSet::new(), absent: BTreeMap::new() }
    }

    pub fn pending(&self) -> usize {
        self.gate.len() + self.hinted.iter().filter(|h| !self.gate.contains_key(*h)).count()
    }

    pub fn count(&self, state: FileState) -> usize {
        self.known.values().filter(|k| k.state == state).count()
    }

    pub fn known(&self, rel: &str) -> Option<&KnownFile> {
        self.known.get(rel)
    }

    /// A notification says `rel` may have changed. Repeated hints for one path collapse into one.
    pub fn hint(&mut self, rel: &str) {
        if split_rel(rel).is_some() {
            self.hinted.insert(rel.to_string());
        }
    }

    fn note(&mut self, updates: &mut Vec<FileUpdate>, rel: &str, meta: Option<Meta>, state: FileState, detail: Option<String>) {
        let changed = self.known.get(rel).map(|k| k.state != state || k.meta != meta).unwrap_or(true);
        self.known.insert(rel.to_string(), KnownFile { rel: rel.to_string(), meta, state });
        if changed || detail.is_some() {
            updates.push(FileUpdate { rel: rel.to_string(), meta, state, detail });
        }
    }

    fn admit(&mut self, updates: &mut Vec<FileUpdate>, rel: &str, at: Where, meta: Option<Meta>, now: u64) {
        if self.gate.contains_key(rel) {
            return;
        }
        if let (Some(m), Some(k)) = (meta, self.known.get(rel)) {
            if k.state.settled() && k.meta == Some(m) {
                return;
            }
        }
        self.gate.insert(rel.to_string(), Gate { group: at.group, file_name: at.file_name, modified_at_utc: at.modified_at_utc, last: meta, observations: u32::from(meta.is_some()), last_poll_ms: now, created_ms: now, retry_at_ms: 0, failures: 0 });
        self.note(updates, rel, meta, FileState::Pending, None);
    }

    /// Authoritative listing. Returns bookkeeping updates and the outcome for health reporting.
    pub fn reconcile(&mut self, fs: &dyn WatchFs, now: u64) -> (Vec<FileUpdate>, ScanOutcome) {
        let listing = fs.list();
        let mut updates = vec![];
        match &listing.root {
            RootState::NotFound => return (updates, ScanOutcome::FolderMissing),
            RootState::AccessDenied => return (updates, ScanOutcome::AccessDenied),
            RootState::Unavailable(d) => return (updates, ScanOutcome::Unavailable(d.clone())),
            RootState::Found => {}
        }
        let listed: BTreeSet<String> = listing.files.iter().map(|f| f.rel.clone()).collect();
        for f in &listing.files {
            self.absent.remove(&f.rel);
            let at = Where { group: f.group.clone(), file_name: f.file_name.clone(), modified_at_utc: f.modified_at_utc.clone() };
            self.admit(&mut updates, &f.rel, at, Some(f.meta), now);
        }
        for s in &listing.skipped {
            if s.reason == "folder not readable" || s.file_name.is_empty() {
                continue;
            }
            let rel = format!("{}/{}", s.group, s.file_name);
            if self.known.get(&rel).map(|k| k.state) != Some(FileState::Skipped) {
                self.gate.remove(&rel);
                self.note(&mut updates, &rel, None, FileState::Skipped, Some(s.reason.clone()));
            }
        }
        // Deletion only from complete listings, confirmed `vanish_after` times in a row.
        if !listing.truncated {
            let gone: Vec<String> = self
                .known
                .values()
                .filter(|k| k.state != FileState::Vanished && !listed.contains(&k.rel) && !under(&k.rel, &listing.incomplete))
                .map(|k| k.rel.clone())
                .collect();
            for rel in gone {
                let n = self.absent.entry(rel.clone()).or_insert(0);
                *n += 1;
                if *n >= self.cfg.vanish_after {
                    self.absent.remove(&rel);
                    self.gate.remove(&rel);
                    let meta = self.known.get(&rel).and_then(|k| k.meta);
                    self.note(&mut updates, &rel, meta, FileState::Vanished, Some("no longer in the GSX folder; the imported copy is kept".into()));
                }
            }
        }
        let outcome = ScanOutcome::Ok { files: listing.files.len(), truncated: listing.truncated, incomplete: !listing.incomplete.is_empty() };
        (updates, outcome)
    }

    /// When the next poll is due (None when nothing is waiting).
    pub fn next_poll_at(&self) -> Option<u64> {
        if !self.hinted.is_empty() {
            return Some(0);
        }
        self.gate.values().map(|g| (g.last_poll_ms + self.cfg.poll_ms).max(g.retry_at_ms)).min()
    }

    /// Advance the stability gate. Returns files ready to import and bookkeeping updates.
    pub fn poll(&mut self, fs: &dyn WatchFs, now: u64) -> (Vec<Ready>, Vec<FileUpdate>) {
        let mut ready = vec![];
        let mut updates = vec![];
        for rel in std::mem::take(&mut self.hinted) {
            if self.gate.contains_key(&rel) {
                continue;
            }
            let Some((group, file_name)) = split_rel(&rel) else { continue };
            match fs.stat(&rel) {
                Ok(m) if m.size > MAX_RECEIPT_BYTES as u64 => self.note(&mut updates, &rel, Some(m), FileState::Skipped, Some("larger than the receipt size limit".into())),
                Ok(m) => self.admit(&mut updates, &rel, Where { group, file_name, modified_at_utc: None }, Some(m), now),
                // Gone or not a file: nothing to do; reconciliation decides about deletion.
                Err(IoFailure::NotFound) | Err(IoFailure::NotAFile) => {}
                // Cannot look yet: gate it without a reading so the back-off applies.
                Err(_) => self.admit(&mut updates, &rel, Where { group, file_name, modified_at_utc: None }, None, now),
            }
        }
        let due: Vec<String> = self.gate.iter().filter(|(_, g)| now >= g.last_poll_ms + self.cfg.poll_ms && now >= g.retry_at_ms).map(|(r, _)| r.clone()).collect();
        for rel in due {
            let mut g = self.gate.remove(&rel).expect("due entry exists");
            match self.step(fs, &rel, &mut g, now) {
                Step::Wait => {
                    self.gate.insert(rel, g);
                }
                Step::Ready(r) => ready.push(r),
                Step::Done(state, meta, detail) => self.note(&mut updates, &rel, meta, state, detail),
                Step::Drop => {}
            }
        }
        (ready, updates)
    }

    fn fail(&self, g: &mut Gate, now: u64, why: &IoFailure) -> Step {
        g.failures += 1;
        match self.cfg.backoff_ms.get(g.failures - 1) {
            Some(ms) => {
                g.retry_at_ms = now + ms;
                g.last_poll_ms = now;
                Step::Wait
            }
            None => Step::Done(FileState::Failed, g.last, Some(format!("could not read the file: {}; retried at the next scan", why.describe()))),
        }
    }

    fn step(&self, fs: &dyn WatchFs, rel: &str, g: &mut Gate, now: u64) -> Step {
        let m = match fs.stat(rel) {
            Ok(m) => m,
            Err(IoFailure::NotFound) | Err(IoFailure::NotAFile) => return Step::Drop,
            Err(e) => return self.fail(g, now, &e),
        };
        if m.size > MAX_RECEIPT_BYTES as u64 {
            return Step::Done(FileState::Skipped, Some(m), Some("larger than the receipt size limit".into()));
        }
        g.failures = 0;
        g.last_poll_ms = now;
        if g.last == Some(m) {
            g.observations += 1;
        } else {
            g.last = Some(m);
            g.observations = 1;
        }
        if g.observations < self.cfg.stable_observations {
            if now.saturating_sub(g.created_ms) >= self.cfg.give_up_ms {
                return Step::Done(FileState::Unstable, Some(m), Some("still changing; retried at the next scan".into()));
            }
            return Step::Wait;
        }
        let bytes = match fs.read(rel) {
            Ok(b) => b,
            Err(IoFailure::NotFound) | Err(IoFailure::NotAFile) => return Step::Drop,
            Err(e) => return self.fail(g, now, &e),
        };
        // Changed while we were reading? Start over with the new reading.
        match fs.stat(rel) {
            Ok(after) if after == m && bytes.len() as u64 == m.size => {}
            Ok(after) => {
                g.last = Some(after);
                g.observations = 1;
                return Step::Wait;
            }
            Err(IoFailure::NotFound) | Err(IoFailure::NotAFile) => return Step::Drop,
            Err(e) => return self.fail(g, now, &e),
        }
        Step::Ready(Ready { rel: rel.to_string(), group: g.group.clone(), file_name: g.file_name.clone(), meta: m, modified_at_utc: g.modified_at_utc.clone(), bytes })
    }

    /// Record the store's import result for a ready file.
    pub fn imported(&mut self, rel: &str, meta: Meta, duplicate: bool) {
        let state = if duplicate { FileState::Duplicate } else { FileState::Imported };
        self.known.insert(rel.to_string(), KnownFile { rel: rel.to_string(), meta: Some(meta), state });
    }

    /// Import failed in the store: forget the gate entry so the next reconciliation retries it.
    pub fn import_failed(&mut self, rel: &str, meta: Meta, detail: &str) -> FileUpdate {
        self.known.insert(rel.to_string(), KnownFile { rel: rel.to_string(), meta: Some(meta), state: FileState::Failed });
        FileUpdate { rel: rel.to_string(), meta: Some(meta), state: FileState::Failed, detail: Some(detail.chars().take(300).collect()) }
    }
}

enum Step {
    Wait,
    Ready(Ready),
    Done(FileState, Option<Meta>, Option<String>),
    Drop,
}

// ---------------------------------------------------------------- health

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WatchState {
    Starting,
    /// Notifications plus periodic scans.
    Watching,
    /// Notifications unavailable; periodic scans only.
    PeriodicOnly,
    FolderMissing,
    AccessDenied,
    /// The folder exists but cannot be read right now.
    Unavailable,
    Disabled,
    /// No GSX Receipts location on this system (not Windows).
    Unsupported,
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatcherHealth {
    pub enabled: bool,
    pub state: WatchState,
    pub detail: Option<String>,
    pub notifications: bool,
    pub last_scan_at_utc: Option<String>,
    /// Why the last scan ran: "startup", "periodic", "flight closed", "turnaround closed", "manual" …
    pub last_scan_reason: Option<String>,
    pub last_successful_scan_at_utc: Option<String>,
    pub last_import_at_utc: Option<String>,
    pub last_error: Option<String>,
    pub last_error_at_utc: Option<String>,
    pub pending: usize,
    pub unstable: usize,
    pub failed: usize,
    pub vanished: usize,
    pub imported_since_start: usize,
    pub duplicates_since_start: usize,
    /// The last listing could not read every folder, or stopped at the file limit.
    pub partial_scan: bool,
}

impl WatcherHealth {
    pub fn initial(enabled: bool) -> WatcherHealth {
        WatcherHealth {
            enabled,
            state: if enabled { WatchState::Starting } else { WatchState::Disabled },
            detail: None,
            notifications: false,
            last_scan_at_utc: None,
            last_scan_reason: None,
            last_successful_scan_at_utc: None,
            last_import_at_utc: None,
            last_error: None,
            last_error_at_utc: None,
            pending: 0,
            unstable: 0,
            failed: 0,
            vanished: 0,
            imported_since_start: 0,
            duplicates_since_start: 0,
            partial_scan: false,
        }
    }
}

// ---------------------------------------------------------------- service loop

/// Store result of importing one ready file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportOne {
    pub receipt_id: String,
    pub duplicate: bool,
    pub possible_revision: bool,
    pub verified: bool,
}

/// Everything the loop needs from the outside world (store, events, clock). Tauri in production,
/// in-memory in tests.
pub trait WatchSink {
    fn load_known(&self) -> Result<Vec<KnownFile>, String>;
    fn load_enabled(&self) -> bool;
    fn save_enabled(&self, enabled: bool) -> Result<(), String>;
    fn persist(&self, updates: &[FileUpdate]) -> Result<(), String>;
    fn import(&self, ready: &Ready) -> Result<ImportOne, String>;
    fn health_changed(&self, health: &WatcherHealth);
    fn receipts_changed(&self, imported: usize);
    fn now_ms(&self) -> u64;
    fn now_utc(&self) -> String;
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualScanReport {
    pub imported: usize,
    pub duplicates: usize,
    pub possible_revisions: usize,
    pub not_verifiable: usize,
    /// Files still settling (being written) when the scan returned; they are imported once stable.
    pub pending: usize,
}

pub enum Msg {
    /// A notification for an absolute path.
    Hint(std::path::PathBuf),
    /// Run a reconciliation soon (flight closed, turnaround closed …).
    Nudge(&'static str),
    /// Manual "Scan": reconcile now and wait (bounded) for settling files.
    ManualScan(std::sync::mpsc::Sender<(ScanOutcome, ManualScanReport)>),
    SetEnabled(bool),
    Shutdown,
}

#[derive(Clone)]
pub struct WatcherHandle {
    tx: std::sync::mpsc::Sender<Msg>,
    health: Arc<Mutex<WatcherHealth>>,
}

impl WatcherHandle {
    pub fn new(tx: std::sync::mpsc::Sender<Msg>, health: Arc<Mutex<WatcherHealth>>) -> WatcherHandle {
        WatcherHandle { tx, health }
    }
    /// Never blocks (unbounded channel), so callers on the recording path cannot be delayed.
    pub fn nudge(&self, why: &'static str) {
        let _ = self.tx.send(Msg::Nudge(why));
    }
    pub fn send(&self, m: Msg) -> bool {
        self.tx.send(m).is_ok()
    }
    pub fn health(&self) -> WatcherHealth {
        self.health.lock().map(|h| h.clone()).unwrap_or_else(|p| p.into_inner().clone())
    }
}

pub struct LoopCtx<'a> {
    pub fs: Option<&'a dyn WatchFs>,
    pub sink: &'a dyn WatchSink,
    pub cfg: WatchConfig,
    pub health: Arc<Mutex<WatcherHealth>>,
    /// Try to (re)establish notifications; returns whether they are active.
    pub ensure_notifications: &'a mut dyn FnMut() -> bool,
    /// Translate a notified absolute path into a watcher-relative path.
    pub relative: &'a dyn Fn(&std::path::Path) -> Option<String>,
    /// Upper bound for a manual scan's wait for settling files.
    pub manual_wait_ms: u64,
    pub sleep: &'a dyn Fn(u64),
}

struct LoopState {
    engine: Engine,
    enabled: bool,
    next_reconcile_ms: u64,
    reconcile_requested: bool,
    reason: &'static str,
}

/// The watcher thread body. Returns on `Shutdown` or when every sender is gone.
pub fn run_loop(ctx: &mut LoopCtx<'_>, rx: Receiver<Msg>) {
    let set = |ctx: &LoopCtx<'_>, f: &dyn Fn(&mut WatcherHealth)| {
        let snapshot = {
            let mut h = ctx.health.lock().unwrap_or_else(|p| p.into_inner());
            let before = h.clone();
            f(&mut h);
            (*h != before).then(|| h.clone())
        };
        if let Some(h) = snapshot {
            ctx.sink.health_changed(&h);
        }
    };
    let enabled = ctx.sink.load_enabled();
    let known = ctx.sink.load_known().unwrap_or_else(|e| {
        let at = ctx.sink.now_utc();
        set(ctx, &|h| {
            h.last_error = Some(format!("could not load watcher state: {e}"));
            h.last_error_at_utc = Some(at.clone());
        });
        vec![]
    });
    let mut st = LoopState { engine: Engine::new(ctx.cfg.clone(), known), enabled, next_reconcile_ms: 0, reconcile_requested: true, reason: "startup" };
    set(ctx, &|h| {
        h.enabled = enabled;
        if ctx.fs.is_none() {
            h.state = WatchState::Unsupported;
            h.detail = Some("The GSX Receipts folder is only available on Windows.".into());
        } else if !enabled {
            h.state = WatchState::Disabled;
        }
    });
    loop {
        let now = ctx.sink.now_ms();
        let mut wake = if st.enabled { st.next_reconcile_ms } else { u64::MAX };
        if st.enabled {
            if let Some(p) = st.engine.next_poll_at() {
                wake = wake.min(p);
            }
        }
        if st.reconcile_requested && st.enabled {
            wake = now;
        }
        let timeout = wake.saturating_sub(now).min(60_000);
        let msg = match rx.recv_timeout(Duration::from_millis(timeout)) {
            Ok(m) => Some(m),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => return,
        };
        let mut manual = None;
        match msg {
            Some(Msg::Shutdown) => {
                set(ctx, &|h| h.state = WatchState::Stopped);
                return;
            }
            Some(Msg::Hint(p)) => {
                if let Some(rel) = (ctx.relative)(&p) {
                    st.engine.hint(&rel);
                }
            }
            Some(Msg::Nudge(why)) => {
                st.reconcile_requested = true;
                st.reason = why;
            }
            Some(Msg::SetEnabled(on)) => {
                if let Err(e) = ctx.sink.save_enabled(on) {
                    let at = ctx.sink.now_utc();
                    set(ctx, &|h| {
                        h.last_error = Some(format!("could not save the setting: {e}"));
                        h.last_error_at_utc = Some(at.clone());
                    });
                }
                st.enabled = on;
                st.reconcile_requested = on;
                st.reason = "enabled";
                set(ctx, &|h| {
                    h.enabled = on;
                    if !on {
                        h.state = WatchState::Disabled;
                    }
                });
            }
            Some(Msg::ManualScan(reply)) => manual = Some(reply),
            None => {}
        }
        // Isolation: a bug in one iteration must not stop the thread (and never reaches recording).
        let result = catch_unwind(AssertUnwindSafe(|| iterate(ctx, &mut st, manual)));
        if result.is_err() {
            let at = ctx.sink.now_utc();
            set(ctx, &|h| {
                h.last_error = Some("internal watcher error; restarting the watcher state".into());
                h.last_error_at_utc = Some(at.clone());
            });
            let known = ctx.sink.load_known().unwrap_or_default();
            st.engine = Engine::new(ctx.cfg.clone(), known);
            st.next_reconcile_ms = ctx.sink.now_ms() + ctx.cfg.backoff_ms.last().copied().unwrap_or(30_000);
            st.reconcile_requested = false;
        }
    }
}

fn iterate(ctx: &mut LoopCtx<'_>, st: &mut LoopState, manual: Option<std::sync::mpsc::Sender<(ScanOutcome, ManualScanReport)>>) {
    if !st.enabled {
        // Off: no automatic work is pending (manual scans still run below).
        st.reconcile_requested = false;
    }
    let Some(fs) = ctx.fs else {
        // No receipts location on this system: nothing to schedule.
        st.reconcile_requested = false;
        st.next_reconcile_ms = u64::MAX;
        if let Some(reply) = manual {
            let _ = reply.send((ScanOutcome::Unavailable("The GSX Receipts folder is only available on Windows.".into()), ManualScanReport::default()));
        }
        return;
    };
    let set = |ctx: &LoopCtx<'_>, f: &dyn Fn(&mut WatcherHealth)| {
        let snapshot = {
            let mut h = ctx.health.lock().unwrap_or_else(|p| p.into_inner());
            let before = h.clone();
            f(&mut h);
            (*h != before).then(|| h.clone())
        };
        if let Some(h) = snapshot {
            ctx.sink.health_changed(&h);
        }
    };
    let mut report = ManualScanReport::default();
    let mut last_outcome = None;
    let now = ctx.sink.now_ms();
    let do_reconcile = manual.is_some() || (st.enabled && (st.reconcile_requested || now >= st.next_reconcile_ms));
    if do_reconcile {
        let reason = if manual.is_some() { "manual" } else if st.reconcile_requested { st.reason } else { "periodic" };
        st.reconcile_requested = false;
        st.next_reconcile_ms = now + ctx.cfg.reconcile_ms;
        let notifications = if st.enabled { (ctx.ensure_notifications)() } else { false };
        let (updates, outcome) = st.engine.reconcile(fs, now);
        persist(ctx, &updates);
        let at = ctx.sink.now_utc();
        let o = outcome.clone();
        let enabled = st.enabled;
        set(ctx, &|h| {
            h.last_scan_at_utc = Some(at.clone());
            h.last_scan_reason = Some(reason.to_string());
            h.notifications = notifications;
            let (state, detail) = match &o {
                ScanOutcome::Ok { truncated, incomplete, .. } => {
                    h.last_successful_scan_at_utc = Some(at.clone());
                    h.partial_scan = *truncated || *incomplete;
                    (if notifications { WatchState::Watching } else { WatchState::PeriodicOnly }, None)
                }
                ScanOutcome::FolderMissing => (WatchState::FolderMissing, Some("The GSX Receipts folder was not found. GSX may not be installed or has not written a receipt yet.".into())),
                ScanOutcome::AccessDenied => (WatchState::AccessDenied, Some("Turnline is not allowed to read the GSX Receipts folder.".into())),
                ScanOutcome::Unavailable(d) => (WatchState::Unavailable, Some(format!("The GSX Receipts folder could not be read: {d}"))),
            };
            h.state = if enabled { state } else { WatchState::Disabled };
            h.detail = detail;
        });
        last_outcome = Some(outcome);
    }
    let drain_until = manual.as_ref().map(|_| ctx.sink.now_ms() + ctx.manual_wait_ms);
    loop {
        let now = ctx.sink.now_ms();
        if st.enabled || manual.is_some() {
            let (ready, updates) = st.engine.poll(fs, now);
            persist(ctx, &updates);
            let mut imported_now = 0;
            for r in ready {
                match ctx.sink.import(&r) {
                    Ok(one) => {
                        st.engine.imported(&r.rel, r.meta, one.duplicate);
                        if one.duplicate {
                            report.duplicates += 1;
                        } else {
                            imported_now += 1;
                            report.imported += 1;
                            report.possible_revisions += usize::from(one.possible_revision);
                            report.not_verifiable += usize::from(!one.verified);
                        }
                        let at = ctx.sink.now_utc();
                        let dup = one.duplicate;
                        set(ctx, &|h| {
                            if dup {
                                h.duplicates_since_start += 1;
                            } else {
                                h.imported_since_start += 1;
                                h.last_import_at_utc = Some(at.clone());
                            }
                        });
                    }
                    Err(e) => {
                        let u = st.engine.import_failed(&r.rel, r.meta, &e);
                        persist(ctx, &[u]);
                        let at = ctx.sink.now_utc();
                        set(ctx, &|h| {
                            h.last_error = Some(format!("could not import {}: {e}", r.rel));
                            h.last_error_at_utc = Some(at.clone());
                        });
                    }
                }
            }
            if imported_now > 0 {
                ctx.sink.receipts_changed(imported_now);
            }
        }
        let pending = st.engine.pending();
        let (unstable, failed, vanished) = (st.engine.count(FileState::Unstable), st.engine.count(FileState::Failed), st.engine.count(FileState::Vanished));
        set(ctx, &|h| {
            h.pending = pending;
            h.unstable = unstable;
            h.failed = failed;
            h.vanished = vanished;
        });
        match drain_until {
            Some(until) if pending > 0 && ctx.sink.now_ms() < until => {
                let next = st.engine.next_poll_at().unwrap_or(until);
                let wait = next.saturating_sub(ctx.sink.now_ms()).clamp(1, until.saturating_sub(ctx.sink.now_ms()).max(1));
                (ctx.sleep)(wait);
            }
            _ => break,
        }
    }
    if let Some(reply) = manual {
        report.pending = st.engine.pending();
        let _ = reply.send((last_outcome.unwrap_or(ScanOutcome::Ok { files: 0, truncated: false, incomplete: false }), report));
    }
}

fn persist(ctx: &LoopCtx<'_>, updates: &[FileUpdate]) {
    if updates.is_empty() {
        return;
    }
    if let Err(e) = ctx.sink.persist(updates) {
        let at = ctx.sink.now_utc();
        let mut h = ctx.health.lock().unwrap_or_else(|p| p.into_inner());
        h.last_error = Some(format!("could not save watcher state: {e}"));
        h.last_error_at_utc = Some(at);
        let snapshot = h.clone();
        drop(h);
        ctx.sink.health_changed(&snapshot);
    }
}

/// Map a manual scan outcome to the S2-05 report's folder status.
pub fn root_status_of(o: &ScanOutcome) -> (RootStatus, Option<String>) {
    match o {
        ScanOutcome::Ok { truncated, .. } => (RootStatus::Found, truncated.then(|| "stopped at the file limit; scan again to continue".into())),
        ScanOutcome::FolderMissing => (RootStatus::NotFound, None),
        ScanOutcome::AccessDenied => (RootStatus::AccessDenied, None),
        ScanOutcome::Unavailable(d) => (RootStatus::Error, Some(d.clone())),
    }
}
