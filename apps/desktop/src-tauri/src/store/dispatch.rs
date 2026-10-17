//! Dispatch persistence (schema v3): the latest imported flight plan and per-flight immutable
//! plan snapshots. Payloads are Turnline's normalized plan model (validated again in TypeScript on
//! read); here they are checked for shape and size only.

use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use super::{check_ts, now_utc, Store, StoreError};

/// Normalized plans are a few KB, or up to several hundred KB with a long-haul navlog (S2-03,
/// at most 1500 fixes). The raw SimBrief response is never stored.
pub const MAX_PLAN_BYTES: usize = 1024 * 1024;
const MAX_ID: usize = 64;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoredPlanOut {
    pub plan: serde_json::Value,
    pub imported_at_utc: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotOut {
    pub snapshot: serde_json::Value,
    pub associated_at_utc: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AssociateOutcome {
    Created,
    /// The flight already has a snapshot; it was left unchanged.
    AlreadyAssociated,
}

fn check_plan(name: &str, v: &serde_json::Value, schema: &str) -> Result<String, StoreError> {
    let obj = v.as_object().ok_or_else(|| StoreError::invalid(format!("{name} must be a JSON object")))?;
    if obj.get("schema").and_then(|s| s.as_str()) != Some(schema) {
        return Err(StoreError::invalid(format!("{name} has an unknown schema")));
    }
    let text = serde_json::to_string(v).map_err(|e| StoreError::invalid(format!("{name}: {e}")))?;
    if text.len() > MAX_PLAN_BYTES {
        return Err(StoreError::invalid(format!("{name} is too large")));
    }
    Ok(text)
}

fn request_id(plan: &serde_json::Value) -> Option<String> {
    plan.pointer("/source/requestId").and_then(|v| v.as_str()).filter(|s| !s.is_empty() && s.len() <= MAX_ID).map(str::to_string)
}

impl Store {
    pub fn dispatch_plan(&self) -> Result<Option<StoredPlanOut>, StoreError> {
        let row: Option<(String, String)> = self
            .conn
            .query_row("SELECT plan_json, imported_at_utc FROM dispatch_plan WHERE id = 1", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?;
        // A row that no longer parses is returned as JSON null so the UI can report a corrupt cache.
        Ok(row.map(|(json, at)| StoredPlanOut { plan: serde_json::from_str(&json).unwrap_or(serde_json::Value::Null), imported_at_utc: at }))
    }

    pub fn save_dispatch_plan(&mut self, plan: &serde_json::Value, imported_at_utc: &str) -> Result<(), StoreError> {
        check_ts("importedAtUtc", imported_at_utc)?;
        let json = check_plan("plan", plan, "turnline.flight_plan")?;
        self.conn.execute(
            "INSERT INTO dispatch_plan (id, plan_json, source_request_id, imported_at_utc, updated_at_utc) VALUES (1, ?1, ?2, ?3, ?4)
             ON CONFLICT (id) DO UPDATE SET plan_json = excluded.plan_json, source_request_id = excluded.source_request_id,
               imported_at_utc = excluded.imported_at_utc, updated_at_utc = excluded.updated_at_utc",
            params![json, request_id(plan), imported_at_utc, now_utc()],
        )?;
        Ok(())
    }

    pub fn clear_dispatch_plan(&mut self) -> Result<(), StoreError> {
        self.conn.execute("DELETE FROM dispatch_plan WHERE id = 1", [])?;
        Ok(())
    }

    /// Attach an immutable snapshot to a recorded flight. Never replaces an existing snapshot.
    pub fn associate_plan(&mut self, flight_id: &str, snapshot: &serde_json::Value) -> Result<AssociateOutcome, StoreError> {
        if flight_id.is_empty() || flight_id.len() > MAX_ID {
            return Err(StoreError::invalid("flightId is invalid"));
        }
        let json = check_plan("snapshot", snapshot, "turnline.flight_plan_snapshot")?;
        if snapshot.get("flightId").and_then(|v| v.as_str()) != Some(flight_id) {
            return Err(StoreError::invalid("snapshot belongs to a different flight"));
        }
        let at = snapshot.get("associatedAtUtc").and_then(|v| v.as_str()).ok_or_else(|| StoreError::invalid("snapshot.associatedAtUtc is required"))?.to_string();
        check_ts("associatedAtUtc", &at)?;
        let tx = self.conn.transaction()?;
        let exists: bool = tx.query_row("SELECT EXISTS (SELECT 1 FROM flights WHERE id = ?1)", [flight_id], |r| r.get(0))?;
        if !exists {
            return Err(StoreError::invalid("That flight has not been saved yet. Try again in a moment."));
        }
        let inserted = tx.execute(
            "INSERT INTO flight_plan_snapshots (flight_id, snapshot_json, source_request_id, associated_at_utc) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (flight_id) DO NOTHING",
            params![flight_id, json, snapshot.get("plan").and_then(request_id), at],
        )?;
        tx.commit()?;
        Ok(if inserted == 1 { AssociateOutcome::Created } else { AssociateOutcome::AlreadyAssociated })
    }

    pub fn plan_snapshot(&self, flight_id: &str) -> Result<Option<SnapshotOut>, StoreError> {
        let row: Option<(String, String)> = self
            .conn
            .query_row("SELECT snapshot_json, associated_at_utc FROM flight_plan_snapshots WHERE flight_id = ?1", [flight_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?;
        Ok(row.map(|(json, at)| SnapshotOut { snapshot: serde_json::from_str(&json).unwrap_or(serde_json::Value::Null), associated_at_utc: at }))
    }
}
