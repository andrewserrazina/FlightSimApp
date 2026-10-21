-- Turnline local store, schema version 7: GSX receipt watcher bookkeeping (S2-06 PR 1). Additive only.
-- Local only; not synced.

-- One row per receipt file path the watcher has seen under the GSX Receipts folder. This is bookkeeping
-- (what was seen, when, and what became of it), not an audit record: rows are updated as files change.
-- Receipt content itself lives immutably in gsx_receipts (S2-05); a vanished file never touches it.
CREATE TABLE receipt_files (
  rel_path           TEXT PRIMARY KEY CHECK (length(rel_path) BETWEEN 3 AND 400),
  size               INTEGER CHECK (size IS NULL OR size >= 0),
  mtime_ns           INTEGER,
  state              TEXT NOT NULL CHECK (state IN ('pending','unstable','imported','duplicate','skipped','failed','vanished')),
  detail             TEXT CHECK (detail IS NULL OR length(detail) <= 300),
  sha256             TEXT CHECK (sha256 IS NULL OR length(sha256) = 64),
  receipt_id         TEXT REFERENCES gsx_receipts (id),
  first_seen_at_utc  TEXT NOT NULL,
  updated_at_utc     TEXT NOT NULL,
  -- Imported/duplicate rows name their receipt; a vanished row may keep it; nothing else may.
  CHECK (state NOT IN ('imported','duplicate') OR receipt_id IS NOT NULL),
  CHECK (receipt_id IS NULL OR state IN ('imported','duplicate','vanished'))
);

CREATE TRIGGER receipt_files_no_delete
BEFORE DELETE ON receipt_files
BEGIN
  SELECT RAISE(ABORT, 'receipt file bookkeeping is kept');
END;

-- Small key/value settings owned by the desktop app (e.g. whether the watcher runs).
CREATE TABLE app_settings (
  key             TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 64),
  value           TEXT NOT NULL CHECK (length(value) <= 1000),
  updated_at_utc  TEXT NOT NULL
);
