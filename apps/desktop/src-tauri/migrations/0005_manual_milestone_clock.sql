-- Turnline local store, schema version 5: clock source of pilot-recorded OUT/IN (S2-02 decision 4).
-- Additive. Manual milestones are captured with the computer's real-world UTC clock; this column
-- records that explicitly so the value is never mistaken for simulator time. Rows written by
-- schema v4 builds were captured the same way, so the default describes them accurately.
-- The immutability trigger from migration 4 also covers this column.
ALTER TABLE flight_manual_milestones
  ADD COLUMN clock_source TEXT NOT NULL DEFAULT 'real_world_utc' CHECK (clock_source IN ('real_world_utc'));
