//! Runs the receipt watcher on its own thread inside the desktop app (S2-06 PR 1).
//!
//! Isolation: the watcher has its own thread and never touches the bridge, SimConnect or the recorder.
//! It reaches the store through the same serialised actor as every command, one small transaction per
//! file. Senders (`WatcherHandle::nudge`) never block. If the thread cannot start, or notifications
//! cannot be established, the app keeps working; health says so.

use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Instant;

use notify::{RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

use super::scan::default_root;
use super::watch::{run_loop, FileUpdate, ImportOne, KnownFile, LoopCtx, Msg, Ready, WatchConfig, WatchFs, WatchSink, WatcherHandle, WatcherHealth};
use super::watch_fs::RealFs;
use crate::store::actor::StoreHandle;
use crate::store::watch::WATCH_ENABLED_KEY;
use crate::store::{now_utc_ms, StoreError};

pub const HEALTH_EVENT: &str = "receipts://watch";
pub const IMPORTED_EVENT: &str = "receipts://imported";

struct TauriSink {
    app: AppHandle,
    store: StoreHandle,
    started: Instant,
}

impl TauriSink {
    fn call<T: Send + 'static>(&self, f: impl FnOnce(&mut crate::store::StoreSlot) -> Result<T, StoreError> + Send + 'static) -> Result<T, String> {
        tauri::async_runtime::block_on(self.store.call(f)).map_err(|e| e.message)
    }
}

impl WatchSink for TauriSink {
    fn load_known(&self) -> Result<Vec<KnownFile>, String> {
        self.call(|slot| slot.get()?.receipt_files_load())
    }
    fn load_enabled(&self) -> bool {
        self.call(|slot| slot.get()?.watch_enabled()).unwrap_or(true)
    }
    fn save_enabled(&self, enabled: bool) -> Result<(), String> {
        self.call(move |slot| slot.get()?.setting_set(WATCH_ENABLED_KEY, if enabled { "true" } else { "false" }))
    }
    fn persist(&self, updates: &[FileUpdate]) -> Result<(), String> {
        let updates = updates.to_vec();
        self.call(move |slot| slot.get()?.receipt_files_apply(&updates))
    }
    fn import(&self, ready: &Ready) -> Result<ImportOne, String> {
        let ready = ready.clone();
        self.call(move |slot| slot.get()?.receipt_watch_import(&ready))
    }
    fn health_changed(&self, health: &WatcherHealth) {
        let _ = self.app.emit(HEALTH_EVENT, health);
    }
    fn receipts_changed(&self, imported: usize) {
        let _ = self.app.emit(IMPORTED_EVENT, imported);
    }
    fn now_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }
    fn now_utc(&self) -> String {
        now_utc_ms()
    }
}

/// Start the watcher thread. Always returns a handle; on failure its health reports why.
pub fn start(app: AppHandle, store: StoreHandle) -> WatcherHandle {
    let (tx, rx) = mpsc::channel::<Msg>();
    let health = Arc::new(Mutex::new(WatcherHealth::initial(true)));
    let handle = WatcherHandle::new(tx.clone(), health.clone());
    let root = default_root();
    let thread_health = health.clone();
    let spawned = std::thread::Builder::new().name("receipt-watcher".into()).spawn(move || {
        let sink = TauriSink { app, store, started: Instant::now() };
        let fs = root.clone().map(|root| RealFs { root });
        let mut notifier: Option<notify::RecommendedWatcher> = None;
        let notify_tx = tx.clone();
        let watch_root: Option<PathBuf> = root.clone();
        let mut ensure = move || -> bool {
            let Some(root) = watch_root.as_ref() else { return false };
            if notifier.is_some() {
                if root.is_dir() {
                    return true;
                }
                notifier = None; // folder went away; re-establish when it is back
                return false;
            }
            if !root.is_dir() {
                return false;
            }
            let tx = notify_tx.clone();
            let created = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                if let Ok(ev) = res {
                    for p in ev.paths {
                        let _ = tx.send(Msg::Hint(p));
                    }
                }
            });
            match created {
                Ok(mut w) => {
                    if w.watch(root, RecursiveMode::Recursive).is_ok() {
                        notifier = Some(w);
                        true
                    } else {
                        false
                    }
                }
                Err(_) => false,
            }
        };
        let rel_fs = root.clone().map(|root| RealFs { root });
        let relative = move |p: &std::path::Path| rel_fs.as_ref().and_then(|f| f.relative(p));
        let sleep = |ms: u64| std::thread::sleep(std::time::Duration::from_millis(ms));
        let mut ctx = LoopCtx {
            fs: fs.as_ref().map(|f| f as &dyn WatchFs),
            sink: &sink,
            cfg: WatchConfig::default(),
            health: thread_health,
            ensure_notifications: &mut ensure,
            relative: &relative,
            manual_wait_ms: 15_000,
            sleep: &sleep,
        };
        run_loop(&mut ctx, rx);
    });
    if spawned.is_err() {
        let mut h = health.lock().unwrap_or_else(|p| p.into_inner());
        h.state = super::watch::WatchState::Stopped;
        h.detail = Some("The receipt watcher could not start; use Scan GSX receipts.".into());
        h.last_error_at_utc = Some(now_utc_ms());
    }
    handle
}
