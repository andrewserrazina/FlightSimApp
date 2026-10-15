-- FlightSimApp local flight store, schema version 1.
-- Local only (desktop). Separate from the cloud schema in db/migrations, which is not applied here.
-- All timestamps are UTC ISO-8601 strings ending in 'Z'. NULL always means "not observed / unavailable".

CREATE TABLE flights (
  id                  TEXT PRIMARY KEY,                 -- UUID generated when the flight is started
  profile_id          TEXT NOT NULL DEFAULT 'local',    -- future multi-pilot support
  open_slot           INTEGER CHECK (open_slot IS NULL OR open_slot = 1), -- 1 while active/interrupted
  status              TEXT NOT NULL CHECK (status IN ('active','interrupted','completed','aborted','discarded')),
  completion          TEXT CHECK (completion IN ('arrival_confirmed','landing_confirmed','user_confirmed_without_evidence')),
  phase               TEXT NOT NULL,
  simulator           TEXT NOT NULL CHECK (simulator IN ('mock','msfs2020','msfs2024')),
  simulator_version   TEXT,
  aircraft_title      TEXT,
  aircraft_icao       TEXT,
  origin_icao         TEXT,                              -- no source yet (dispatch import is later)
  destination_icao    TEXT,
  started_at_utc      TEXT NOT NULL,
  ended_at_utc        TEXT,
  last_seen_at_utc    TEXT NOT NULL,                     -- last recorded telemetry; crash-recovery anchor
  takeoff_at_utc      TEXT,
  landing_at_utc      TEXT,
  airborne_seconds    REAL NOT NULL DEFAULT 0 CHECK (airborne_seconds >= 0),
  started_airborne    INTEGER NOT NULL DEFAULT 0 CHECK (started_airborne IN (0,1)),
  engine_state        TEXT NOT NULL,                     -- lifecycle engine snapshot (JSON) for recovery
  stats               TEXT NOT NULL DEFAULT '{}',        -- availability counters (JSON)
  samples_pruned      INTEGER NOT NULL DEFAULT 0 CHECK (samples_pruned IN (0,1)),
  created_at_utc      TEXT NOT NULL,
  updated_at_utc      TEXT NOT NULL,
  -- At most one open (active/interrupted) flight per profile: prevents duplicate flight records.
  UNIQUE (profile_id, open_slot),
  CHECK ((status IN ('active','interrupted')) = (open_slot IS NOT NULL)),
  CHECK ((status IN ('active','interrupted')) = (ended_at_utc IS NULL))
);
CREATE INDEX flights_by_start ON flights (profile_id, started_at_utc DESC);

CREATE TABLE flight_events (
  flight_id       TEXT NOT NULL REFERENCES flights (id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL CHECK (seq > 0),      -- per-flight engine sequence: idempotency key
  event_id        TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL,
  occurred_at_utc TEXT NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('detected','user','system')),
  from_phase      TEXT,
  to_phase        TEXT,
  details         TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (flight_id, seq)
) WITHOUT ROWID;

CREATE TABLE flight_interruptions (
  flight_id       TEXT NOT NULL REFERENCES flights (id) ON DELETE CASCADE,
  started_at_utc  TEXT NOT NULL,                         -- last valid telemetry before the interruption
  ended_at_utc    TEXT,
  cause           TEXT NOT NULL CHECK (cause IN ('app_closed','bridge_lost','simulator_disconnected','telemetry_stale')),
  resolution      TEXT CHECK (resolution IN ('auto_resumed','user_resumed','flight_ended')),
  PRIMARY KEY (flight_id, started_at_utc)
) WITHOUT ROWID;

-- Down-sampled track points (see docs/architecture/flight-recording.md). Not every raw frame.
CREATE TABLE flight_samples (
  flight_id         TEXT NOT NULL REFERENCES flights (id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL CHECK (seq > 0),
  observed_at_utc   TEXT NOT NULL,
  phase             TEXT NOT NULL,
  reason            TEXT NOT NULL CHECK (reason IN ('interval','phase_change','event')),
  on_ground         INTEGER CHECK (on_ground IN (0,1)),
  lat_deg           REAL,
  lon_deg           REAL,
  indicated_alt_ft  REAL,
  radio_alt_ft      REAL,
  ground_speed_kt   REAL,
  indicated_kt      REAL,
  vertical_fpm      REAL,
  heading_deg       REAL,
  fuel_kg           REAL,
  PRIMARY KEY (flight_id, seq)
) WITHOUT ROWID;
