-- Turnline local store, schema version 6: GSX turnarounds, GSX receipts and the simulated operating-expense
-- ledger (S2-05). Local only; not part of cloud sync. Additive only: no existing table or row is changed.
-- Every amount here is a SIMULATED operating cost from flight simulation (GSX Pro), never a real-world
-- financial transaction. All times are real-world UTC.

-- Ground handling at one airport for one flight side. A departure turnaround may open before a flight is
-- recorded (flight_id NULL) and is linked to a flight only when that is unambiguous (the flight being
-- recorded when it opened) or the user confirms it.
CREATE TABLE turnarounds (
  id              TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  side            TEXT NOT NULL CHECK (side IN ('departure','arrival')),
  status          TEXT NOT NULL CHECK (status IN ('open','interrupted','closed','abandoned')),
  flight_id       TEXT REFERENCES flights (id),
  flight_link     TEXT NOT NULL CHECK (flight_link IN ('unlinked','recording_at_open','user_confirmed')),
  airport_icao    TEXT CHECK (airport_icao IS NULL OR (length(airport_icao) BETWEEN 3 AND 4)),
  airport_source  TEXT CHECK (airport_source IN ('plan','user')),
  gate_text       TEXT CHECK (gate_text IS NULL OR length(gate_text) BETWEEN 1 AND 32),
  gate_source     TEXT CHECK (gate_source IN ('user')),
  opened_at_utc   TEXT NOT NULL,
  closed_at_utc   TEXT,
  close_reason    TEXT CHECK (close_reason IS NULL OR length(trim(close_reason)) BETWEEN 1 AND 200),
  -- 1 while open or interrupted: at most one unfinished turnaround at a time.
  open_slot       INTEGER UNIQUE CHECK (open_slot IS NULL OR open_slot = 1),
  CHECK ((flight_id IS NULL) = (flight_link = 'unlinked')),
  CHECK ((airport_icao IS NULL) = (airport_source IS NULL)),
  CHECK ((gate_text IS NULL) = (gate_source IS NULL)),
  CHECK ((status IN ('open','interrupted')) = (open_slot IS NOT NULL)),
  CHECK ((status IN ('closed','abandoned')) = (closed_at_utc IS NOT NULL))
);
CREATE INDEX turnarounds_by_flight ON turnarounds (flight_id);

CREATE TRIGGER turnarounds_identity_immutable
BEFORE UPDATE OF id, side, opened_at_utc ON turnarounds
BEGIN
  SELECT RAISE(ABORT, 'turnaround identity is immutable');
END;

CREATE TRIGGER turnarounds_finished_final
BEFORE UPDATE OF status ON turnarounds
WHEN OLD.status IN ('closed','abandoned')
BEGIN
  SELECT RAISE(ABORT, 'a finished turnaround cannot be reopened');
END;

CREATE TRIGGER turnarounds_link_once
BEFORE UPDATE OF flight_id, flight_link ON turnarounds
WHEN OLD.flight_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a turnaround stays linked to its flight');
END;

CREATE TRIGGER turnarounds_no_delete
BEFORE DELETE ON turnarounds
BEGIN
  SELECT RAISE(ABORT, 'turnaround records are kept');
END;

-- Service history. A GSX row is a valid GSX observation (state from GSX's documented enum, observed by the
-- bridge); a manual row is the user's explicit entry with a required note. They never mix.
-- Nothing is recorded for a period without fresh GSX data; feed gaps are kept in turnaround_feed_log.
CREATE TABLE turnaround_service_events (
  id               INTEGER PRIMARY KEY,
  turnaround_id    TEXT NOT NULL REFERENCES turnarounds (id),
  service          TEXT NOT NULL CHECK (service IN ('boarding','deboarding','catering','refueling','pushback','deice')),
  source           TEXT NOT NULL CHECK (source IN ('gsx','manual')),
  gsx_state        TEXT CHECK (gsx_state IN ('can_be_called','not_available','bypassed','requested','being_performed','completed')),
  gsx_raw          REAL,
  manual_status    TEXT CHECK (manual_status IN ('started','completed','not_required')),
  note             TEXT CHECK (note IS NULL OR length(trim(note)) BETWEEN 1 AND 500),
  observed_at_utc  TEXT NOT NULL,
  recorded_at_utc  TEXT NOT NULL,
  clock_source     TEXT NOT NULL DEFAULT 'real_world_utc' CHECK (clock_source IN ('real_world_utc')),
  CHECK (
    (source = 'gsx' AND gsx_state IS NOT NULL AND gsx_raw IS NOT NULL AND manual_status IS NULL AND note IS NULL)
    OR (source = 'manual' AND manual_status IS NOT NULL AND note IS NOT NULL AND gsx_state IS NULL AND gsx_raw IS NULL)
  )
);
CREATE INDEX turnaround_service_events_by_turnaround ON turnaround_service_events (turnaround_id, id);

CREATE TRIGGER turnaround_service_events_immutable
BEFORE UPDATE ON turnaround_service_events
BEGIN
  SELECT RAISE(ABORT, 'service history is immutable');
END;

CREATE TRIGGER turnaround_service_events_no_delete
BEFORE DELETE ON turnaround_service_events
BEGIN
  SELECT RAISE(ABORT, 'service history is kept');
END;

-- GSX feed availability while a turnaround is unfinished (live / stale / not detected / simulator not
-- connected / app restarted), so the debrief can show where observations are missing.
CREATE TABLE turnaround_feed_log (
  id              INTEGER PRIMARY KEY,
  turnaround_id   TEXT NOT NULL REFERENCES turnarounds (id),
  feed            TEXT NOT NULL CHECK (feed IN ('live','stale','not_detected','sim_not_connected','app_restarted')),
  at_utc          TEXT NOT NULL
);
CREATE INDEX turnaround_feed_log_by_turnaround ON turnaround_feed_log (turnaround_id, id);

CREATE TRIGGER turnaround_feed_log_immutable
BEFORE UPDATE ON turnaround_feed_log
BEGIN
  SELECT RAISE(ABORT, 'feed log is immutable');
END;

CREATE TRIGGER turnaround_feed_log_no_delete
BEFORE DELETE ON turnaround_feed_log
BEGIN
  SELECT RAISE(ABORT, 'feed log is kept');
END;

-- GSX receipt files imported read-only from the GSX Receipts folder. One row per distinct content
-- (sha256). parsed_json is the parser's result with the printed text of every amount; raw_source is the
-- original file, kept with the record (never rendered). Association with a flight or turnaround is only
-- ever made by the user.
CREATE TABLE gsx_receipts (
  id                    TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  sha256                TEXT NOT NULL UNIQUE CHECK (length(sha256) = 64),
  group_name            TEXT NOT NULL CHECK (length(group_name) BETWEEN 1 AND 64),
  file_name             TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 260),
  file_size             INTEGER NOT NULL CHECK (file_size >= 0),
  file_modified_at_utc  TEXT,
  imported_at_utc       TEXT NOT NULL,
  receipt_number        TEXT CHECK (receipt_number IS NULL OR length(receipt_number) BETWEEN 1 AND 128),
  layout                TEXT,
  parser_version        TEXT NOT NULL,
  parse_status          TEXT NOT NULL CHECK (parse_status IN ('verified','needs_review','unsupported_format','unreadable')),
  parsed_json           TEXT NOT NULL,
  raw_source            BLOB,
  -- JSON array of receipt ids with the same printed number but different content (flag only).
  possible_revision_of  TEXT,
  flight_id             TEXT REFERENCES flights (id),
  turnaround_id         TEXT REFERENCES turnarounds (id),
  associated_at_utc     TEXT,
  dismissed_at_utc      TEXT,
  CHECK ((flight_id IS NULL AND turnaround_id IS NULL) = (associated_at_utc IS NULL))
);
CREATE INDEX gsx_receipts_by_number ON gsx_receipts (receipt_number);
CREATE INDEX gsx_receipts_by_flight ON gsx_receipts (flight_id);

CREATE TRIGGER gsx_receipts_content_immutable
BEFORE UPDATE OF id, sha256, group_name, file_name, file_size, file_modified_at_utc, imported_at_utc, receipt_number, layout, parser_version, parse_status, parsed_json, raw_source ON gsx_receipts
BEGIN
  SELECT RAISE(ABORT, 'imported receipts are immutable');
END;

CREATE TRIGGER gsx_receipts_no_delete
BEFORE DELETE ON gsx_receipts
BEGIN
  SELECT RAISE(ABORT, 'imported receipts are kept');
END;

-- A person's confirmation of the currency of one receipt that printed only a shared symbol (owner decision,
-- option A). Bound to the exact receipt bytes. Never edited: a correction adds a row and supersedes the old.
CREATE TABLE receipt_currency_confirmations (
  id                TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  receipt_id        TEXT NOT NULL REFERENCES gsx_receipts (id),
  receipt_sha256    TEXT NOT NULL CHECK (length(receipt_sha256) = 64),
  currency          TEXT NOT NULL CHECK (length(currency) = 3),
  confirmed_by      TEXT NOT NULL CHECK (length(confirmed_by) BETWEEN 1 AND 64),
  confirmed_at_utc  TEXT NOT NULL,
  note              TEXT CHECK (note IS NULL OR length(trim(note)) BETWEEN 1 AND 500),
  -- Deferred so a correction can point the old row at its successor before inserting it.
  superseded_by     TEXT REFERENCES receipt_currency_confirmations (id) DEFERRABLE INITIALLY DEFERRED,
  superseded_at_utc TEXT,
  CHECK ((superseded_by IS NULL) = (superseded_at_utc IS NULL))
);
-- At most one current confirmation per receipt.
CREATE UNIQUE INDEX receipt_currency_confirmations_current ON receipt_currency_confirmations (receipt_id) WHERE superseded_by IS NULL;

CREATE TRIGGER receipt_currency_confirmations_immutable
BEFORE UPDATE OF id, receipt_id, receipt_sha256, currency, confirmed_by, confirmed_at_utc, note ON receipt_currency_confirmations
BEGIN
  SELECT RAISE(ABORT, 'currency confirmations are immutable');
END;

CREATE TRIGGER receipt_currency_confirmations_supersede_once
BEFORE UPDATE OF superseded_by, superseded_at_utc ON receipt_currency_confirmations
WHEN OLD.superseded_by IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a superseded confirmation stays superseded');
END;

CREATE TRIGGER receipt_currency_confirmations_no_delete
BEFORE DELETE ON receipt_currency_confirmations
BEGIN
  SELECT RAISE(ABORT, 'currency confirmations are kept');
END;

-- Simulated operating expenses. Amount and currency never change; corrections supersede or void.
-- 'estimated' is reserved and not accepted until a verifiable estimate source exists.
CREATE TABLE expenses (
  id               TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  source           TEXT NOT NULL CHECK (source IN ('gsx_invoiced','manual')),
  category         TEXT NOT NULL CHECK (category IN ('fuel','catering','handling','passenger_transport','deicing','other')),
  description      TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 200),
  amount_minor     INTEGER NOT NULL,
  currency         TEXT NOT NULL CHECK (length(currency) = 3),
  -- Where the currency came from: printed code on the receipt, the user's confirmation, or a manual entry.
  currency_source  TEXT NOT NULL CHECK (currency_source IN ('receipt_explicit','user_confirmed','user_entered')),
  printed_total    TEXT CHECK (printed_total IS NULL OR length(printed_total) BETWEEN 1 AND 64),
  receipt_id       TEXT REFERENCES gsx_receipts (id),
  confirmation_id  TEXT REFERENCES receipt_currency_confirmations (id),
  flight_id        TEXT REFERENCES flights (id),
  turnaround_id    TEXT REFERENCES turnarounds (id),
  status           TEXT NOT NULL CHECK (status IN ('active','superseded','voided')),
  superseded_by    TEXT REFERENCES expenses (id) DEFERRABLE INITIALLY DEFERRED,
  void_reason      TEXT CHECK (void_reason IS NULL OR length(trim(void_reason)) BETWEEN 1 AND 500),
  observed_at_utc  TEXT,
  created_at_utc   TEXT NOT NULL,
  cost_kind        TEXT NOT NULL DEFAULT 'simulated' CHECK (cost_kind = 'simulated'),
  CHECK ((source = 'gsx_invoiced') = (receipt_id IS NOT NULL)),
  CHECK ((source = 'gsx_invoiced') = (printed_total IS NOT NULL)),
  CHECK ((currency_source = 'user_confirmed') = (confirmation_id IS NOT NULL)),
  CHECK (source <> 'manual' OR currency_source = 'user_entered'),
  CHECK ((status = 'superseded') = (superseded_by IS NOT NULL)),
  CHECK ((status = 'voided') = (void_reason IS NOT NULL))
);
-- A receipt is counted at most once: one active expense per receipt.
CREATE UNIQUE INDEX expenses_one_active_per_receipt ON expenses (receipt_id) WHERE status = 'active' AND receipt_id IS NOT NULL;
CREATE INDEX expenses_by_flight ON expenses (flight_id);

CREATE TRIGGER expenses_amount_immutable
BEFORE UPDATE OF id, source, category, description, amount_minor, currency, currency_source, printed_total, receipt_id, confirmation_id, observed_at_utc, created_at_utc, cost_kind ON expenses
BEGIN
  SELECT RAISE(ABORT, 'expense amounts are immutable');
END;

CREATE TRIGGER expenses_finished_final
BEFORE UPDATE OF status ON expenses
WHEN OLD.status <> 'active'
BEGIN
  SELECT RAISE(ABORT, 'a superseded or voided expense cannot change');
END;

CREATE TRIGGER expenses_no_delete
BEFORE DELETE ON expenses
BEGIN
  SELECT RAISE(ABORT, 'expenses are kept');
END;

-- Every user-visible change to an expense, in order.
CREATE TABLE expense_audit (
  id          INTEGER PRIMARY KEY,
  expense_id  TEXT NOT NULL REFERENCES expenses (id),
  action      TEXT NOT NULL CHECK (action IN ('created','associated','superseded','voided')),
  actor       TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 64),
  at_utc      TEXT NOT NULL,
  detail      TEXT CHECK (detail IS NULL OR length(detail) <= 500)
);
CREATE INDEX expense_audit_by_expense ON expense_audit (expense_id, id);

CREATE TRIGGER expense_audit_immutable
BEFORE UPDATE ON expense_audit
BEGIN
  SELECT RAISE(ABORT, 'audit history is immutable');
END;

CREATE TRIGGER expense_audit_no_delete
BEFORE DELETE ON expense_audit
BEGIN
  SELECT RAISE(ABORT, 'audit history is kept');
END;
