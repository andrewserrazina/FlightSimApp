# Assemble the internal simulator-tester kit (unsigned, internal alpha testing only):
#   pwsh scripts/make-tester-kit.ps1 -Installer <FlightSimApp_0.1.0_x64-setup.exe> -OutDir tester-kit
# Prerequisite: `pnpm -r --filter "./packages/**" build` (the recording tools are taken from
# packages/flight-core/dist). The kit NEVER contains SimConnect.dll: testers copy it from their
# own MSFS SDK installation (see docs/release/tester-build.md).
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [string]$OutDir = "tester-kit"
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
if (Test-Path $OutDir) { Remove-Item -Recurse -Force $OutDir }
New-Item -ItemType Directory -Force "$OutDir/tools/flight-core/bin", "$OutDir/recordings" | Out-Null

Copy-Item $Installer $OutDir
$core = Join-Path $root "packages/flight-core"
Copy-Item -Recurse (Join-Path $core "dist") "$OutDir/tools/flight-core/dist"
Copy-Item (Join-Path $core "bin/*.mjs") "$OutDir/tools/flight-core/bin/"
'{ "name": "turnline-recording-tools", "private": true, "type": "module" }' | Set-Content -Encoding utf8 "$OutDir/tools/flight-core/package.json"
Copy-Item (Join-Path $root "fixtures/recordings/simulated/*.jsonl.gz") "$OutDir/recordings/"
foreach ($doc in @("docs/release/tester-build.md", "docs/testing/physical-pc-checklist.md", "docs/testing/msfs2020-test-plan.md",
                   "docs/testing/msfs2024-test-plan.md", "docs/testing/recording-and-replay.md",
                   "docs/testing/gsx-probe-msfs2020.md", "docs/testing/s2-05-gsx-turnaround-acceptance.md")) {
  Copy-Item (Join-Path $root $doc) $OutDir
}
if (Get-ChildItem -Recurse $OutDir -Filter "SimConnect*.dll") { throw "SimConnect.dll must never be bundled" }

$commit = (git -C $root rev-parse HEAD).Trim()
@(
  "Turnline (FlightSimApp) internal simulator-tester kit - UNSIGNED, internal alpha testing only"
  "commit: $commit"
  "ci_run: $($env:GITHUB_RUN_ID)"
  "built_at: $((Get-Date).ToUniversalTime().ToString('o'))"
  "SimConnect.dll: NOT included (copy from your own MSFS SDK; see tester-build.md)"
) | Set-Content -Encoding utf8 "$OutDir/BUILD-INFO.txt"
Get-ChildItem -Recurse -File $OutDir | Where-Object Name -ne "SHA256SUMS.txt" | ForEach-Object {
  "{0}  {1}" -f (Get-FileHash -Algorithm SHA256 $_.FullName).Hash.ToLower(), [IO.Path]::GetRelativePath((Resolve-Path $OutDir), $_.FullName).Replace('\', '/')
} | Set-Content -Encoding utf8 "$OutDir/SHA256SUMS.txt"

# Self-check: the bundled tools run from the kit layout on the reference (simulated) recording.
$ref = Get-ChildItem "$OutDir/recordings/*.jsonl.gz" | Select-Object -First 1
& node "$OutDir/tools/flight-core/bin/acceptance.mjs" $ref.FullName --scenario nominal --md "$OutDir/recordings/reference-report.md" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "acceptance tool self-check failed on $($ref.Name)" }
if (-not (Select-String -Path "$OutDir/recordings/reference-report.md" -Pattern "SIMULATED" -Quiet)) { throw "reference recording not labelled simulated" }
Write-Host "tester kit ready in $OutDir (commit $commit)"
