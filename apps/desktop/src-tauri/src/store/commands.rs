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

/// Recorded track points of a flight (read-only, S2-03 navigation debrief).
#[tauri::command]
pub async fn flight_track(store: State<'_, StoreHandle>, id: String) -> Result<Vec<super::SampleRow>, StoreError> {
    store.call(move |slot| slot.get()?.flight_track(&id)).await
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

// ---------- cloud sync bookkeeping (schema v2) ----------

use super::sync::{DueItemOut, SyncMark, SyncOverviewOut, SyncSettingsOut};

#[tauri::command]
pub async fn sync_settings_get(store: State<'_, StoreHandle>) -> Result<SyncSettingsOut, StoreError> {
    store.call(|slot| slot.get()?.sync_settings()).await
}

#[tauri::command]
pub async fn sync_enable(store: State<'_, StoreHandle>, account_id: String, account_label: String) -> Result<SyncSettingsOut, StoreError> {
    store.call(move |slot| slot.get()?.sync_enable(&account_id, &account_label)).await
}

#[tauri::command]
pub async fn sync_disable(store: State<'_, StoreHandle>) -> Result<SyncSettingsOut, StoreError> {
    store.call(|slot| slot.get()?.sync_disable()).await
}

#[tauri::command]
pub async fn sync_enqueue_after_opt_in(store: State<'_, StoreHandle>, account_id: String) -> Result<usize, StoreError> {
    store.call(move |slot| slot.get()?.sync_enqueue_after_opt_in(&account_id)).await
}

#[tauri::command]
pub async fn sync_backfill(store: State<'_, StoreHandle>, account_id: String, flight_ids: Vec<String>) -> Result<usize, StoreError> {
    store.call(move |slot| slot.get()?.sync_backfill(&account_id, &flight_ids)).await
}

#[tauri::command]
pub async fn sync_due(store: State<'_, StoreHandle>, account_id: String, now: String, limit: i64) -> Result<Vec<DueItemOut>, StoreError> {
    store.call(move |slot| slot.get()?.sync_due(&account_id, &now, limit)).await
}

#[tauri::command]
pub async fn sync_mark(store: State<'_, StoreHandle>, mark: SyncMark) -> Result<(), StoreError> {
    store.call(move |slot| slot.get()?.sync_mark(&mark)).await
}

#[tauri::command]
pub async fn sync_retry_failed(store: State<'_, StoreHandle>, account_id: String) -> Result<usize, StoreError> {
    store.call(move |slot| slot.get()?.sync_retry_failed(&account_id)).await
}

#[tauri::command]
pub async fn sync_recover_interrupted(store: State<'_, StoreHandle>) -> Result<usize, StoreError> {
    store.call(|slot| slot.get()?.sync_recover_interrupted()).await
}

#[tauri::command]
pub async fn sync_overview(store: State<'_, StoreHandle>) -> Result<SyncOverviewOut, StoreError> {
    store.call(|slot| slot.get()?.sync_overview()).await
}

#[tauri::command]
pub async fn sync_local_only_ids(store: State<'_, StoreHandle>) -> Result<Vec<String>, StoreError> {
    store.call(|slot| slot.get()?.sync_local_only_ids()).await
}

// ---------- dispatch (imported flight plans, schema v3; local only) ----------

use super::dispatch::{AssociateOutcome, SnapshotOut, StoredPlanOut};

#[tauri::command]
pub async fn dispatch_plan_get(store: State<'_, StoreHandle>) -> Result<Option<StoredPlanOut>, StoreError> {
    store.call(|slot| slot.get()?.dispatch_plan()).await
}

#[tauri::command]
pub async fn dispatch_plan_save(store: State<'_, StoreHandle>, plan: serde_json::Value, imported_at_utc: String) -> Result<(), StoreError> {
    store.call(move |slot| slot.get()?.save_dispatch_plan(&plan, &imported_at_utc)).await
}

#[tauri::command]
pub async fn dispatch_plan_clear(store: State<'_, StoreHandle>) -> Result<(), StoreError> {
    store.call(|slot| slot.get()?.clear_dispatch_plan()).await
}

#[tauri::command]
pub async fn flight_plan_associate(store: State<'_, StoreHandle>, flight_id: String, snapshot: serde_json::Value) -> Result<AssociateOutcome, StoreError> {
    store.call(move |slot| slot.get()?.associate_plan(&flight_id, &snapshot)).await
}

#[tauri::command]
pub async fn flight_plan_snapshot(store: State<'_, StoreHandle>, flight_id: String) -> Result<Option<SnapshotOut>, StoreError> {
    store.call(move |slot| slot.get()?.plan_snapshot(&flight_id)).await
}

// ---------- dispatch releases and recorded OUT/IN (schema v4; local only) ----------

use super::release::{MilestoneOut, MilestoneOutcome, ReleaseOut};

#[tauri::command]
pub async fn dispatch_release_create(store: State<'_, StoreHandle>, release: serde_json::Value) -> Result<ReleaseOut, StoreError> {
    store.call(move |slot| slot.get()?.create_release(&release)).await
}

#[tauri::command]
pub async fn dispatch_release_cancel(store: State<'_, StoreHandle>, release_id: String, cancelled_at_utc: String, reason: String) -> Result<ReleaseOut, StoreError> {
    store.call(move |slot| slot.get()?.cancel_release(&release_id, &cancelled_at_utc, &reason)).await
}

#[tauri::command]
pub async fn dispatch_release_attach(store: State<'_, StoreHandle>, release_id: String, flight_id: String, linked_at_utc: String) -> Result<ReleaseOut, StoreError> {
    store.call(move |slot| slot.get()?.attach_release(&release_id, &flight_id, &linked_at_utc)).await
}

#[tauri::command]
pub async fn dispatch_releases_list(store: State<'_, StoreHandle>, limit: Option<i64>) -> Result<Vec<ReleaseOut>, StoreError> {
    store.call(move |slot| slot.get()?.list_releases(limit.unwrap_or(100))).await
}

#[tauri::command]
pub async fn dispatch_release_for_flight(store: State<'_, StoreHandle>, flight_id: String) -> Result<Option<ReleaseOut>, StoreError> {
    store.call(move |slot| slot.get()?.release_for_flight(&flight_id)).await
}

#[tauri::command]
pub async fn flight_milestone_record(store: State<'_, StoreHandle>, flight_id: String, milestone: String, occurred_at_utc: String, clock_source: String) -> Result<MilestoneOutcome, StoreError> {
    store.call(move |slot| slot.get()?.record_milestone(&flight_id, &milestone, &occurred_at_utc, &clock_source)).await
}

#[tauri::command]
pub async fn flight_milestones(store: State<'_, StoreHandle>, flight_id: String) -> Result<Vec<MilestoneOut>, StoreError> {
    store.call(move |slot| slot.get()?.milestones(&flight_id)).await
}
