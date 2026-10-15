-- FlightSimApp local store, schema version 2: opt-in cloud sync bookkeeping.
-- Local records stay the source of truth; nothing here is ever overwritten by cloud data.

-- Single-row sync settings. The binding records WHICH account flights may be uploaded to and
-- from WHEN (opt-in time). Flights are never moved between accounts.
CREATE TABLE sync_settings (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  enabled              INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  bound_account_id     TEXT,
  bound_account_label  TEXT,          -- masked email for display only
  opted_in_at_utc      TEXT,
  last_success_at_utc  TEXT,
  updated_at_utc       TEXT NOT NULL,
  CHECK ((enabled = 0) OR (bound_account_id IS NOT NULL AND opted_in_at_utc IS NOT NULL))
);
INSERT INTO sync_settings (id, enabled, updated_at_utc) VALUES (1, 0, strftime('%Y-%m-%dT%H:%M:%SZ','now'));

-- Per-flight upload state. account_id is fixed when the flight is queued and never changes.
CREATE TABLE flight_sync (
  flight_id                 TEXT PRIMARY KEY REFERENCES flights (id) ON DELETE CASCADE,
  account_id                TEXT NOT NULL,
  consent                   TEXT NOT NULL CHECK (consent IN ('recorded_after_opt_in','explicit_backfill')),
  state                     TEXT NOT NULL CHECK (state IN ('pending','uploading','synced','failed','retry_pending')),
  attempts                  INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  queued_at_utc             TEXT NOT NULL,
  next_attempt_at_utc       TEXT,
  last_attempt_at_utc       TEXT,
  last_error                TEXT,
  synced_at_utc             TEXT,
  cloud_event_count         INTEGER,
  cloud_interruption_count  INTEGER,
  CHECK ((state = 'synced') = (synced_at_utc IS NOT NULL))
) WITHOUT ROWID;
CREATE INDEX flight_sync_due ON flight_sync (account_id, state, next_attempt_at_utc);
