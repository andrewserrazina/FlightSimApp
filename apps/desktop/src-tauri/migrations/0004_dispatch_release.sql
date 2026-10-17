-- Turnline local store, schema version 4: dispatch releases and manually recorded OUT/IN milestones.
-- Local only: nothing here is part of cloud sync. Additive only: no existing table or row is changed.
-- A "dispatch release" is a flight-simulation record, not a real-world (FAA or other) dispatch release.

-- One explicit release of a reviewed flight plan.
-- * release_json holds the immutable part: the reviewed plan snapshot, the OFP identity and the
--   pilot's acknowledgments. It can never change after insertion (trigger below).
-- * Mutable operational columns are limited to the cancellation (released -> cancelled) and the
--   one-time link to a recorded flight. Both are guarded by triggers.
-- * open_slot is 1 while a release is released and not yet linked to a flight; the UNIQUE
--   constraint allows at most one such open release at a time (the same pattern as `flights`).
CREATE TABLE dispatch_releases (
  release_id              TEXT PRIMARY KEY CHECK (length(release_id) BETWEEN 1 AND 64),
  release_json            TEXT NOT NULL,
  ofp_key                 TEXT NOT NULL CHECK (length(ofp_key) BETWEEN 1 AND 256),
  source_request_id       TEXT,
  source_generated_at_utc TEXT,
  released_at_utc         TEXT NOT NULL,
  state                   TEXT NOT NULL CHECK (state IN ('released','cancelled')),
  cancelled_at_utc        TEXT,
  cancel_reason           TEXT CHECK (cancel_reason IS NULL OR length(trim(cancel_reason)) BETWEEN 1 AND 500),
  flight_id               TEXT UNIQUE REFERENCES flights (id),
  linked_at_utc           TEXT,
  open_slot               INTEGER UNIQUE CHECK (open_slot IS NULL OR open_slot = 1),
  created_at_utc          TEXT NOT NULL,
  CHECK ((state = 'cancelled') = (cancelled_at_utc IS NOT NULL)),
  CHECK ((state = 'cancelled') = (cancel_reason IS NOT NULL)),
  CHECK ((flight_id IS NULL) = (linked_at_utc IS NULL)),
  -- A cancelled release is never linked to a flight (cancellation is only possible before linking).
  CHECK (NOT (state = 'cancelled' AND flight_id IS NOT NULL)),
  CHECK ((state = 'released' AND flight_id IS NULL) = (open_slot IS NOT NULL))
);
CREATE INDEX dispatch_releases_by_time ON dispatch_releases (released_at_utc DESC);

CREATE TRIGGER dispatch_releases_immutable_record
BEFORE UPDATE OF release_id, release_json, ofp_key, source_request_id, source_generated_at_utc, released_at_utc, created_at_utc ON dispatch_releases
BEGIN
  SELECT RAISE(ABORT, 'released plans are immutable');
END;

-- Allowed transitions: released -> cancelled. Nothing leaves "cancelled".
CREATE TRIGGER dispatch_releases_state_transition
BEFORE UPDATE OF state, cancelled_at_utc, cancel_reason ON dispatch_releases
WHEN OLD.state = 'cancelled'
BEGIN
  SELECT RAISE(ABORT, 'a cancelled release cannot be changed');
END;

-- The flight link is written once and never moved or removed.
CREATE TRIGGER dispatch_releases_link_once
BEFORE UPDATE OF flight_id, linked_at_utc ON dispatch_releases
WHEN OLD.flight_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a release stays linked to its flight');
END;

CREATE TRIGGER dispatch_releases_no_delete
BEFORE DELETE ON dispatch_releases
BEGIN
  SELECT RAISE(ABORT, 'release records are kept');
END;

-- OUT (off-block) and IN (on-block) recorded explicitly by the pilot. Turnline never infers these
-- from telemetry. One value per milestone and flight, never changed afterwards.
CREATE TABLE flight_manual_milestones (
  flight_id        TEXT NOT NULL REFERENCES flights (id) ON DELETE CASCADE,
  milestone        TEXT NOT NULL CHECK (milestone IN ('out','in')),
  occurred_at_utc  TEXT NOT NULL,
  recorded_at_utc  TEXT NOT NULL,
  PRIMARY KEY (flight_id, milestone)
) WITHOUT ROWID;

CREATE TRIGGER flight_manual_milestones_immutable
BEFORE UPDATE ON flight_manual_milestones
BEGIN
  SELECT RAISE(ABORT, 'recorded milestones are immutable');
END;
