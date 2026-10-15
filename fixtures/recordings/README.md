# Telemetry recordings

Probe recordings (`flightsim-sim-bridge --probe`) used as acceptance evidence and regression input. How to
record, sanitise and evaluate them: [docs/testing/recording-and-replay.md](../../docs/testing/recording-and-replay.md).

| Folder | Contents | Evidence class |
|---|---|---|
| `simulated/` | Recordings of the bridge's **mock** adapter (demo flight). They exercise the tooling end to end. | **SIMULATED**: verifies nothing about MSFS |
| `real/msfs2020/`, `real/msfs2024/` | Sanitised recordings from a physical Windows PC running MSFS | real simulator (only if the acceptance report says so) |

**Status (S1-07): `real/` is empty.** No real-simulator recording exists yet.

## Rules for adding a real recording

1. Sanitise it: `node packages/flight-core/bin/sanitize.mjs in.jsonl out.jsonl.gz`. The tool refuses to write
   the file if anything sensitive-looking remains.
2. Name it `<simulator>-<aircraft>-<scenario>-<yyyymmdd>.jsonl.gz`, for example
   `msfs2024-a320neo-nominal-20261020.jsonl.gz`.
3. Add the acceptance report next to it, `<same name>.report.md`, generated with `acceptance.mjs --md`.
4. In the commit message, record:
   - the Windows version and build
   - the MSFS version (store or Steam)
   - the SDK version the `SimConnect.dll` came from
   - the aircraft
   - the app commit
5. Never commit `SimConnect.dll` or anything else from the MSFS SDK.
6. Keep files below about 5 MB compressed. Trim long cruise segments if needed, and note the trim in the report.

## simulated/mock-nominal-markers.jsonl.gz

A full 15-minute demo flight from the bridge's mock adapter, recorded with the real probe binary. Markers and
cockpit checks were typed at known profile times. The tools' tests use it, and the tester kit runs it as a
self-check (`acceptance.mjs --scenario nominal` must pass and report **SIMULATED**).
