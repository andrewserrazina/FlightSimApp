# Tester build: internal, unsigned, simulator-connected (S1-07)

This build is for **private alpha testers with their own Windows PC and their own MSFS licence**. It is
unsigned, it is not a public release, and it makes **no claim of MSFS compatibility**. Its purpose is to
collect that evidence.

## 1. Where the build comes from

| Item | Location |
|---|---|
| **Tester kit**: installer, recording tools, test plans, checksums | GitHub Actions workflow **CI**, branch `claude/new-session-2b3s69`, job `windows-installer`, artifact **`turnline-tester-kit`** (kept 30 days). Use the run for the commit you were told to test. |
| Installer alone, plus the smoke evidence | Same run, artifact `windows-installer-and-smoke` → `installers/FlightSimApp_0.1.0_x64-setup.exe` |
| Standalone sidecar, plus CI probe files | Same run, artifact `windows-sidecar` |

### What the kit contains

```
FlightSimApp_0.1.0_x64-setup.exe     NSIS installer (per-user, unsigned)
tools/flight-core/                   replay.mjs, acceptance.mjs, sanitize.mjs (+ dist/), needs Node 22
recordings/mock-nominal-markers.jsonl.gz   SIMULATED reference recording + reference-report.md
tester-build.md, physical-pc-checklist.md, msfs2020-test-plan.md, msfs2024-test-plan.md, recording-and-replay.md
BUILD-INFO.txt                       commit, CI run id, build time
SHA256SUMS.txt                       SHA-256 of every file in the kit
```

Verify the download before installing:

```powershell
Get-Content SHA256SUMS.txt | ForEach-Object {
  $h, $f = $_ -split '  ', 2
  if ((Get-FileHash -Algorithm SHA256 $f).Hash.ToLower() -ne $h) { "MISMATCH $f" }
}
```

No output means every file matches.

### Reproducing the build

The kit is built from a clean checkout by CI:
- pinned toolchains: .NET 8, Node 22, stable Rust
- `pnpm install --frozen-lockfile`
- a self-contained single-file sidecar (`scripts/build-sidecar.ps1`)

To reproduce it locally on Windows:

```powershell
pnpm install --frozen-lockfile; pnpm -r --filter "./packages/**" build
pwsh scripts/build-sidecar.ps1
pnpm --filter @flightsim/desktop tauri build --config src-tauri/tauri.bundle.conf.json
pwsh scripts/make-tester-kit.ps1 -Installer (Get-ChildItem apps/desktop/src-tauri/target/release/bundle/nsis/*_0.1.0_x64-setup.exe).FullName -OutDir tester-kit
```

The build is not bit-for-bit reproducible. Installers and executables carry timestamps, and the build is
unsigned. Identify a build by `BUILD-INFO.txt` and the checksums.

## 2. Prerequisites on the test PC

| Requirement | Notes |
|---|---|
| Windows 10 22H2 or Windows 11, x64 | Record the edition and build (`winver`) |
| WebView2 runtime | Preinstalled on Windows 11 and current Windows 10. The installer downloads it if missing. |
| MSFS 2020 and/or MSFS 2024 | Your own licence. Store or Steam edition. Record which. |
| **MSFS SDK** for the simulator you test | Needed only for `SimConnect.dll` (see §3). Install it through the simulator's Developer Mode (*Help → SDK Installer*) or from the official SDK download linked there. |
| Node.js 22 LTS | To run replay and acceptance. Not needed by the app itself. |
| About 200 MB of free disk | The app and its recordings |
| Optional: a second monitor | Lets you type markers while flying |

The .NET runtime is **not** required: the sidecar is self-contained.

## 3. SimConnect.dll: how to obtain it legally

The bridge talks to MSFS through Microsoft's native `SimConnect.dll`.
- **We do not ship it.** Its redistribution rights have not been confirmed, so the installer, the tester kit and
  this repository must never contain it. `make-tester-kit.ps1` fails the build if it finds one.
- **Each tester uses the copy from their own SDK installation**, under the SDK licence they accepted when they
  installed it.
- Do not send the DLL to other people, attach it to bug reports, or commit it.

The file sits in the SDK install folder, typically:

```
<SDK root>\SimConnect SDK\lib\SimConnect.dll
```

Common SDK roots are `C:\MSFS SDK` (2020) and `C:\MSFS 2024 SDK` (2024). Use the path you chose when you
installed it.

Two supported ways to make it available. Pick one:

**Option A: an environment variable (recommended; nothing is copied).** Set it for your user, then restart the
app:

```powershell
[Environment]::SetEnvironmentVariable("FLIGHTSIM_SIMCONNECT_DLL", "C:\MSFS 2024 SDK\SimConnect SDK\lib\SimConnect.dll", "User")
```

**Option B: next to the bridge.** Copy it into the install folder. An app update or uninstall may remove it;
copy it again if so.

```powershell
Copy-Item "C:\MSFS 2024 SDK\SimConnect SDK\lib\SimConnect.dll" "$env:LOCALAPPDATA\FlightSimApp\"
```

The lookup order is `FLIGHTSIM_SIMCONNECT_DLL` first, then the folder of `flightsim-sim-bridge.exe`.

**Check:** Settings → *Bridge information* → *SimConnect SDK* shows **SimConnect.dll loaded, not
runtime-verified** instead of *SimConnect.dll not found*. That wording is expected. It means the DLL loaded, but
this build has not yet been validated against a real simulator.

Test both simulators with the DLL from the SDK that matches the simulator (2020 SDK for MSFS 2020, 2024 SDK for
MSFS 2024). The plans include one cross-check with the other DLL, recorded separately. It is not a supported
configuration.

## 4. Install

1. Run `FlightSimApp_0.1.0_x64-setup.exe`. SmartScreen will warn, because the build is unsigned: choose
   *More info* → *Run anyway*.
2. The app installs per user to `%LOCALAPPDATA%\FlightSimApp\` and needs no administrator rights.
3. Start **FlightSimApp** from the Start menu. The first screen shows **DEMO DATA**, because mock mode is the
   default.

## 5. Where everything is written (logs and data)

| What | Path |
|---|---|
| Local database (the source of truth for flights) | `%APPDATA%\dev.flightsimapp.desktop\flightsim.db` |
| **Bridge log**: SimConnect connection, simulator state, rejected SimVars, errors | `%APPDATA%\dev.flightsimapp.desktop\logs\bridge.log`. The previous run's log is `bridge.1.log`. Capped at 20 MB per run. |
| App executable and bridge | `%LOCALAPPDATA%\FlightSimApp\flightsim-desktop.exe`, `flightsim-sim-bridge.exe` |
| WebView2 profile | `%LOCALAPPDATA%\dev.flightsimapp.desktop\EBWebView\` |
| Probe recordings | wherever `--probe-out` points (the plans use the Desktop) |
| Diagnostic report | Settings → *Diagnostic report* → *Copy report*. It contains no tokens, e-mail addresses or full IDs. |
| Cloud session (only if you sign in) | Windows Credential Manager → *Windows Credentials* → `supabase-auth-session…dev.flightsimapp.desktop` |

The bridge log lines carry UTC timestamps. Lines worth searching for:
- `starting: adapter=`
- `MSFS reports no flight in progress`
- `MSFS pause state`
- `MSFS aircraft loaded`
- `rejected SimVar`
- `Dropped SimConnect telemetry block`
- `did not report its simulation state`

## 6. Exact commands

```powershell
$bridge = "$env:LOCALAPPDATA\FlightSimApp\flightsim-sim-bridge.exe"
$out = "$env:USERPROFILE\Desktop"

# Is SimConnect.dll found? (5 s probe; the header line shows simconnect_dll_loaded and simconnect_sdk)
& $bridge --adapter msfs2024 --probe 5 --probe-out "$out\dll-check.jsonl"; Get-Content "$out\dll-check.jsonl" -First 1

# Record a flight (close the desktop app first; type markers while flying; Ctrl+C once to stop)
& $bridge --adapter msfs2024 --probe 7200 --probe-out "$out\msfs2024-a320neo-nominal.jsonl"

# Replay and evaluate (from the unpacked tester kit folder)
node tools\flight-core\bin\replay.mjs "$out\msfs2024-a320neo-nominal.jsonl"
node tools\flight-core\bin\acceptance.mjs "$out\msfs2024-a320neo-nominal.jsonl" --scenario nominal --md "$out\msfs2024-a320neo-nominal.report.md"

# Sanitise before sending
node tools\flight-core\bin\sanitize.mjs "$out\msfs2024-a320neo-nominal.jsonl" "$out\msfs2024-a320neo-nominal.jsonl.gz"
```

For MSFS 2020, replace `msfs2024` with `msfs2020` everywhere.

GSX (S2-05, read-only diagnostics; full steps in [gsx-probe-msfs2020.md](../testing/gsx-probe-msfs2020.md)):

```powershell
# GSX service-state probe: a separate SimConnect client; can run alongside the desktop app; Ctrl+C once to stop
& $bridge --adapter msfs2020 --gsx-probe 7200 --gsx-probe-out "$out\gsx-probe-msfs2020.jsonl"

# GSX receipts folder: groups, counts and dates only (nothing is opened or copied)
& $bridge --gsx-receipts
```

GSX turnaround and expense ledger in the desktop app (S2-05 slice): follow
[s2-05-gsx-turnaround-acceptance.md](../testing/s2-05-gsx-turnaround-acceptance.md). It needs no command line.

## 7. What to send back

For every test session, send:
1. The filled-in [physical-pc-checklist.md](../testing/physical-pc-checklist.md).
2. The sanitised recordings (`.jsonl.gz`) and their `.report.md` files.
3. `bridge.log` and `bridge.1.log`, plus the diagnostic report.
4. Windows edition and build, MSFS edition and version, SDK version, aircraft, and `BUILD-INFO.txt`.

Never send `SimConnect.dll`, Credential Manager contents, or `flightsim.db` unless asked. The database contains
your flights.
