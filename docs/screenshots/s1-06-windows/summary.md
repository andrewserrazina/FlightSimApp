| Check | Result | Detail |
|---|---|---|
| uitest.exe_present | PASS | D:\a\FlightSimApp\FlightSimApp\uitest\flightsim-desktop.exe |
| uitest.bridge_next_to_exe | PASS |  |
| ui.connected | PASS | {"webview2_rendered":true,"bridge_connected_over_named_pipe":true,"user_agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0"} |
| start.bridge_child_process | PASS | flightsim-sim-bridge.exe,msedgewebview2.exe |
| start.webview2_processes | PASS |  |
| start.named_pipe_present | PASS | 1 |
| ui.settings | PASS | {"database_ready_schema_v2":true,"database_in_appdata":true,"diagnostics_parse":true,"diagnostics_adapter":"mock","diagnostics_simconnect_sdk":"not_applicable","diagnostics_no_secrets":true} |
| data.database_created | PASS | C:\Users\runneradmin\AppData\Roaming\dev.flightsimapp.desktop\flightsim.db |
| data.schema_version | PASS | 2 |
| ui.fly | PASS | {"flight_started":true,"flight_completed_and_listed":true} |
| data.completed_flight_persisted | PASS | 1 |
| ui.msfs | PASS | {"msfs_adapter_selected":true,"reports_sdk_unavailable":true,"switched_back_to_mock":true} |
| lifecycle.bridge_exits_after_app_killed | PASS | bridge pid was 3408 |
| ui.history | PASS | {"completed_flights_listed":1} |
| lifecycle.app_exits_on_close | PASS |  |
| lifecycle.bridge_exits_on_close | PASS |  |
| install.exit_code | PASS | 0 |
| install.app_exe_present | PASS | C:\Users\runneradmin\AppData\Local\FlightSimApp\flightsim-desktop.exe |
| install.bridge_exe_packaged | PASS | C:\Users\runneradmin\AppData\Local\FlightSimApp |
| install.registered_version | PASS | 0.1.0 |
| installed.app_running | PASS |  |
| installed.bridge_child_process | PASS | flightsim-sim-bridge.exe,msedgewebview2.exe |
| installed.webview2_processes | PASS |  |
| installed.keeps_existing_flights | PASS | 1 completed |
| installed.bridge_exits_on_close | PASS |  |
| upgrade.exit_code | PASS | 0 |
| upgrade.registered_version | PASS | 0.1.1 |
| upgrade.database_preserved | PASS | 1 completed |
| upgrade.app_starts | PASS |  |
| upgrade.schema_version | PASS |  |
| uninstall.exit_code | PASS | 0 |
| uninstall.app_removed | PASS | C:\Users\runneradmin\AppData\Local\FlightSimApp |
| uninstall.registry_removed | PASS |  |
| uninstall.local_flights_kept | PASS | default uninstall keeps %APPDATA% data |
| uninstall.credential_manager_untouched | PASS |  |
