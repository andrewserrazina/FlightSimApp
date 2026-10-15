-- FlightSimApp local store, schema version 3: dispatch (imported SimBrief flight plans).
-- Local only: nothing here is part of cloud sync. No credentials are stored (SimBrief's latest-OFP
-- endpoint needs only the public username / Pilot ID, which lives in the UI preferences).

-- The most recent successfully imported plan (normalized Turnline model, not the raw SimBrief
-- response). Kept when SimBrief is unreachable; replaced only by a newer successful import.
CREATE TABLE dispatch_plan (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  plan_json          TEXT NOT NULL,
  source_request_id  TEXT,
  imported_at_utc    TEXT NOT NULL,
  updated_at_utc     TEXT NOT NULL
);

-- Immutable copy of a plan explicitly associated with one recorded flight. Later imports never
-- touch it; one snapshot per flight. Deleted only together with its flight.
CREATE TABLE flight_plan_snapshots (
  flight_id          TEXT PRIMARY KEY REFERENCES flights (id) ON DELETE CASCADE,
  snapshot_json      TEXT NOT NULL,
  source_request_id  TEXT,
  associated_at_utc  TEXT NOT NULL
);

CREATE TRIGGER flight_plan_snapshots_immutable
BEFORE UPDATE ON flight_plan_snapshots
BEGIN
  SELECT RAISE(ABORT, 'flight plan snapshots are immutable');
END;
