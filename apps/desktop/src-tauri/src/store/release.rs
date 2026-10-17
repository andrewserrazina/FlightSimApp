//! Dispatch releases and pilot-recorded OUT/IN milestones (schema v4). Local only.
//!
//! A release is an explicit, persisted decision to operate a reviewed flight plan. Its reviewed
//! content (`release_json`) is immutable; only the cancellation and the one-time link to a recorded
//! flight change, and SQLite triggers enforce the allowed transitions as well as the code here.
//! This is a flight-simulation record, not a real-world dispatch release.

use rusqlite::{params, OptionalExtension, Transaction};
use serde::Serialize;

use super::{check_ts, dispatch::MAX_PLAN_BYTES, now_utc, Store, StoreError};

pub const RELEASE_SCHEMA: &str = "turnline.dispatch_release";
const MAX_RELEASE_BYTES: usize = MAX_PLAN_BYTES + 16 * 1024;
const MAX_ID: usize = 64;
const MAX_KEY: usize = 256;
const MAX_REASON_CHARS: usize = 500;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseOut {
    /// The immutable reviewed record exactly as stored (JSON null if it no longer parses).
    pub record: serde_json::Value,
    pub state: String,
    pub cancelled_at_utc: Option<String>,
    pub cancel_reason: Option<String>,
    pub flight_id: Option<String>,
    pub linked_at_utc: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MilestoneOut {
    pub milestone: String,
    pub occurred_at_utc: String,
    pub recorded_at_utc: String,
    /// Clock the time was read from. V1: always "real_world_utc" (the computer's UTC clock).
    pub clock_source: String,
}

/// Clock sources accepted for manual milestones. Simulator time is deliberately not one of them.
pub const MILESTONE_CLOCKS: &[&str] = &["real_world_utc"];

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum MilestoneOutcome {
    Recorded,
    /// Already recorded for this flight; the existing value was kept.
    AlreadyRecorded,
}

fn check_id(name: &str, v: &str) -> Result<(), StoreError> {
    if v.is_empty() || v.len() > MAX_ID || !v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(StoreError::invalid(format!("{name} is invalid")));
    }
    Ok(())
}

fn str_at<'a>(v: &'a serde_json::Value, pointer: &str) -> Option<&'a str> {
    v.pointer(pointer).and_then(|x| x.as_str())
}

const RELEASE_COLUMNS: &str = "release_json, state, cancelled_at_utc, cancel_reason, flight_id, linked_at_utc";

fn release_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ReleaseOut> {
    let json: String = r.get(0)?;
    Ok(ReleaseOut {
        record: serde_json::from_str(&json).unwrap_or(serde_json::Value::Null),
        state: r.get(1)?,
        cancelled_at_utc: r.get(2)?,
        cancel_reason: r.get(3)?,
        flight_id: r.get(4)?,
        linked_at_utc: r.get(5)?,
    })
}

struct ReleaseRow {
    state: String,
    flight_id: Option<String>,
    json: String,
}

fn load_row(tx: &Transaction<'_>, release_id: &str) -> Result<ReleaseRow, StoreError> {
    tx.query_row("SELECT state, flight_id, release_json FROM dispatch_releases WHERE release_id = ?1", [release_id], |r| {
        Ok(ReleaseRow { state: r.get(0)?, flight_id: r.get(1)?, json: r.get(2)? })
    })
    .optional()?
    .ok_or_else(|| StoreError::invalid("That release does not exist."))
}

struct CheckedRelease {
    json: String,
    key: String,
    request_id: Option<String>,
    generated: Option<String>,
    released_at: String,
    id: String,
}

/// Validate a release record coming from the webview.
fn check_release(v: &serde_json::Value) -> Result<CheckedRelease, StoreError> {
    let obj = v.as_object().ok_or_else(|| StoreError::invalid("release must be a JSON object"))?;
    if obj.get("schema").and_then(|s| s.as_str()) != Some(RELEASE_SCHEMA) || obj.get("version").and_then(|s| s.as_i64()) != Some(1) {
        return Err(StoreError::invalid("release has an unknown schema"));
    }
    let id = str_at(v, "/releaseId").ok_or_else(|| StoreError::invalid("releaseId is required"))?.to_string();
    check_id("releaseId", &id)?;
    let released_at = str_at(v, "/releasedAtUtc").ok_or_else(|| StoreError::invalid("releasedAtUtc is required"))?.to_string();
    check_ts("releasedAtUtc", &released_at)?;
    let key = str_at(v, "/ofp/key").filter(|k| !k.is_empty() && k.len() <= MAX_KEY).ok_or_else(|| StoreError::invalid("ofp.key is invalid"))?.to_string();
    if str_at(v, "/plan/schema") != Some("turnline.flight_plan") {
        return Err(StoreError::invalid("release.plan is not a flight plan"));
    }
    if v.pointer("/acknowledgments/reviewed").and_then(|b| b.as_bool()) != Some(true) {
        return Err(StoreError::invalid("A release needs the pilot's review acknowledgment."));
    }
    let reviewed_at = str_at(v, "/acknowledgments/reviewedAtUtc").ok_or_else(|| StoreError::invalid("acknowledgments.reviewedAtUtc is required"))?;
    check_ts("acknowledgments.reviewedAtUtc", reviewed_at)?;
    let text = serde_json::to_string(v).map_err(|e| StoreError::invalid(format!("release: {e}")))?;
    if text.len() > MAX_RELEASE_BYTES {
        return Err(StoreError::invalid("release is too large"));
    }
    let request_id = str_at(v, "/ofp/requestId").filter(|s| !s.is_empty() && s.len() <= MAX_ID).map(str::to_string);
    let generated = str_at(v, "/ofp/generatedAtUtc").map(str::to_string);
    if let Some(g) = &generated {
        check_ts("ofp.generatedAtUtc", g)?;
    }
    Ok(CheckedRelease { json: text, key, request_id, generated, released_at, id })
}

impl Store {
    /// Issue a release (one transaction). At most one release may be open (released and not yet
    /// attached to a flight); releasing again while one is open is refused, never merged.
    pub fn create_release(&mut self, release: &serde_json::Value) -> Result<ReleaseOut, StoreError> {
        let CheckedRelease { json, key, request_id, generated, released_at, id } = check_release(release)?;
        let tx = self.conn.transaction()?;
        let open: Option<(String, String)> = tx.query_row("SELECT release_id, ofp_key FROM dispatch_releases WHERE open_slot = 1", [], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
        if let Some((open_id, open_key)) = open {
            return Err(StoreError::invalid(if open_key == key {
                format!("This OFP is already released (release {open_id}). It was not released twice.")
            } else {
                format!("Release {open_id} is still open. Attach it to a flight or cancel it before releasing another plan.")
            }));
        }
        let exists: bool = tx.query_row("SELECT EXISTS (SELECT 1 FROM dispatch_releases WHERE release_id = ?1)", [&id], |r| r.get(0))?;
        if exists {
            return Err(StoreError::invalid("A release with this id already exists."));
        }
        tx.execute(
            "INSERT INTO dispatch_releases (release_id, release_json, ofp_key, source_request_id, source_generated_at_utc, released_at_utc, state, open_slot, created_at_utc)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'released', 1, ?7)",
            params![id, json, key, request_id, generated, released_at, now_utc()],
        )?;
        let out = tx.query_row(&format!("SELECT {RELEASE_COLUMNS} FROM dispatch_releases WHERE release_id = ?1"), [&id], release_from_row)?;
        tx.commit()?;
        Ok(out)
    }

    /// released -> cancelled, with a reason. Only an open release (not attached to a flight) can be cancelled.
    pub fn cancel_release(&mut self, release_id: &str, cancelled_at_utc: &str, reason: &str) -> Result<ReleaseOut, StoreError> {
        check_id("releaseId", release_id)?;
        check_ts("cancelledAtUtc", cancelled_at_utc)?;
        let reason = reason.trim();
        if reason.is_empty() || reason.chars().count() > MAX_REASON_CHARS {
            return Err(StoreError::invalid("A cancellation reason (up to 500 characters) is required."));
        }
        let tx = self.conn.transaction()?;
        let row = load_row(&tx, release_id)?;
        if row.state == "cancelled" {
            return Err(StoreError::invalid("This release is already cancelled."));
        }
        if row.flight_id.is_some() {
            return Err(StoreError::invalid("This release is attached to a recorded flight and is kept as flown. It cannot be cancelled."));
        }
        tx.execute(
            "UPDATE dispatch_releases SET state = 'cancelled', cancelled_at_utc = ?2, cancel_reason = ?3, open_slot = NULL WHERE release_id = ?1",
            params![release_id, cancelled_at_utc, reason],
        )?;
        let out = tx.query_row(&format!("SELECT {RELEASE_COLUMNS} FROM dispatch_releases WHERE release_id = ?1"), [release_id], release_from_row)?;
        tx.commit()?;
        Ok(out)
    }

    /// Attach an open release to a recorded flight (one transaction): link the release and store
    /// the released plan as the flight's immutable plan snapshot. Refused when the release is
    /// cancelled or already attached, or when the flight already has a plan or a release.
    pub fn attach_release(&mut self, release_id: &str, flight_id: &str, linked_at_utc: &str) -> Result<ReleaseOut, StoreError> {
        check_id("releaseId", release_id)?;
        check_id("flightId", flight_id)?;
        check_ts("linkedAtUtc", linked_at_utc)?;
        let tx = self.conn.transaction()?;
        let row = load_row(&tx, release_id)?;
        if row.state == "cancelled" {
            return Err(StoreError::invalid("A cancelled release cannot be attached to a flight."));
        }
        if let Some(f) = &row.flight_id {
            return Err(StoreError::invalid(if f == flight_id { "This release is already attached to this flight." } else { "This release is already attached to another flight." }));
        }
        let flight_exists: bool = tx.query_row("SELECT EXISTS (SELECT 1 FROM flights WHERE id = ?1)", [flight_id], |r| r.get(0))?;
        if !flight_exists {
            return Err(StoreError::invalid("That flight has not been saved yet. Try again in a moment."));
        }
        let has_release: bool = tx.query_row("SELECT EXISTS (SELECT 1 FROM dispatch_releases WHERE flight_id = ?1)", [flight_id], |r| r.get(0))?;
        let has_plan: bool = tx.query_row("SELECT EXISTS (SELECT 1 FROM flight_plan_snapshots WHERE flight_id = ?1)", [flight_id], |r| r.get(0))?;
        if has_release || has_plan {
            return Err(StoreError::invalid("This flight already has a flight plan attached. It was left unchanged."));
        }
        let record: serde_json::Value = serde_json::from_str(&row.json).map_err(|_| StoreError::invalid("The stored release is damaged and cannot be attached."))?;
        let plan = record.get("plan").cloned().ok_or_else(|| StoreError::invalid("The stored release has no plan."))?;
        let snapshot = serde_json::json!({
            "schema": "turnline.flight_plan_snapshot",
            "version": 1,
            "flightId": flight_id,
            "associatedAtUtc": linked_at_utc,
            "releaseId": release_id,
            "plan": plan,
        });
        let request_id = str_at(&plan, "/source/requestId").map(str::to_string);
        tx.execute(
            "INSERT INTO flight_plan_snapshots (flight_id, snapshot_json, source_request_id, associated_at_utc) VALUES (?1, ?2, ?3, ?4)",
            params![flight_id, snapshot.to_string(), request_id, linked_at_utc],
        )?;
        tx.execute("UPDATE dispatch_releases SET flight_id = ?2, linked_at_utc = ?3, open_slot = NULL WHERE release_id = ?1", params![release_id, flight_id, linked_at_utc])?;
        let out = tx.query_row(&format!("SELECT {RELEASE_COLUMNS} FROM dispatch_releases WHERE release_id = ?1"), [release_id], release_from_row)?;
        tx.commit()?;
        Ok(out)
    }

    pub fn list_releases(&self, limit: i64) -> Result<Vec<ReleaseOut>, StoreError> {
        let mut stmt = self.conn.prepare(&format!("SELECT {RELEASE_COLUMNS} FROM dispatch_releases ORDER BY released_at_utc DESC, created_at_utc DESC LIMIT ?1"))?;
        let rows = stmt.query_map([limit.clamp(1, 500)], release_from_row)?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn release_for_flight(&self, flight_id: &str) -> Result<Option<ReleaseOut>, StoreError> {
        Ok(self.conn.query_row(&format!("SELECT {RELEASE_COLUMNS} FROM dispatch_releases WHERE flight_id = ?1"), [flight_id], release_from_row).optional()?)
    }

    /// Record OUT or IN for a flight that is still open. The time is the pilot's explicit action;
    /// Turnline never derives these from telemetry. Recorded once; never replaced.
    pub fn record_milestone(&mut self, flight_id: &str, milestone: &str, occurred_at_utc: &str, clock_source: &str) -> Result<MilestoneOutcome, StoreError> {
        check_id("flightId", flight_id)?;
        if milestone != "out" && milestone != "in" {
            return Err(StoreError::invalid("milestone must be OUT or IN"));
        }
        if !MILESTONE_CLOCKS.contains(&clock_source) {
            return Err(StoreError::invalid("Manual milestones can only be recorded with the real-world UTC clock."));
        }
        check_ts("occurredAtUtc", occurred_at_utc)?;
        let tx = self.conn.transaction()?;
        let status: Option<String> = tx.query_row("SELECT status FROM flights WHERE id = ?1", [flight_id], |r| r.get(0)).optional()?;
        match status.as_deref() {
            None => return Err(StoreError::invalid("That flight has not been saved yet. Try again in a moment.")),
            Some("active") | Some("interrupted") => {}
            Some(_) => return Err(StoreError::invalid("OUT and IN can only be recorded while the flight is open.")),
        }
        if milestone == "in" {
            let out: Option<String> = tx.query_row("SELECT occurred_at_utc FROM flight_manual_milestones WHERE flight_id = ?1 AND milestone = 'out'", [flight_id], |r| r.get(0)).optional()?;
            if out.is_some_and(|o| o.as_str() > occurred_at_utc) {
                return Err(StoreError::invalid("IN cannot be earlier than the recorded OUT."));
            }
        }
        let inserted = tx.execute(
            "INSERT INTO flight_manual_milestones (flight_id, milestone, occurred_at_utc, recorded_at_utc, clock_source) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (flight_id, milestone) DO NOTHING",
            params![flight_id, milestone, occurred_at_utc, now_utc(), clock_source],
        )?;
        tx.commit()?;
        Ok(if inserted == 1 { MilestoneOutcome::Recorded } else { MilestoneOutcome::AlreadyRecorded })
    }

    pub fn milestones(&self, flight_id: &str) -> Result<Vec<MilestoneOut>, StoreError> {
        let mut stmt = self.conn.prepare("SELECT milestone, occurred_at_utc, recorded_at_utc, clock_source FROM flight_manual_milestones WHERE flight_id = ?1 ORDER BY milestone DESC")?;
        let rows = stmt
            .query_map([flight_id], |r| Ok(MilestoneOut { milestone: r.get(0)?, occurred_at_utc: r.get(1)?, recorded_at_utc: r.get(2)?, clock_source: r.get(3)? }))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
}
