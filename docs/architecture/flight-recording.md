# Flight lifecycle & local recording (S1-04)

## Components

```
 sim-bridge (.NET)  ──NDJSON over named pipe──▶  Tauri shell (Rust)  ──events──▶  webview (React)
                                                     │  ▲                         │
                                                     │  │ flight_commit,          ├─ bridge reducer (UI state)
                                                     │  │ flights_list, …         └─ FlightRecorder ──▶ lifecycle engine (pure, flight-core)
                                                     ▼  │                                   │
                                     flight-store thread (rusqlite) ◀──── batched commits ──┘
                                                     │
                                         <app data dir>/flightsim.db (SQLite, WAL)
```

- **Lifecycle engine**: `packages/flight-core/src/engine.ts`. It is a pure reducer: no clock, I/O or randomness, and every time comes from the inputs. It is fully unit-tested.
- **Recorder**: `apps/desktop/src/recording/FlightRecorder.ts`.
  - It validates each bridge message itself, maps frames to engine samples, applies manual commands, and queues events, interruptions and samples.
  - It flushes them asynchronously in batches.
- **Store**: `apps/desktop/src-tauri/src/store/`.
  - A single dedicated thread owns the SQLite connection.
  - It exposes a fixed command API with no SQL from the webview, and validates every payload.
  - There is no network listener.
- **Location**: the Tauri app-data directory. On Windows that is `%APPDATA%\dev.flightsimapp.desktop\flightsim.db`. `FLIGHTSIM_DATA_DIR` overrides it, for tests and development.

## Lifecycle state diagram

```
                    start (pilot)
   [idle] ─────────────────────────▶ NOT_STARTED ──first valid sample──▶ initial phase
                                                                           (on ground: PREPARING / TAXI_OUT / TAKEOFF,
                                                                            airborne:  CLIMB / CRUISE / DESCENT  ← "started airborne")

   PREPARING ──gs≥5kt 5s──▶ TAXI_OUT ──gs≥40kt 2s──▶ TAKEOFF ──airborne 3s──▶ CLIMB
       └──────────gs≥40kt 2s (runway start)──────────▲   │ gs<30kt 5s (rejected) ─▶ TAXI_OUT
   CLIMB ──|vs|<300 60s──▶ CRUISE ──vs≤-500 20s──▶ DESCENT ──RA<3000ft 10s──▶ APPROACH
   CLIMB/CRUISE ◀──vs≥500 30s── CRUISE/DESCENT        APPROACH ──vs≥500 15s (go-around)──▶ CLIMB
   any airborne phase ──on ground 2s──▶ LANDING ──gs<40kt 5s──▶ TAXI_IN ──airborne 3s (touch-and-go)──▶ CLIMB
   TAXI_IN + stopped (<1kt) with engines off or parking brake 10s ──▶ arrival detected (enables "Confirm completion")

   active ──telemetry lost ≥30s (bridge/sim/stale)──▶ INTERRUPTED ──consistent telemetry returns──▶ previous phase (auto)
                                                          │  inconsistent (aircraft changed / implausible jump) → pilot decision
   app restarted with an open flight ─────────────────▶ INTERRUPTED (needs pilot decision: Resume / End / Discard)
   INTERRUPTED ──Resume (pilot)──▶ previous phase, re-checked against the next valid sample
   active/INTERRUPTED ──End (pilot)──▶ COMPLETED (needs landing evidence or explicit confirmation) | aborted
   active ──Confirm completion (pilot, after arrival)──▶ COMPLETED
   INTERRUPTED ──Discard (pilot)──▶ discarded
```

- **Thresholds** are configurable (`LifecycleConfig`). Durations are measured in telemetry time.
- **Hysteresis**: entering and leaving a phase use different thresholds. For example, climbing needs V/S ≥ +500 fpm, while levelling off needs |V/S| < 300 fpm. Likewise a takeoff roll needs ≥ 40 kt, while a rejected takeoff is < 30 kt.
- **Insufficient evidence**: a sample without on-ground and ground speed never changes the phase, and it resets the debounce. APPROACH needs radio altitude. Without it, a descent goes straight to LANDING at touchdown.
- **Disconnection is never completion**: losing telemetry can only interrupt a flight. Short gaps (≥ 5 s, under 30 s) are logged as `telemetry.gap` events.
- **Provenance**: every event records its source: `detected`, `user` or `system`. Detections also store `condition_since`, the time the condition first held.
- **Completion kinds**:
  - `arrival_confirmed`: parked after landing, then confirmed by the pilot.
  - `landing_confirmed`: landed, then ended by the pilot.
  - `user_confirmed_without_evidence`: requires ticking an explicit checkbox.
  - Ending without landing evidence otherwise saves the flight as `aborted` (shown as "Ended (incomplete)").

## Restart & recovery

1. Every flush writes the flight row: status, phase, `last_seen_at_utc` and an engine snapshot (`engine_state` JSON). A batch commits in one transaction.
2. On startup the recorder loads the single open flight (`open_slot = 1`). It applies `app-restarted`, which interrupts the flight:
   - The interruption starts at the last recorded telemetry (`last_seen_at_utc`).
   - Its cause is `app_closed`.
   - It needs a pilot decision.
3. A banner offers **Resume** or **Discard**. Live Flight also offers **End**.
4. **Resume** keeps the flight ID and the previous phase, then re-checks that phase against the first valid sample. If on-ground/airborne no longer matches, it re-derives the phase from that sample. The interruption closes at that sample, with resolution `user_resumed`.
5. No values are created for the interruption interval. Airborne time is accumulated only between consecutive valid airborne samples less than 10 s apart.

**When the database is unavailable:**
- *Corrupt file:* the store reports `corrupt`, and recording is disabled. **Move damaged database aside** renames the file to `flightsim.db.damaged-<UTC>` and starts a fresh one; the file is never deleted.
- *Database from a newer app version:* the store reports `newer_schema` and leaves the file untouched.
- *I/O error:* the store reports `io`. **Retry** reopens it.
- *Write failure during a flight:* batches stay queued in memory and are retried, so nothing is dropped silently. If memory grows past 5,000 samples, the oldest interval samples are shed and counted, and the UI says so. Events and interruptions are never shed.

## Telemetry recording strategy

| Data | Rate | Why |
|---|---|---|
| Lifecycle engine input | every frame (2 Hz), in memory | Phase detection and debounce need full resolution. Nothing is written per frame. |
| Lifecycle events and interruptions | on occurrence | The debrief timeline and crash recovery depend on them. They are small and never down-sampled. |
| Track points (`flight_samples`) | by phase: takeoff/landing 1 s, approach 2 s, climb/descent/taxi 5 s, cruise and parked 10–15 s, plus one at every lifecycle event | Debrief fidelity where it matters (dynamic phases) without bloat in cruise. |
| Availability counters (`flights.stats`) | aggregated per flight | Record how often each reading was actually reported (e.g. fuel), without storing raw frames. |
| Flight row heartbeat (`last_seen_at_utc`, engine snapshot) | each flush (every 10 s and at every lifecycle event) | Bounds what a crash can lose to about 10 s of track points. Lifecycle events are flushed immediately. |

**Growth bounds:**
- A one-hour flight writes about 400–700 track points (≈ 100 KB).
- Interval samples stop at 20,000 per flight (≈ 3 MB worst case). Event-triggered points continue past that.
- **Retention**: Settings → *Keep detailed track data for the last N flights* (default 100, range 5–1000). Older closed flights keep their summary, events and interruptions; only their track points are deleted, and they are flagged `samples_pruned`.
- A prolonged session therefore cannot grow the database without bound.
- The 2 Hz raw frames stay in the bridge and UI memory only.

## Schema (migration 1)

The schema is in `apps/desktop/src-tauri/migrations/0001_local_flight_store.sql`. Migrations are recorded in `schema_migrations` and in `PRAGMA user_version`. Each is applied in its own transaction, and a database newer than the app is refused.

| Table | Key | Purpose |
|---|---|---|
| `flights` | `id` (UUID); `UNIQUE(profile_id, open_slot)` | One row per flight. `open_slot = 1` while active or interrupted, so at most one open flight per profile; this prevents duplicate flight records. CHECK constraints tie status, open slot and end time together. |
| `flight_events` | `(flight_id, seq)`, `event_id` UNIQUE | Lifecycle events. `seq` is the engine's per-flight sequence, so replays are idempotent. |
| `flight_interruptions` | `(flight_id, started_at_utc)` | Interruption intervals. An end time and resolution, once set, are never overwritten. |
| `flight_samples` | `(flight_id, seq)` | Down-sampled track points. NULL means the reading was unavailable. |

- All timestamps are UTC strings ending in `Z`, validated in Rust. No secrets, tokens or session IDs are stored.
- Origin and destination stay NULL until dispatch import exists; they are never guessed.
- `profile_id` allows multiple pilots later.
