//! Dedicated writer thread that owns the SQLite connection. Callers (async Tauri commands) send
//! closures and await the reply, so SQLite work never runs on the UI thread or the telemetry relay,
//! and all database access is serialized.

use std::{path::PathBuf, sync::mpsc, thread};

use super::{StoreError, StoreErrorKind, StoreSlot};

type Job = Box<dyn FnOnce(&mut StoreSlot) + Send>;

#[derive(Clone)]
pub struct StoreHandle {
    tx: mpsc::Sender<Job>,
}

impl StoreHandle {
    pub fn spawn(path: PathBuf) -> StoreHandle {
        let (tx, rx) = mpsc::channel::<Job>();
        thread::Builder::new()
            .name("flight-store".into())
            .spawn(move || {
                let mut slot = StoreSlot::open(path);
                while let Ok(job) = rx.recv() {
                    job(&mut slot);
                }
            })
            .expect("could not start the flight store thread");
        StoreHandle { tx }
    }

    /// Run `f` on the store thread and await its result.
    pub async fn call<T: Send + 'static>(&self, f: impl FnOnce(&mut StoreSlot) -> Result<T, StoreError> + Send + 'static) -> Result<T, StoreError> {
        let (reply, rx) = tokio::sync::oneshot::channel();
        self.tx
            .send(Box::new(move |slot| {
                let _ = reply.send(f(slot));
            }))
            .map_err(|_| StoreError { kind: StoreErrorKind::Io, message: "The flight store thread has stopped.".into() })?;
        rx.await.map_err(|_| StoreError { kind: StoreErrorKind::Io, message: "The flight store did not reply.".into() })?
    }
}
