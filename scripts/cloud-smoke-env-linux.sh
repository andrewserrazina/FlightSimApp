#!/bin/bash
# S1-05 desktop cloud smoke helpers (Linux/Xvfb). `source` this, then drive the app step by step
# (see docs/screenshots/s1-05/README.md for the sequence that was run). Not a Windows test.
# Prereqs: infra/supabase-local/up.sh running; frontend built with the local VITE_SUPABASE_* values;
# `TAURI_CONFIG="$(cat tauri.local-supabase.conf.json)" cargo build --features tauri/custom-protocol`;
# Xvfb on $DISPLAY; a holder process keeping the named keyring alive:
#   KEYRING_NAME=flightsim-smoke scripts/linux-session-keyring.py sleep 7200 &
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd); OUT=${OUT:-$ROOT/ui-smoke-out/cloud}; mkdir -p "$OUT"
export DISPLAY=${DISPLAY:-:77} KEYRING_NAME=${KEYRING_NAME:-flightsim-smoke}
export DOTNET_ROOT=${DOTNET_ROOT:-$HOME/.dotnet} WEBKIT_DISABLE_DMABUF_RENDERER=1
export FLIGHTSIM_BRIDGE_PATH=$ROOT/services/sim-bridge/src/FlightSim.SimBridge.Host/bin/Release/net8.0/flightsim-sim-bridge
export FLIGHTSIM_BRIDGE_ADAPTER=mock
export FLIGHTSIM_DATA_DIR=$OUT/data XDG_DATA_HOME=$OUT/xdg-data XDG_CACHE_HOME=$OUT/xdg-cache
APP=$ROOT/apps/desktop/src-tauri/target/debug/flightsim-desktop
W=1920; H=1080
log() { echo "$(date -u +%H:%M:%S) $*" | tee -a "$OUT/steps.log"; }
shot() { import -window root -crop ${W}x${H}+0+0 "$OUT/$1.png"; log "shot $1"; }
wid() { xdotool search --name '^FlightSimApp$' | head -1; }
nav() { xdotool mousemove 100 "$1" click 1; sleep "${2:-1.5}"; }   # sidebar: 136 live, 180 history, 268 settings
launch() { ("$ROOT/scripts/linux-session-keyring.py" "$APP" >> "$OUT/app.log" 2>&1 &); sleep 8; xdotool windowmove "$(wid)" 0 0 windowsize "$(wid)" $W $H; sleep 2; log "launched offset=${FLIGHTSIM_MOCK_START_OFFSET_S:-0}"; }
gateway_down() { for p in $(pgrep -x node); do grep -q gateway.mjs "/proc/$p/cmdline" && kill "$p"; done; log "gateway stopped (cloud outage)"; }
gateway_up() { (cd "$ROOT/infra/supabase-local" && nohup node gateway.mjs > gateway.log 2>&1 &); log "gateway started"; }
