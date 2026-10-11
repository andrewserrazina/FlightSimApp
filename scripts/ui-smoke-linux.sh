#!/bin/bash
# Linux/Xvfb desktop smoke test: launches the real Tauri app with the mock bridge, clicks through
# every page, freezes/kills the bridge and switches adapters, and saves screenshots to $OUT.
# Prereqs: Xvfb, xdotool, ImageMagick; `pnpm --filter @flightsim/desktop build`,
# `cargo build --features tauri/custom-protocol` (apps/desktop/src-tauri) and a Release bridge build.
# Usage: xvfb-run -a -s "-screen 0 1920x1080x24" scripts/ui-smoke-linux.sh 1920 1080 hd
# Sidebar/checkbox click coordinates assume the default layout. This is NOT a Windows test.
set -u
W=$1; H=$2; P=$3; A=${4:-mock}
ROOT=$(cd "$(dirname "$0")/.." && pwd); OUT=${OUT:-$ROOT/ui-smoke-out}; mkdir -p "$OUT"
APP=$ROOT/apps/desktop/src-tauri/target/debug/flightsim-desktop
export DOTNET_ROOT=${DOTNET_ROOT:-$HOME/.dotnet} WEBKIT_DISABLE_DMABUF_RENDERER=1
export FLIGHTSIM_BRIDGE_PATH=$ROOT/services/sim-bridge/src/FlightSim.SimBridge.Host/bin/Release/net8.0/flightsim-sim-bridge
export FLIGHTSIM_BRIDGE_ADAPTER=$A
# Isolated profile so the run starts clean and never touches the developer's real app data.
export XDG_DATA_HOME=$OUT/.xdg-data XDG_CACHE_HOME=$OUT/.xdg-cache
rm -rf "$XDG_DATA_HOME" "$XDG_CACHE_HOME"
$APP > $OUT/$P-app.log 2>&1 &
APID=$!
sleep 8
WID=$(xdotool search --name '^FlightSimApp$' | head -1)
xdotool windowmove $WID 0 0 windowsize $WID $W $H
sleep 3
shot() { import -window root -crop ${W}x${H}+0+0 $OUT/$P-$1.png; }
nav() { xdotool mousemove 100 $1 click 1; sleep ${2:-1.5}; }   # sidebar item y-coordinate
bridge_pid() { pgrep -x flightsim-sim-b | head -1; }
shot 1-welcome
nav 136 2; shot 2-live
nav 180; shot 3-history
nav 224; shot 4-debrief
nav 268; shot 5-settings
# Real keyboard input: Alt+1 should return to Connection.
xdotool key alt+1; sleep 1.5; shot 5b-after-alt1
if [ "$A" = "mock" ] && [ "$P" = "hd" ]; then
  nav 136 1
  BP=$(bridge_pid); kill -STOP $BP; sleep 6; shot 6-live-stale-frozen-bridge   # bridge frozen: UI must detect staleness locally
  kill -CONT $BP; sleep 3; shot 7-live-recovered
  # Turn mock mode off in Settings (click the checkbox): shell restarts the bridge with msfs2024.
  nav 268 1; xdotool mousemove 274 198 click 1; sleep 6; shot 8-settings-after-switch
  nav 92; shot 9-welcome-msfs2024-no-sdk
  # Turn mock mode back on from the Welcome page checkbox, then kill the bridge: shell must restart it.
  xdotool mousemove 274 716 click 1; sleep 6; shot 10-welcome-back-to-mock
  pkill -9 -x flightsim-sim-b; sleep 0.8; shot 11-welcome-bridge-killed
  sleep 6; shot 12-welcome-bridge-restarted
fi
kill $APID
for i in $(seq 1 25); do [ -z "$(bridge_pid)" ] && break; sleep 0.2; done
[ -n "$(bridge_pid)" ] && echo "ORPHAN BRIDGE after 5 s" || echo "no orphan bridge (bridge exited within $((i*200)) ms of app exit)"
