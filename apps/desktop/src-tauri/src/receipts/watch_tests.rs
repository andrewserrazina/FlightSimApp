//! Receipt watcher tests (S2-06 PR 1). Engine tests use a fake file system and an explicit clock;
//! loop tests use a real temporary folder laid out like GSX's and the real (in-memory) store.

use std::cell::RefCell;
use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};

use super::fuel::{sha256_hex, MAX_RECEIPT_BYTES};
use super::scan::Skipped;
use super::watch::*;
use super::watch_fs::RealFs;
use crate::store::Store;

const KBOS: &str = include_str!("../../../../../fixtures/gsx/receipts/fuel-kbos-sanitized.html");

fn m(size: u64, mtime: i64) -> Meta {
    Meta { size, mtime_ns: mtime }
}

// ---------------------------------------------------------------- fake file system

#[derive(Default)]
struct FakeState {
    root: RootState,
    files: BTreeMap<String, (Meta, Vec<u8>)>,
    /// Failures returned by the next stat/read calls for a path, in order.
    fail: BTreeMap<String, VecDeque<IoFailure>>,
    /// After a read of this path, the file changes to this meta (simulates GSX writing during our read).
    change_on_read: BTreeMap<String, Meta>,
    incomplete: Vec<String>,
    skipped: Vec<Skipped>,
    truncated: bool,
    reads: BTreeMap<String, usize>,
    panic_on_list: usize,
}

#[derive(Default)]
struct FakeFs(RefCell<FakeState>);

impl FakeFs {
    fn put(&self, rel: &str, meta: Meta) {
        self.0.borrow_mut().files.insert(rel.into(), (meta, vec![b'x'; meta.size as usize]));
    }
    fn remove(&self, rel: &str) {
        self.0.borrow_mut().files.remove(rel);
    }
    fn reads(&self, rel: &str) -> usize {
        self.0.borrow().reads.get(rel).copied().unwrap_or(0)
    }
    fn fail_next(&self, rel: &str, f: IoFailure, times: usize) {
        let mut s = self.0.borrow_mut();
        let q = s.fail.entry(rel.into()).or_default();
        for _ in 0..times {
            q.push_back(f.clone());
        }
    }
}

impl WatchFs for FakeFs {
    fn list(&self) -> Listing {
        let mut s = self.0.borrow_mut();
        if s.panic_on_list > 0 {
            s.panic_on_list -= 1;
            panic!("simulated watcher bug");
        }
        if s.root != RootState::Found {
            return Listing { root: s.root.clone(), ..Default::default() };
        }
        let files = s
            .files
            .iter()
            .map(|(rel, (meta, _))| {
                let (group, file_name) = split_rel(rel).expect("test paths are receipt paths");
                ListedFile { rel: rel.clone(), group, file_name, meta: *meta, modified_at_utc: None }
            })
            .collect();
        Listing { root: RootState::Found, files, skipped: s.skipped.clone(), incomplete: s.incomplete.clone(), truncated: s.truncated }
    }
    fn stat(&self, rel: &str) -> Result<Meta, IoFailure> {
        let mut s = self.0.borrow_mut();
        if let Some(f) = s.fail.get_mut(rel).and_then(|q| q.pop_front()) {
            return Err(f);
        }
        s.files.get(rel).map(|(m, _)| *m).ok_or(IoFailure::NotFound)
    }
    fn read(&self, rel: &str) -> Result<Vec<u8>, IoFailure> {
        let mut s = self.0.borrow_mut();
        *s.reads.entry(rel.into()).or_default() += 1;
        let bytes = s.files.get(rel).map(|(_, b)| b.clone()).ok_or(IoFailure::NotFound)?;
        if let Some(after) = s.change_on_read.remove(rel) {
            s.files.insert(rel.into(), (after, vec![b'y'; after.size as usize]));
        }
        Ok(bytes)
    }
}

fn engine(known: Vec<KnownFile>) -> Engine {
    Engine::new(WatchConfig::default(), known)
}

/// Run reconcile at `t`, then polls every second until `until`; return every ready file and update.
fn drive(e: &mut Engine, fs: &FakeFs, t: u64, until: u64) -> (Vec<Ready>, Vec<FileUpdate>) {
    let (mut updates, _) = e.reconcile(fs, t);
    let mut ready = vec![];
    let mut now = t;
    while now <= until {
        let (r, u) = e.poll(fs, now);
        for x in &r {
            e.imported(&x.rel, x.meta, false);
        }
        ready.extend(r);
        updates.extend(u);
        now += 1_000;
    }
    (ready, updates)
}

// ---------------------------------------------------------------- engine: stability and dedup

#[test]
fn a_stable_file_is_read_once_after_two_equal_observations_at_least_3_s_apart() {
    let fs = FakeFs::default();
    fs.put("Fuel/a.html", m(100, 1));
    let mut e = engine(vec![]);
    let (u, outcome) = e.reconcile(&fs, 0);
    assert!(matches!(outcome, ScanOutcome::Ok { files: 1, .. }));
    assert_eq!(u.iter().map(|x| x.state).collect::<Vec<_>>(), [FileState::Pending]);
    assert!(e.poll(&fs, 2_999).0.is_empty(), "not before the poll interval");
    assert_eq!(fs.reads("Fuel/a.html"), 0);
    let (ready, _) = e.poll(&fs, 3_000);
    assert_eq!(ready.len(), 1);
    assert_eq!((ready[0].group.as_str(), ready[0].file_name.as_str(), ready[0].meta), ("Fuel", "a.html", m(100, 1)));
    e.imported("Fuel/a.html", m(100, 1), false);
    let (ready, _) = drive(&mut e, &fs, 4_000, 20_000);
    assert!(ready.is_empty(), "never imported twice");
    assert_eq!(fs.reads("Fuel/a.html"), 1);
}

#[test]
fn repeated_notifications_for_one_file_collapse_into_one_import() {
    let fs = FakeFs::default();
    fs.put("Fuel/a.html", m(100, 1));
    let mut e = engine(vec![]);
    for _ in 0..20 {
        e.hint("Fuel/a.html");
    }
    let (ready, _) = e.poll(&fs, 0);
    assert!(ready.is_empty());
    for _ in 0..20 {
        e.hint("Fuel/a.html");
    }
    e.reconcile(&fs, 500);
    let (ready, _) = drive(&mut e, &fs, 1_000, 10_000);
    assert_eq!(ready.len(), 1);
    assert_eq!(fs.reads("Fuel/a.html"), 1);
}

#[test]
fn a_file_still_being_written_is_not_read_until_it_stops_changing() {
    let fs = FakeFs::default();
    let mut e = engine(vec![]);
    fs.put("Fuel/a.html", m(10, 1));
    e.reconcile(&fs, 0);
    for (i, t) in [3_000u64, 6_000, 9_000].iter().enumerate() {
        fs.put("Fuel/a.html", m(10 + i as u64 * 10 + 10, 2 + i as i64));
        assert!(e.poll(&fs, *t).0.is_empty(), "still growing at {t}");
    }
    assert_eq!(fs.reads("Fuel/a.html"), 0);
    let (ready, _) = e.poll(&fs, 12_000);
    assert_eq!(ready.len(), 1);
    assert_eq!(ready[0].meta, m(40, 4));
}

#[test]
fn a_file_that_changes_during_the_read_is_gated_again() {
    let fs = FakeFs::default();
    fs.put("Fuel/a.html", m(100, 1));
    fs.0.borrow_mut().change_on_read.insert("Fuel/a.html".into(), m(120, 2));
    let mut e = engine(vec![]);
    e.reconcile(&fs, 0);
    assert!(e.poll(&fs, 3_000).0.is_empty(), "discarded: changed during read; the re-check is the new first observation");
    let (ready, _) = e.poll(&fs, 6_000);
    assert_eq!(ready.len(), 1);
    assert_eq!(ready[0].meta, m(120, 2));
    assert_eq!(ready[0].bytes.len(), 120);
}

#[test]
fn a_file_that_never_settles_is_marked_unstable_and_retried_at_the_next_scan() {
    let fs = FakeFs::default();
    let mut e = engine(vec![]);
    fs.put("Fuel/a.html", m(1, 1));
    e.reconcile(&fs, 0);
    let mut t = 3_000;
    let mut last = vec![];
    while t <= 121_000 {
        fs.put("Fuel/a.html", m(t, t as i64));
        let (r, u) = e.poll(&fs, t);
        assert!(r.is_empty());
        last.extend(u);
        t += 3_000;
    }
    assert!(last.iter().any(|u| u.state == FileState::Unstable && u.detail.as_deref().unwrap().contains("retried")));
    assert_eq!(e.pending(), 0);
    // GSX finishes; the next reconciliation picks it up.
    let (ready, _) = drive(&mut e, &fs, 300_000, 305_000);
    assert_eq!(ready.len(), 1);
}

// ---------------------------------------------------------------- engine: restart idempotency

#[test]
fn restart_reconciliation_is_idempotent_and_deterministic() {
    let fs = FakeFs::default();
    fs.put("Fuel/a.html", m(100, 1));
    fs.put("Catering/b.html", m(50, 2));
    let known = vec![KnownFile { rel: "Fuel/a.html".into(), meta: Some(m(100, 1)), state: FileState::Imported }, KnownFile { rel: "Catering/b.html".into(), meta: Some(m(50, 2)), state: FileState::Duplicate }];
    let mut e = engine(known.clone());
    let (ready, updates) = drive(&mut e, &fs, 0, 30_000);
    assert!(ready.is_empty() && updates.is_empty(), "settled files are neither re-read nor rewritten");
    assert_eq!(fs.reads("Fuel/a.html") + fs.reads("Catering/b.html"), 0);

    // A file written while Turnline was closed, and one rewritten in place, are picked up; nothing else.
    fs.put("Fuel/c.html", m(70, 3));
    fs.put("Catering/b.html", m(55, 9));
    let run = |known: Vec<KnownFile>| {
        let mut e = engine(known);
        let (r, u) = drive(&mut e, &fs, 0, 10_000);
        (r.into_iter().map(|x| (x.rel, x.meta)).collect::<Vec<_>>(), u)
    };
    let a = run(known.clone());
    let b = run(known);
    assert_eq!(a.0, vec![("Catering/b.html".to_string(), m(55, 9)), ("Fuel/c.html".to_string(), m(70, 3))]);
    assert_eq!(a, b, "same inputs, same outputs");
}

// ---------------------------------------------------------------- engine: unavailable vs deleted

#[test]
fn an_unavailable_folder_is_never_treated_as_deletion() {
    let known = vec![KnownFile { rel: "Fuel/a.html".into(), meta: Some(m(100, 1)), state: FileState::Imported }];
    for (root, expect) in [
        (RootState::NotFound, ScanOutcome::FolderMissing),
        (RootState::AccessDenied, ScanOutcome::AccessDenied),
        (RootState::Unavailable("I/O error".into()), ScanOutcome::Unavailable("I/O error".into())),
    ] {
        let fs = FakeFs::default();
        fs.0.borrow_mut().root = root;
        let mut e = engine(known.clone());
        for t in [0, 300_000, 600_000, 900_000] {
            let (u, outcome) = e.reconcile(&fs, t);
            assert!(u.is_empty(), "no updates when the folder cannot be listed");
            assert_eq!(outcome, expect);
        }
        assert_eq!(e.known("Fuel/a.html").unwrap().state, FileState::Imported);
    }
}

#[test]
fn deletion_needs_two_consecutive_complete_listings_and_keeps_the_imported_receipt_state_until_then() {
    let fs = FakeFs::default();
    let known = vec![KnownFile { rel: "Fuel/a.html".into(), meta: Some(m(100, 1)), state: FileState::Imported }];
    let mut e = engine(known);
    let (u, _) = e.reconcile(&fs, 0);
    assert!(u.is_empty(), "absent once: not yet vanished");
    fs.put("Fuel/a.html", m(100, 1));
    e.reconcile(&fs, 1);
    fs.remove("Fuel/a.html");
    let (u, _) = e.reconcile(&fs, 2);
    assert!(u.is_empty(), "the counter restarted when the file reappeared");
    let (u, _) = e.reconcile(&fs, 3);
    assert_eq!(u.len(), 1);
    assert_eq!((u[0].state, u[0].meta), (FileState::Vanished, Some(m(100, 1))));
    assert!(u[0].detail.as_deref().unwrap().contains("imported copy is kept"));
}

#[test]
fn incomplete_or_truncated_listings_never_imply_deletion() {
    let known = vec![KnownFile { rel: "Fuel/sub/a.html".into(), meta: Some(m(100, 1)), state: FileState::Imported }];
    for setup in [
        |s: &mut FakeState| s.incomplete = vec!["Fuel".into()],
        |s: &mut FakeState| s.incomplete = vec!["Fuel/sub".into()],
        |s: &mut FakeState| s.incomplete = vec!["".into()],
        |s: &mut FakeState| s.truncated = true,
    ] {
        let fs = FakeFs::default();
        setup(&mut fs.0.borrow_mut());
        let mut e = engine(known.clone());
        for t in 0..5 {
            assert!(e.reconcile(&fs, t).0.is_empty());
        }
    }
    // An unrelated unreadable folder does not protect files elsewhere.
    let fs = FakeFs::default();
    fs.0.borrow_mut().incomplete = vec!["Catering".into()];
    let mut e = engine(known);
    e.reconcile(&fs, 0);
    assert_eq!(e.reconcile(&fs, 1).0[0].state, FileState::Vanished);
}

#[test]
fn busy_permission_and_io_failures_back_off_then_wait_for_the_next_scan() {
    let fs = FakeFs::default();
    fs.put("Fuel/a.html", m(100, 1));
    let mut e = engine(vec![]);
    e.reconcile(&fs, 0);
    fs.fail_next("Fuel/a.html", IoFailure::Busy, 1);
    fs.fail_next("Fuel/a.html", IoFailure::PermissionDenied, 1);
    fs.fail_next("Fuel/a.html", IoFailure::Other("I/O error".into()), 2);
    let mut t = 3_000;
    let mut updates = vec![];
    let mut tries = vec![];
    while t < 120_000 {
        if e.next_poll_at().is_some_and(|n| n <= t) {
            tries.push(t);
            let (r, u) = e.poll(&fs, t);
            assert!(r.is_empty());
            updates.extend(u);
        }
        t += 500;
    }
    assert_eq!(tries, vec![3_000, 6_000, 16_000, 46_000], "3 s, 10 s, 30 s back-off");
    let failed = updates.iter().find(|u| u.state == FileState::Failed).expect("gives up for now");
    assert!(failed.detail.as_deref().unwrap().contains("I/O error"));
    // Never treated as deleted; the next scan tries again and succeeds.
    let (ready, _) = drive(&mut e, &fs, 300_000, 306_000);
    assert_eq!(ready.len(), 1);
}

#[test]
fn a_file_disappearing_mid_gate_is_dropped_without_being_called_deleted() {
    let fs = FakeFs::default();
    fs.put("Fuel/a.html", m(100, 1));
    let mut e = engine(vec![]);
    e.reconcile(&fs, 0);
    fs.remove("Fuel/a.html");
    let (r, u) = e.poll(&fs, 3_000);
    assert!(r.is_empty() && u.is_empty());
    assert_eq!(e.pending(), 0);
    assert_eq!(e.known("Fuel/a.html").unwrap().state, FileState::Pending);
}

#[test]
fn oversized_files_links_and_non_receipt_paths_are_skipped() {
    let fs = FakeFs::default();
    fs.put("Fuel/big.html", m(MAX_RECEIPT_BYTES as u64 + 1, 1));
    fs.0.borrow_mut().skipped = vec![Skipped { group: "Fuel".into(), file_name: "link.html".into(), reason: "link not followed".into() }];
    let mut e = engine(vec![]);
    let (ready, updates) = drive(&mut e, &fs, 0, 10_000);
    assert!(ready.is_empty());
    assert_eq!(fs.reads("Fuel/big.html"), 0);
    let skipped: Vec<_> = updates.iter().filter(|u| u.state == FileState::Skipped).map(|u| (u.rel.as_str(), u.detail.clone().unwrap())).collect();
    assert!(skipped.contains(&("Fuel/link.html", "link not followed".into())));
    assert!(skipped.contains(&("Fuel/big.html", "larger than the receipt size limit".into())));
    for bad in ["Fuel", "Fuel/notes.txt", "a.html", "Fuel/a/b/c/d.html", "Fuel/../x.html", "Fuel//x.html"] {
        e.hint(bad);
    }
    assert_eq!(e.pending(), 0, "hints outside the receipt layout are ignored");
}

// ---------------------------------------------------------------- loop: real folder + real store

struct TestSink {
    store: Mutex<Store>,
    clock: AtomicU64,
    clock_reads: AtomicUsize,
    healths: Mutex<Vec<WatcherHealth>>,
    changed: AtomicUsize,
}

impl TestSink {
    fn new(store: Store) -> TestSink {
        TestSink { store: Mutex::new(store), clock: AtomicU64::new(0), clock_reads: AtomicUsize::new(0), healths: Mutex::new(vec![]), changed: AtomicUsize::new(0) }
    }
    /// Last health reported before the test's own shutdown message.
    fn last_health(&self) -> WatcherHealth {
        self.healths.lock().unwrap().iter().rev().find(|h| h.state != WatchState::Stopped).cloned().expect("health reported")
    }
}

impl WatchSink for TestSink {
    fn load_known(&self) -> Result<Vec<KnownFile>, String> {
        self.store.lock().unwrap().receipt_files_load().map_err(|e| e.message)
    }
    fn load_enabled(&self) -> bool {
        self.store.lock().unwrap().watch_enabled().unwrap()
    }
    fn save_enabled(&self, enabled: bool) -> Result<(), String> {
        self.store.lock().unwrap().setting_set(crate::store::watch::WATCH_ENABLED_KEY, if enabled { "true" } else { "false" }).map_err(|e| e.message)
    }
    fn persist(&self, updates: &[FileUpdate]) -> Result<(), String> {
        self.store.lock().unwrap().receipt_files_apply(updates).map_err(|e| e.message)
    }
    fn import(&self, ready: &Ready) -> Result<ImportOne, String> {
        self.store.lock().unwrap().receipt_watch_import(ready).map_err(|e| e.message)
    }
    fn health_changed(&self, h: &WatcherHealth) {
        self.healths.lock().unwrap().push(h.clone());
    }
    fn receipts_changed(&self, n: usize) {
        self.changed.fetch_add(n, Ordering::SeqCst);
    }
    fn now_ms(&self) -> u64 {
        self.clock_reads.fetch_add(1, Ordering::SeqCst);
        self.clock.load(Ordering::SeqCst)
    }
    fn now_utc(&self) -> String {
        format!("2026-10-18T12:00:{:02}.000Z", (self.now_ms() / 1000) % 60)
    }
}

fn receipts_root(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("flightsim-watch-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("Fuel")).unwrap();
    root
}

fn hashes(root: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for g in std::fs::read_dir(root).unwrap().flatten() {
        if g.path().is_dir() {
            for f in std::fs::read_dir(g.path()).unwrap().flatten() {
                if f.path().is_file() {
                    out.insert(f.path().display().to_string(), sha256_hex(&std::fs::read(f.path()).unwrap()));
                }
            }
        }
    }
    out
}

/// Run the loop on this thread: queue `msgs`, then shut down. Sleeping advances the fake clock.
fn run(sink: &TestSink, fs: Option<&dyn WatchFs>, msgs: Vec<Msg>) {
    let (tx, rx) = mpsc::channel();
    for msg in msgs {
        tx.send(msg).unwrap();
    }
    tx.send(Msg::Shutdown).unwrap();
    let health = Arc::new(Mutex::new(WatcherHealth::initial(true)));
    let mut no_notify = || false;
    let relative = |_: &Path| None;
    let sleep = |ms: u64| {
        sink.clock.fetch_add(ms, Ordering::SeqCst);
    };
    let mut ctx = LoopCtx { fs, sink, cfg: WatchConfig::default(), health, ensure_notifications: &mut no_notify, relative: &relative, manual_wait_ms: 15_000, sleep: &sleep };
    run_loop(&mut ctx, rx);
}

fn manual(sink: &TestSink, fs: Option<&dyn WatchFs>) -> (ScanOutcome, ManualScanReport) {
    let (reply, rx) = mpsc::channel();
    run(sink, fs, vec![Msg::ManualScan(reply)]);
    rx.recv().unwrap()
}

fn file_states(sink: &TestSink) -> Vec<(String, String)> {
    sink.store.lock().unwrap().receipt_files_list(100).unwrap().into_iter().map(|f| (f.rel_path, f.state)).collect()
}

#[test]
fn the_loop_imports_real_files_once_leaves_gsx_files_untouched_and_survives_a_restart() {
    let root = receipts_root("loop");
    std::fs::write(root.join("Fuel").join("GSX-20261017T164423Z-KBOS.html"), KBOS).unwrap();
    std::fs::write(root.join("Fuel").join("copy-of-same.html"), KBOS).unwrap();
    std::fs::write(root.join("Fuel").join("notes.txt"), "not a receipt").unwrap();
    let before = hashes(&root);
    let fs = RealFs { root: root.clone() };
    let sink = TestSink::new(Store::open_in_memory().unwrap());

    let (outcome, r) = manual(&sink, Some(&fs));
    assert!(matches!(outcome, ScanOutcome::Ok { files: 2, .. }));
    assert_eq!((r.imported, r.duplicates, r.pending), (1, 1, 0), "same content under two names is one receipt");
    assert_eq!(sink.store.lock().unwrap().receipts_list().unwrap().len(), 1);
    let mut states = file_states(&sink);
    states.sort();
    // Deterministic order (sorted paths): the first path is imported, the identical copy is a duplicate.
    assert_eq!(states, vec![("Fuel/GSX-20261017T164423Z-KBOS.html".to_string(), "imported".to_string()), ("Fuel/copy-of-same.html".to_string(), "duplicate".to_string())]);
    assert_eq!(sink.changed.load(Ordering::SeqCst), 1);
    let h = sink.last_health();
    assert_eq!((h.state, h.imported_since_start, h.duplicates_since_start, h.last_scan_reason.as_deref()), (WatchState::PeriodicOnly, 1, 1, Some("manual")));
    assert!(h.last_successful_scan_at_utc.is_some());

    // Restart: a new loop loads its state from the store and imports nothing again.
    let (_, r) = manual(&sink, Some(&fs));
    assert_eq!((r.imported, r.duplicates), (0, 0));
    assert_eq!(sink.store.lock().unwrap().receipts_list().unwrap().len(), 1);
    assert_eq!(hashes(&root), before, "GSX files are byte-identical");

    // Nothing is matched, counted or confirmed automatically.
    let mut store = sink.store.lock().unwrap();
    let receipt = &store.receipts_list().unwrap()[0];
    assert!(receipt.flight_id.is_none() && receipt.confirmations.is_empty() && receipt.active_expense_id.is_none());
    assert!(store.expenses_list(None).unwrap().is_empty());
}

#[test]
fn deleting_a_gsx_file_marks_it_vanished_after_two_scans_and_keeps_the_receipt() {
    let root = receipts_root("vanish");
    let path = root.join("Fuel").join("a.html");
    std::fs::write(&path, KBOS).unwrap();
    let fs = RealFs { root: root.clone() };
    let sink = TestSink::new(Store::open_in_memory().unwrap());
    manual(&sink, Some(&fs));
    std::fs::remove_file(&path).unwrap();
    // Each manual run is a fresh loop (absence counts are per run), so drive two reconciliations in one run.
    let (r1, rx1) = mpsc::channel();
    let (r2, rx2) = mpsc::channel();
    run(&sink, Some(&fs), vec![Msg::ManualScan(r1), Msg::ManualScan(r2)]);
    rx1.recv().unwrap();
    rx2.recv().unwrap();
    assert_eq!(file_states(&sink), vec![("Fuel/a.html".to_string(), "vanished".to_string())]);
    let mut store = sink.store.lock().unwrap();
    assert_eq!(store.receipts_list().unwrap().len(), 1, "the imported receipt and its bytes stay");
}

#[test]
fn a_missing_folder_is_reported_and_changes_nothing() {
    let root = std::env::temp_dir().join(format!("flightsim-watch-missing-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let fs = RealFs { root };
    let sink = TestSink::new(Store::open_in_memory().unwrap());
    let (outcome, r) = manual(&sink, Some(&fs));
    assert_eq!(outcome, ScanOutcome::FolderMissing);
    assert_eq!(r, ManualScanReport::default());
    let h = sink.last_health();
    assert_eq!(h.state, WatchState::FolderMissing);
    assert!(h.last_successful_scan_at_utc.is_none());
    assert!(file_states(&sink).is_empty());
}

#[test]
fn without_a_receipts_location_the_watcher_reports_unsupported() {
    let sink = TestSink::new(Store::open_in_memory().unwrap());
    let (outcome, _) = manual(&sink, None);
    assert!(matches!(outcome, ScanOutcome::Unavailable(_)));
    assert_eq!(sink.last_health().state, WatchState::Unsupported);
}

#[test]
fn a_watcher_bug_is_contained_and_the_next_scan_works() {
    let fs = FakeFs::default();
    fs.put("Fuel/a.html", m(KBOS.len() as u64, 1));
    fs.0.borrow_mut().files.get_mut("Fuel/a.html").unwrap().1 = KBOS.as_bytes().to_vec();
    fs.0.borrow_mut().panic_on_list = 1;
    let sink = TestSink::new(Store::open_in_memory().unwrap());
    let (r1, rx1) = mpsc::channel();
    let (r2, rx2) = mpsc::channel();
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    run(&sink, Some(&fs), vec![Msg::ManualScan(r1), Msg::ManualScan(r2)]);
    std::panic::set_hook(prev);
    assert!(rx1.recv().is_err(), "the panicking scan never replied (caller falls back)");
    let (_, report) = rx2.recv().unwrap();
    assert_eq!(report.imported, 1);
    assert!(sink.healths.lock().unwrap().iter().any(|h| h.last_error.as_deref().is_some_and(|e| e.contains("internal watcher error"))));
}

#[test]
fn turning_the_watcher_off_is_persisted_and_manual_scans_still_work() {
    let root = receipts_root("disabled");
    std::fs::write(root.join("Fuel").join("a.html"), KBOS).unwrap();
    let fs = RealFs { root };
    let sink = TestSink::new(Store::open_in_memory().unwrap());
    run(&sink, Some(&fs), vec![Msg::SetEnabled(false)]);
    assert!(!sink.store.lock().unwrap().watch_enabled().unwrap());
    // Disabled: startup does not scan automatically.
    sink.healths.lock().unwrap().clear();
    run(&sink, Some(&fs), vec![]);
    assert!(file_states(&sink).is_empty());
    assert_eq!(sink.last_health().state, WatchState::Disabled);
    // A manual scan still imports.
    let (_, r) = manual(&sink, Some(&fs));
    assert_eq!(r.imported, 1);
    assert_eq!(sink.last_health().state, WatchState::Disabled);
}

#[test]
fn concurrent_imports_of_the_same_bytes_store_one_receipt() {
    let mut store = Store::open_in_memory().unwrap();
    let ready = |rel: &str| Ready { rel: rel.into(), group: "Fuel".into(), file_name: rel.trim_start_matches("Fuel/").into(), meta: m(KBOS.len() as u64, 1), modified_at_utc: None, bytes: KBOS.as_bytes().to_vec() };
    let a = store.receipt_watch_import(&ready("Fuel/a.html")).unwrap();
    let b = store.receipt_watch_import(&ready("Fuel/a.html")).unwrap();
    let c = store.receipt_watch_import(&ready("Fuel/b.html")).unwrap();
    assert!(!a.duplicate && b.duplicate && c.duplicate);
    assert_eq!(a.receipt_id, b.receipt_id);
    assert_eq!(b.receipt_id, c.receipt_id);
    assert_eq!(store.receipts_list().unwrap().len(), 1);
}

#[test]
fn notified_paths_outside_the_receipt_layout_are_ignored() {
    let fs = RealFs { root: PathBuf::from("/gsx/Receipts") };
    assert_eq!(fs.relative(Path::new("/gsx/Receipts/Fuel/a.html")).as_deref(), Some("Fuel/a.html"));
    assert_eq!(fs.relative(Path::new("/gsx/Receipts/Fuel/sub/a.html")).as_deref(), Some("Fuel/sub/a.html"));
    for p in ["/gsx/Receipts", "/gsx/Receipts/Fuel", "/elsewhere/Fuel/a.html", "/gsx/Receipts/Fuel/a/b/c.html"] {
        assert_eq!(fs.relative(Path::new(p)), None, "{p}");
    }
}

#[test]
fn an_idle_loop_sleeps_instead_of_spinning_when_disabled_or_without_a_receipts_folder() {
    let root = receipts_root("idle");
    let fs = RealFs { root };
    for (disabled, with_fs) in [(false, true), (true, true), (false, false), (true, false)] {
        let sink = TestSink::new(Store::open_in_memory().unwrap());
        if disabled {
            sink.store.lock().unwrap().setting_set(crate::store::watch::WATCH_ENABLED_KEY, "false").unwrap();
        }
        let (tx, rx) = mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                let health = Arc::new(Mutex::new(WatcherHealth::initial(true)));
                let mut no_notify = || false;
                let relative = |_: &Path| None;
                let sleep = |_: u64| {};
                let fs_ref: Option<&dyn WatchFs> = if with_fs { Some(&fs) } else { None };
                let mut ctx = LoopCtx { fs: fs_ref, sink: &sink, cfg: WatchConfig::default(), health, ensure_notifications: &mut no_notify, relative: &relative, manual_wait_ms: 0, sleep: &sleep };
                run_loop(&mut ctx, rx);
            });
            std::thread::sleep(std::time::Duration::from_millis(300));
            tx.send(Msg::Shutdown).unwrap();
        });
        let reads = sink.clock_reads.load(Ordering::SeqCst);
        assert!(reads < 50, "disabled={disabled} fs={with_fs}: {reads} wake-ups in 300 ms means the loop is spinning");
    }
}
