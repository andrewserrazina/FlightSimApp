mod bridge;
mod secure;
mod store;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            use tauri::Manager;
            let path = store::commands::database_path(app.handle());
            app.manage(store::actor::StoreHandle::spawn(path));
            bridge::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![bridge::bridge_command, bridge::bridge_snapshot, bridge::bridge_select_adapter,
            store::commands::store_status,
            store::commands::store_reset_damaged,
            store::commands::flight_open,
            store::commands::flight_commit,
            store::commands::flights_list,
            store::commands::flight_detail,
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
            secure::secure_session_get,
            secure::secure_session_set,
            secure::secure_session_delete,
            secure::secure_storage_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running FlightSimApp");
}
