# S1-06 Windows smoke evidence (GitHub `windows-latest` runner, no MSFS)

From CI run **38308410373** (commit e5636f0), job `windows-installer`: **37/37 checks passed**.

| Category | What |
|---|---|
| **W**: Windows without MSFS | Every check in [`summary.md`](summary.md) and [`windows-smoke.json`](windows-smoke.json) |
| Not tested | Windows 10/11 desktop PC; real MSFS 2020/2024; code signing |

- **Two phases.** The UI phase (screenshots) drove a test-only exe built from the same code with one extra
  WebView2 argument, `--remote-debugging-port` (`tauri.uitest.conf.json`; never packaged). The installer phase
  used the shipped NSIS installers, with no debugging port, for install, start, upgrade and uninstall. It also
  verified that the installed app kept the flight recorded in the UI phase.
- **User agent.** `Edg/153` (WebView2 on Windows NT 10.0, x64).
- **Data.** All telemetry is mock / demo data.

| Screenshot | Shows |
|---|---|
| `01-connected.png` | Real UI rendered by WebView2, bridge connected over the named pipe |
| `02-settings.png` | Database ready (schema v2) in `%APPDATA%\dev.flightsimapp.desktop` |
| `03-flight-started.png`, `04-arrival-detected.png` | Mock flight recorded on Windows; arrival detected |
| `05-history.png`, `07-history-after-restart.png` | Completed flight in history, still there after a forced kill and restart |
| `06-msfs2024-no-simconnect.png` | MSFS 2024 adapter selected, no SimConnect.dll → `ERROR / sdk_unavailable` |

[`diagnostics-report.json`](diagnostics-report.json) is the report the app produced on Windows. It contains no
secrets, and identifiers are shortened.
