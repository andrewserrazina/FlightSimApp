# Windows installer + app smoke test (internal build; no MSFS). Runs on a clean Windows 10/11 x64
# machine or a GitHub windows runner. Usage:
#   pwsh scripts/windows-smoke.ps1 -Installer <setup-0.1.0.exe> -UpgradeInstaller <setup-0.1.1.exe> -OutDir smoke-out
# Every check is recorded in $OutDir/windows-smoke.json and summary.md; exit code 1 if any check fails.
# NOTE: deletes and recreates the app's data directory (%APPDATA%\dev.flightsimapp.desktop) — never run
# on a PC whose local flights you want to keep.
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$UpgradeInstaller,
  [string]$OutDir = "smoke-out",
  [int]$DevToolsPort = 9222
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force $OutDir | Out-Null
$root = Split-Path -Parent $PSScriptRoot
$cdp = Join-Path $root "scripts/windows-smoke-cdp.mjs"
$results = [ordered]@{}
$failed = $false
function Check([string]$name, [bool]$ok, $detail = $null) {
  $script:results[$name] = [ordered]@{ ok = $ok; detail = $detail }
  if (-not $ok) { $script:failed = $true }
  Write-Host ("[{0}] {1} {2}" -f ($(if ($ok) { "PASS" } else { "FAIL" }), $name, $detail))
}
function Cdp([string]$step) {
  $all = @(& node $cdp $step $OutDir $DevToolsPort 2>&1 | ForEach-Object { "$_" })
  $all | Set-Content (Join-Path $OutDir "cdp-$step.log")
  $json = $all | Where-Object { $_ -match '^\{"step"' } | Select-Object -Last 1
  try { $r = $json | ConvertFrom-Json } catch { $r = $null }
  if (-not $r) { $r = [pscustomobject]@{ ok = $false; error = (($all | Select-Object -Last 12) -join " | ") } }
  Check "ui.$step" ([bool]$r.ok) $(if ($r.ok) { ($r.checks | ConvertTo-Json -Compress) } else { $r.error })
  return $r
}
$dataDir = Join-Path $env:APPDATA "dev.flightsimapp.desktop"
$db = Join-Path $dataDir "flightsim.db"
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\FlightSimApp"

function InstallDir {
  $k = Get-ItemProperty $uninstallKey -ErrorAction SilentlyContinue
  if ($k -and $k.InstallLocation) { return $k.InstallLocation.Trim('"') }
  return (Join-Path $env:LOCALAPPDATA "FlightSimApp")
}
function AppExe([string]$dir) {
  Get-ChildItem $dir -Filter *.exe | Where-Object { $_.Name -notmatch 'uninstall|flightsim-sim-bridge' } | Select-Object -First 1
}
function BridgeProcs { Get-Process -Name "flightsim-sim-bridge" -ErrorAction SilentlyContinue }
function Launch([string]$exe) {
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$DevToolsPort"
  $env:FLIGHTSIM_MOCK_START_OFFSET_S = "700"   # mock flight near its end: completes in ~4 min
  $p = Start-Process -FilePath $exe -PassThru
  Start-Sleep -Seconds 8
  return $p
}
function WaitGone([scriptblock]$probe, [int]$seconds) {
  for ($i = 0; $i -lt $seconds * 2; $i++) { if (-not (& $probe)) { return $true }; Start-Sleep -Milliseconds 500 }
  return $false
}
function DbQuery([string]$sql) {
  $py = "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute(sys.argv[2]).fetchone()[0])"
  return (& python -c $py $db $sql).Trim()
}

# ---------- clean slate ----------
Get-Process -Name "flightsim-sim-bridge" -ErrorAction SilentlyContinue | Stop-Process -Force
if (Test-Path $dataDir) { Remove-Item -Recurse -Force $dataDir }
$marker = "turnline-smoke-marker.dev.flightsimapp.desktop"
cmdkey /generic:$marker /user:smoke /pass:not-a-secret | Out-Null

# ---------- 1. fresh install ----------
$p = Start-Process -FilePath $Installer -ArgumentList "/S" -Wait -PassThru
Check "install.exit_code" ($p.ExitCode -eq 0) $p.ExitCode
$dir = InstallDir
$exe = AppExe $dir
Check "install.app_exe_present" ($null -ne $exe) $(if ($exe) { $exe.FullName })
Check "install.bridge_exe_packaged" (Test-Path (Join-Path $dir "flightsim-sim-bridge.exe")) $dir
$ver0 = (Get-ItemProperty $uninstallKey -ErrorAction SilentlyContinue).DisplayVersion
Check "install.registered_version" ($ver0 -eq "0.1.0") $ver0

# ---------- 2. first start (WebView2, bridge sidecar, named pipe, SQLite) ----------
$app = Launch $exe.FullName
$r = Cdp "connected"
$children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $($app.Id)"
Check "start.bridge_child_process" (@($children | Where-Object Name -eq "flightsim-sim-bridge.exe").Count -eq 1) (($children.Name | Sort-Object -Unique) -join ",")
Check "start.webview2_processes" (@(Get-Process -Name msedgewebview2 -ErrorAction SilentlyContinue).Count -gt 0)
$pipes = [System.IO.Directory]::GetFiles("\\.\pipe\") | Where-Object { $_ -match "flightsim-[0-9a-f]{16}$" }
Check "start.named_pipe_present" (@($pipes).Count -ge 1) (@($pipes).Count)
Cdp "settings" | Out-Null
Check "data.database_created" (Test-Path $db) $db
Check "data.schema_version" ((DbQuery "PRAGMA user_version") -eq "2") (DbQuery "PRAGMA user_version")
Cdp "fly" | Out-Null
$completed = DbQuery "select count(*) from flights where status = 'completed'"
Check "data.completed_flight_persisted" ([int]$completed -ge 1) $completed
Cdp "msfs" | Out-Null

# ---------- 3. forced kill: the bridge must not outlive the app ----------
$bridgePid = ($children | Where-Object Name -eq "flightsim-sim-bridge.exe" | Select-Object -First 1).ProcessId
Stop-Process -Id $app.Id -Force
Check "lifecycle.bridge_exits_after_app_killed" (WaitGone { BridgeProcs } 20) "bridge pid was $bridgePid"

# ---------- 4. restart: data persists; graceful close stops the bridge ----------
$app = Launch $exe.FullName
Cdp "connected" | Out-Null
Cdp "history" | Out-Null
$null = $app.CloseMainWindow()
Check "lifecycle.app_exits_on_close" (WaitGone { Get-Process -Id $app.Id -ErrorAction SilentlyContinue } 20)
Check "lifecycle.bridge_exits_on_close" (WaitGone { BridgeProcs } 20)

# ---------- 5. upgrade in place ----------
$before = DbQuery "select count(*) from flights"
$p = Start-Process -FilePath $UpgradeInstaller -ArgumentList "/S" -Wait -PassThru
Check "upgrade.exit_code" ($p.ExitCode -eq 0) $p.ExitCode
$ver1 = (Get-ItemProperty $uninstallKey -ErrorAction SilentlyContinue).DisplayVersion
Check "upgrade.registered_version" ($ver1 -eq "0.1.1") $ver1
Check "upgrade.database_preserved" ((DbQuery "select count(*) from flights") -eq $before) "$before flights"
$exe = AppExe (InstallDir)
$app = Launch $exe.FullName
Cdp "connected" | Out-Null
Cdp "history" | Out-Null
$null = $app.CloseMainWindow()
WaitGone { BridgeProcs } 20 | Out-Null
Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue

# ---------- 6. uninstall ----------
$dir = InstallDir
$p = Start-Process -FilePath (Join-Path $dir "uninstall.exe") -ArgumentList "/S" -Wait -PassThru
Check "uninstall.exit_code" ($p.ExitCode -eq 0) $p.ExitCode
Check "uninstall.app_removed" (WaitGone { Test-Path (Join-Path $dir $exe.Name) } 60) $dir
Check "uninstall.registry_removed" (WaitGone { Test-Path $uninstallKey } 30)
Check "uninstall.local_flights_kept" (Test-Path $db) "default uninstall keeps %APPDATA% data"
$cred = (cmdkey /list:$marker | Out-String)
Check "uninstall.credential_manager_untouched" ($cred -match [regex]::Escape($marker))
cmdkey /delete:$marker | Out-Null

$results | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $OutDir "windows-smoke.json")
$lines = @("| Check | Result | Detail |", "|---|---|---|")
foreach ($k in $results.Keys) { $lines += "| $k | $(if ($results[$k].ok) { 'PASS' } else { '**FAIL**' }) | $($results[$k].detail -replace '\|','/') |" }
$lines -join "`n" | Set-Content (Join-Path $OutDir "summary.md")
if ($env:GITHUB_STEP_SUMMARY) { $lines -join "`n" | Add-Content $env:GITHUB_STEP_SUMMARY }
if ($failed) { Write-Host "Windows smoke: FAILED"; exit 1 }
Write-Host "Windows smoke: all checks passed"
