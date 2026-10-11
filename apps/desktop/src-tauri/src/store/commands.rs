//! Narrow Tauri command surface for the local flight store. No raw SQL, no file paths in, every
//! payload validated in `Store::commit`.

use serde::Serialize;
use tauri::State;

use super::{actor::StoreHandle, latest_schema_version, CommitBatch, FlightDetailOut, FlightSummaryOut, OpenFlightOut, StoreError, DB_FILE};

#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum StoreStatus {
    #[serde(rename_all = "camelCase")]
    Ready { schema_version: i64, location: String },
    #[serde(rename_all = "camelCase")]
    Unavailable { kind: super::StoreErrorKind, message: String, location: String, can_reset: bool },
}

fn status_of(slot: &mut super::StoreSlot) -> StoreStatus {
    let location = slot.path.display().to_string();
    match &slot.store {
        Ok(store) => StoreStatus::Ready { schema_version: store.schema_version().unwrap_or(latest_schema_version()), location },
        Err(e) => StoreStatus::Unavailable {
            can_reset: matches!(e.kind, super::StoreErrorKind::Corrupt) && slot.path.exists(),
            kind: e.kind.clone(),
            message: e.message.clone(),
            location,
        },
    }
}

#[tauri::command]
pub async fn store_status(store: State<'_, StoreHandle>, retry: Option<bool>) -> Result<StoreStatus, StoreError> {
    store
        .call(move |slot| {
            if retry == Some(true) {
                slot.retry();
            }
            Ok(status_of(slot))
        })
        .await
}

/// Move a damaged database aside (kept as `flightsim.db.damaged-<time>`) and start a new one.
#[tauri::command]
pub async fn store_reset_damaged(store: State<'_, StoreHandle>) -> Result<StoreStatus, StoreError> {
    store
        .call(|slot| {
            slot.reset_damaged()?;
            Ok(status_of(slot))
        })
        .await
}

#[tauri::command]
pub async fn flight_open(store: State<'_, StoreHandle>) -> Result<Option<OpenFlightOut>, StoreError> {
    store.call(|slot| Ok(slot.get()?.open_flight()?.map(|flight| OpenFlightOut { flight }))).await
}

#[tauri::command]
pub async fn flight_commit(store: State<'_, StoreHandle>, batch: CommitBatch) -> Result<(), StoreError> {
    store.call(move |slot| slot.get()?.commit(&batch)).await
}

#[tauri::command]
pub async fn flights_list(store: State<'_, StoreHandle>, limit: Option<i64>, offset: Option<i64>) -> Result<Vec<FlightSummaryOut>, StoreError> {
    store.call(move |slot| slot.get()?.list_flights(limit.unwrap_or(100), offset.unwrap_or(0))).await
}

#[tauri::command]
pub async fn flight_detail(store: State<'_, StoreHandle>, id: String) -> Result<Option<FlightDetailOut>, StoreError> {
    store.call(move |slot| slot.get()?.flight_detail(&id)).await
}

#[tauri::command]
pub async fn flights_prune(store: State<'_, StoreHandle>, keep_detailed_flights: i64) -> Result<usize, StoreError> {
    store.call(move |slot| slot.get()?.prune_samples(keep_detailed_flights.clamp(1, 10_000))).await
}

/// Data directory: FLIGHTSIM_DATA_DIR (tests/dev) or the platform app-data directory
/// (e.g. %APPDATA%\dev.flightsimapp.desktop on Windows).
pub fn database_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    use tauri::Manager;
    let dir = std::env::var_os("FLIGHTSIM_DATA_DIR")
        .map(std::path::PathBuf::from)
        .or_else(|| app.path().app_data_dir().ok())
        .unwrap_or_else(|| std::env::temp_dir().join("flightsimapp"));
    dir.join(DB_FILE)
}
