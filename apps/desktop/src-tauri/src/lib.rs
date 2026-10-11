mod bridge;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            bridge::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![bridge::bridge_command, bridge::bridge_snapshot])
        .run(tauri::generate_context!())
        .expect("error while running FlightSimApp");
}
