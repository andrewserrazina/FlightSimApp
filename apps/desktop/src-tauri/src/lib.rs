mod bridge;
mod bridge_log;
mod receipts;
mod secure;
mod simunet_sender;
mod store;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            use tauri::Manager;
            let path = store::commands::database_path(app.handle());
            let log_dir = path.parent().map(|d| d.join("logs"));
            app.manage(store::actor::StoreHandle::spawn(path));
            app.manage(simunet_sender::SenderState::default());
            bridge::start(app.handle().clone(), log_dir.and_then(|d| bridge_log::prepare(&d)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![bridge::bridge_command, bridge::bridge_snapshot, bridge::bridge_select_adapter,
            store::commands::store_status,
            store::commands::store_reset_damaged,
            store::commands::flight_open,
            store::commands::flight_commit,
            store::commands::flights_list,
            store::commands::flight_detail,
            store::commands::flight_track,
            store::commands::flights_prune,
            store::commands::sync_settings_get,
            store::commands::sync_enable,
            store::commands::sync_disable,
            store::commands::sync_enqueue_after_opt_in,
            store::commands::sync_backfill,
            store::commands::sync_due,
            store::commands::sync_mark,
            store::commands::sync_retry_failed,
            store::commands::sync_recover_interrupted,
            store::commands::sync_overview,
            store::commands::sync_local_only_ids,
            store::commands::dispatch_plan_get,
            store::commands::dispatch_plan_save,
            store::commands::dispatch_plan_clear,
            store::commands::flight_plan_associate,
            store::commands::flight_plan_snapshot,
            store::commands::dispatch_release_create,
            store::commands::dispatch_release_cancel,
            store::commands::dispatch_release_attach,
            store::commands::dispatch_releases_list,
            store::commands::dispatch_release_for_flight,
            store::commands::flight_milestone_record,
            store::commands::flight_milestones,
            store::commands::turnaround_open,
            store::commands::turnaround_current,
            store::commands::turnaround_get,
            store::commands::turnarounds_for_flight,
            store::commands::turnarounds_recent,
            store::commands::turnaround_record_gsx,
            store::commands::turnaround_record_feed,
            store::commands::turnaround_record_manual,
            store::commands::turnaround_set_status,
            store::commands::turnaround_mark_restarted,
            store::commands::turnaround_link_flight,
            store::commands::receipts_scan,
            store::commands::receipts_list,
            store::commands::receipt_confirm_currency,
            store::commands::receipt_associate,
            store::commands::receipt_dismiss,
            store::commands::expense_create_from_receipt,
            store::commands::expense_create_manual,
            store::commands::expense_void,
            store::commands::expense_associate,
            store::commands::expenses_list,
            secure::secure_session_get,
            secure::secure_session_set,
            secure::secure_session_delete,
            secure::secure_storage_status,
            secure::simunet_credential_status,
            secure::simunet_credential_save,
            secure::simunet_credential_set_consent,
            secure::simunet_credential_disconnect,
            simunet_sender::simunet_telemetry_send
        ])
        .run(tauri::generate_context!())
        .expect("error while running FlightSimApp");
}
