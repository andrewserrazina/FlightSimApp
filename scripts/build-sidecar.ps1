# Publishes the sim bridge as a self-contained single-file exe where Tauri's externalBin expects it.
# Usage: pwsh scripts/build-sidecar.ps1 [-SimConnectSdkDir "C:\MSFS 2024 SDK\SimConnect SDK"]
param([string]$SimConnectSdkDir = "")
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root "apps/desktop/src-tauri/binaries"
$tmp = Join-Path $root "services/sim-bridge/artifacts/publish"
$publishArgs = @("publish", "$root/services/sim-bridge/src/FlightSim.SimBridge.Host", "-c", "Release", "-r", "win-x64",
  "--self-contained", "true", "-p:PublishSingleFile=true", "-o", $tmp)
if ($SimConnectSdkDir) { $publishArgs += "-p:SimConnectSdkDir=$SimConnectSdkDir" }
dotnet @publishArgs
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed ($LASTEXITCODE)" }
New-Item -ItemType Directory -Force $out | Out-Null
Copy-Item "$tmp/flightsim-sim-bridge.exe" "$out/flightsim-sim-bridge-x86_64-pc-windows-msvc.exe" -Force
if (Test-Path "$tmp/SimConnect.dll") { Copy-Item "$tmp/SimConnect.dll" $out -Force }
Write-Host "Sidecar written to $out"
