#!/bin/bash
# S1-04 end-to-end smoke (Linux/Xvfb, ~17 min real time): starts a mock flight, closes the app in
# cruise, reopens it with the mock "still flying" (FLIGHTSIM_MOCK_START_OFFSET_S), resumes the same
# flight, waits for landing + parking, confirms completion, then reopens to check persistence.
# Uses an isolated data dir and XDG profile under $OUT. Not a Windows test.
# Usage: xvfb-run -a -s "-screen 0 1920x2200x24" scripts/lifecycle-smoke-linux.sh
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd); OUT=${OUT:-$ROOT/ui-smoke-out/lifecycle}; mkdir -p "$OUT"

APP=$ROOT/apps/desktop/src-tauri/target/debug/flightsim-desktop
export DOTNET_ROOT=${DOTNET_ROOT:-$HOME/.dotnet} WEBKIT_DISABLE_DMABUF_RENDERER=1
export FLIGHTSIM_BRIDGE_PATH=$ROOT/services/sim-bridge/src/FlightSim.SimBridge.Host/bin/Release/net8.0/flightsim-sim-bridge
export FLIGHTSIM_BRIDGE_ADAPTER=mock
export FLIGHTSIM_DATA_DIR=$OUT/data XDG_DATA_HOME=$OUT/xdg-data XDG_CACHE_HOME=$OUT/xdg-cache
rm -rf $OUT/data $OUT/xdg-data $OUT/xdg-cache $OUT/*.png $OUT/*.log
W=1920; H=1080
log() { echo "$(date -u +%H:%M:%S) $*" | tee -a $OUT/steps.log; }
shot() { import -window root -crop ${W}x${H}+0+0 $OUT/$1.png; log "shot $1"; }
tall() { xdotool windowsize $WID $W 2100; sleep 2; import -window root -crop ${W}x2100+0+0 $OUT/$1.png; xdotool windowsize $WID $W $H; sleep 1; log "tall shot $1"; }
nav() { xdotool mousemove 100 $1 click 1; sleep ${2:-1.5}; }     # sidebar: 92 conn,136 live,180 hist,224 debrief,268 settings
key() { xdotool mousemove 900 600; xdotool key "$@"; sleep 1; }
launch() { $APP >> $OUT/app.log 2>&1 & APID=$!; LAUNCHED=$(date +%s); sleep 8; WID=$(xdotool search --name '^FlightSimApp$' | head -1); xdotool windowmove $WID 0 0 windowsize $WID $W $H; sleep 2; log "launched pid=$APID offset=${FLIGHTSIM_MOCK_START_OFFSET_S:-0}"; }
since() { echo $(( $(date +%s) - LAUNCHED )); }

# ---------- Session 1: start flight, fly to cruise, then close the app mid-flight ----------
launch
nav 136; shot 01-live-before-start
key Tab Return; sleep 2; log "start flight requested at t=$(since)"
nav 136; shot 02-live-flight-started
for t in 120 240 360; do while [ $(since) -lt $t ]; do sleep 2; done; nav 136 1; shot 03-live-t$t; done
while [ $(since) -lt 430 ]; do sleep 2; done
CLOSE_T=$(since); log "closing app mid-flight at t=$CLOSE_T"
kill $APID; sleep 25

# ---------- Session 2: reopen (sim kept flying), resume, fly to arrival, confirm completion ----------
export FLIGHTSIM_MOCK_START_OFFSET_S=$(( CLOSE_T + 25 + 2 ))
launch
nav 92; shot 04-recovery-banner
# Focus moves to the page <h1> only when the page changes, so go via another page first.
nav 268 1; nav 136; key Tab Return; sleep 3; log "resume requested (banner Resume button)"
shot 05-live-after-resume
for t in 120 240 360; do while [ $(since) -lt $t ]; do sleep 2; done; nav 136 1; shot 06-live-s2-t$t; done
while [ $(since) -lt 475 ]; do sleep 2; done
nav 180 1; nav 136; shot 07-live-arrival-detected
key Tab Return; sleep 3; log "confirm completion requested"
nav 136; shot 08-live-completed
nav 180 2; tall 09-history
nav 136; key Tab Return; sleep 3; log "view debrief"
tall 10-debrief
nav 268; shot 11-settings
kill $APID; sleep 3

# ---------- Session 3: reopen; history must persist, no recovery prompt ----------
unset FLIGHTSIM_MOCK_START_OFFSET_S
launch
nav 92; shot 12-session3-welcome-no-recovery
nav 180 2; shot 13-session3-history-persisted
kill $APID; sleep 3
for i in $(seq 1 25); do [ -z "$(pgrep -x flightsim-sim-b)" ] && break; sleep 0.2; done
[ -n "$(pgrep -x flightsim-sim-b)" ] && log "ORPHAN BRIDGE" || log "no orphan bridge"
log "done"
