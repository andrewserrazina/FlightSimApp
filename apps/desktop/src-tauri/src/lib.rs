mod bridge;
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
            store::commands::flights_prune
        ])
        .run(tauri::generate_context!())
        .expect("error while running FlightSimApp");
}
