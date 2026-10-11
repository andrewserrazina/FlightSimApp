//! Opt-in cloud sync bookkeeping (local SQLite, schema v2).
//!
//! Account binding rules (enforced here, not just in the UI):
//! * Sync is off until the user enables it while signed in; enabling binds an account and records
//!   the opt-in time. Re-binding to a different account starts a new opt-in.
//! * Only `completed` flights can be queued. A flight's `account_id` is fixed when it is queued and
//!   is never changed, so signing into another account can never transfer existing flights.
//! * Flights recorded before the opt-in are queued only through an explicit backfill (user consent).
//! * Nothing here deletes or rewrites local flight data.

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::{check_ts, now_utc, Store, StoreError};

pub const STATES: &[&str] = &["pending", "uploading", "synced", "failed", "retry_pending"];
const MAX_ERROR_LEN: usize = 300;
const MAX_ID_LEN: usize = 64;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlightSyncOut {
    pub state: String,
    pub account_id: String,
    pub synced_at_utc: Option<String>,
    pub last_error: Option<String>,
    pub attempts: i64,
    pub next_attempt_at_utc: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncSettingsOut {
    pub enabled: bool,
    pub bound_account_id: Option<String>,
    pub bound_account_label: Option<String>,
    pub opted_in_at_utc: Option<String>,
    pub last_success_at_utc: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncOverviewOut {
    pub pending: i64,
    pub uploading: i64,
    pub synced: i64,
    pub failed: i64,
    pub retry_pending: i64,
    /// Completed flights not queued for any account (local only; can be backfilled with consent).
    pub local_only_completed: i64,
    /// Flights queued for an account other than the bound one (never uploaded under the current binding).
    pub other_account: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DueItemOut {
    pub flight_id: String,
    pub attempts: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncMark {
    pub flight_id: String,
    pub account_id: String,
    pub state: String,
    #[serde(default)]
    pub attempts: Option<i64>,
    #[serde(default)]
    pub next_attempt_at_utc: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub cloud_event_count: Option<i64>,
    #[serde(default)]
    pub cloud_interruption_count: Option<i64>,
}

fn check_id(name: &str, v: &str) -> Result<(), StoreError> {
    if v.is_empty() || v.len() > MAX_ID_LEN || !v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(StoreError::invalid(format!("{name} is invalid")));
    }
    Ok(())
}

impl Store {
    pub fn sync_settings(&self) -> Result<SyncSettingsOut, StoreError> {
        Ok(self.conn.query_row(
            "SELECT enabled, bound_account_id, bound_account_label, opted_in_at_utc, last_success_at_utc FROM sync_settings WHERE id = 1",
            [],
            |r| {
                Ok(SyncSettingsOut {
                    enabled: r.get::<_, i64>(0)? == 1,
                    bound_account_id: r.get(1)?,
                    bound_account_label: r.get(2)?,
                    opted_in_at_utc: r.get(3)?,
                    last_success_at_utc: r.get(4)?,
                })
            },
        )?)
    }

    /// Enable sync for `account_id`. Binding to a different account than before starts a fresh
    /// opt-in (new `opted_in_at`); flights queued for the previous account keep their account.
    pub fn sync_enable(&mut self, account_id: &str, account_label: &str) -> Result<SyncSettingsOut, StoreError> {
        check_id("accountId", account_id)?;
        let label: String = account_label.chars().take(128).collect();
        let current = self.sync_settings()?;
        let now = now_utc();
        if current.bound_account_id.as_deref() == Some(account_id) {
            self.conn.execute("UPDATE sync_settings SET enabled = 1, bound_account_label = ?1, updated_at_utc = ?2 WHERE id = 1", params![label, now])?;
        } else {
            self.conn.execute(
                "UPDATE sync_settings SET enabled = 1, bound_account_id = ?1, bound_account_label = ?2, opted_in_at_utc = ?3, last_success_at_utc = NULL, updated_at_utc = ?3 WHERE id = 1",
                params![account_id, label, now],
            )?;
        }
        self.sync_settings()
    }

    /// Turn sync off. The binding is kept so re-enabling with the same account continues.
    pub fn sync_disable(&mut self) -> Result<SyncSettingsOut, StoreError> {
        self.conn.execute("UPDATE sync_settings SET enabled = 0, updated_at_utc = ?1 WHERE id = 1", [now_utc()])?;
        self.sync_settings()
    }

    /// Queue completed flights that ended after the opt-in for the bound account (idempotent; also
    /// catches flights completed while the app crashed before queueing). Returns how many were added.
    pub fn sync_enqueue_after_opt_in(&mut self, account_id: &str) -> Result<usize, StoreError> {
        check_id("accountId", account_id)?;
        let s = self.sync_settings()?;
        if !s.enabled || s.bound_account_id.as_deref() != Some(account_id) {
            return Ok(0);
        }
        let opted = s.opted_in_at_utc.unwrap_or_default();
        Ok(self.conn.execute(
            "INSERT INTO flight_sync (flight_id, account_id, consent, state, queued_at_utc) \
             SELECT f.id, ?1, 'recorded_after_opt_in', 'pending', ?2 FROM flights f \
             WHERE f.status = 'completed' AND f.ended_at_utc IS NOT NULL AND julianday(f.ended_at_utc) >= julianday(?3) \
               AND NOT EXISTS (SELECT 1 FROM flight_sync x WHERE x.flight_id = f.id)",
            params![account_id, now_utc(), opted],
        )?)
    }

    /// Explicit, user-consented upload of earlier local-only flights to the bound account.
    /// Flights already queued (for any account) are left untouched.
    pub fn sync_backfill(&mut self, account_id: &str, flight_ids: &[String]) -> Result<usize, StoreError> {
        check_id("accountId", account_id)?;
        if flight_ids.len() > 1000 {
            return Err(StoreError::invalid("too many flights"));
        }
        let s = self.sync_settings()?;
        if !s.enabled || s.bound_account_id.as_deref() != Some(account_id) {
            return Err(StoreError::invalid("Cloud sync must be enabled for this account first."));
        }
        let tx = self.conn.transaction()?;
        let now = now_utc();
        let mut added = 0;
        {
            let mut ins = tx.prepare(
                "INSERT INTO flight_sync (flight_id, account_id, consent, state, queued_at_utc) \
                 SELECT f.id, ?1, 'explicit_backfill', 'pending', ?2 FROM flights f \
                 WHERE f.id = ?3 AND f.status = 'completed' AND NOT EXISTS (SELECT 1 FROM flight_sync x WHERE x.flight_id = f.id)",
            )?;
            for id in flight_ids {
                check_id("flightId", id)?;
                added += ins.execute(params![account_id, now, id])?;
            }
        }
        tx.commit()?;
        Ok(added)
    }

    /// Items ready to upload for this account, oldest first.
    pub fn sync_due(&self, account_id: &str, now: &str, limit: i64) -> Result<Vec<DueItemOut>, StoreError> {
        check_id("accountId", account_id)?;
        check_ts("now", now)?;
        let mut stmt = self.conn.prepare(
            "SELECT flight_id, attempts FROM flight_sync WHERE account_id = ?1 AND state IN ('pending','retry_pending') \
             AND (next_attempt_at_utc IS NULL OR julianday(next_attempt_at_utc) <= julianday(?2)) ORDER BY queued_at_utc, flight_id LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![account_id, now, limit.clamp(1, 50)], |r| Ok(DueItemOut { flight_id: r.get(0)?, attempts: r.get(1)? }))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Record a state change. The account must match the flight's binding (no transfer).
    pub fn sync_mark(&mut self, m: &SyncMark) -> Result<(), StoreError> {
        check_id("flightId", &m.flight_id)?;
        check_id("accountId", &m.account_id)?;
        if !STATES.contains(&m.state.as_str()) {
            return Err(StoreError::invalid("state has an unsupported value"));
        }
        if let Some(t) = &m.next_attempt_at_utc {
            check_ts("nextAttemptAtUtc", t)?;
        }
        let err: Option<String> = m.last_error.as_ref().map(|e| e.chars().take(MAX_ERROR_LEN).collect());
        let now = now_utc();
        let synced_at = (m.state == "synced").then(|| now.clone());
        let tx = self.conn.transaction()?;
        let changed = tx.execute(
            "UPDATE flight_sync SET state = ?3, attempts = COALESCE(?4, attempts), next_attempt_at_utc = ?5, last_error = ?6, \
               last_attempt_at_utc = CASE WHEN ?3 = 'uploading' THEN ?7 ELSE last_attempt_at_utc END, \
               synced_at_utc = ?8, cloud_event_count = COALESCE(?9, cloud_event_count), cloud_interruption_count = COALESCE(?10, cloud_interruption_count) \
             WHERE flight_id = ?1 AND account_id = ?2",
            params![m.flight_id, m.account_id, m.state, m.attempts, m.next_attempt_at_utc, err, now, synced_at, m.cloud_event_count, m.cloud_interruption_count],
        )?;
        if changed == 0 {
            return Err(StoreError::invalid("flight is not queued for this account"));
        }
        if m.state == "synced" {
            tx.execute("UPDATE sync_settings SET last_success_at_utc = ?1 WHERE id = 1 AND bound_account_id = ?2", params![now, m.account_id])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// User-requested retry of failed items for this account.
    pub fn sync_retry_failed(&mut self, account_id: &str) -> Result<usize, StoreError> {
        check_id("accountId", account_id)?;
        Ok(self.conn.execute(
            "UPDATE flight_sync SET state = 'pending', attempts = 0, next_attempt_at_utc = NULL, last_error = NULL WHERE account_id = ?1 AND state IN ('failed','retry_pending')",
            [account_id],
        )?)
    }

    /// Startup recovery: an upload interrupted by a crash is safe to retry (the cloud write is idempotent).
    pub fn sync_recover_interrupted(&mut self) -> Result<usize, StoreError> {
        Ok(self.conn.execute("UPDATE flight_sync SET state = 'retry_pending', next_attempt_at_utc = NULL WHERE state = 'uploading'", [])?)
    }

    pub fn sync_overview(&self) -> Result<SyncOverviewOut, StoreError> {
        let bound: Option<String> = self.conn.query_row("SELECT bound_account_id FROM sync_settings WHERE id = 1", [], |r| r.get(0)).optional()?.flatten();
        let mut o = SyncOverviewOut::default();
        let mut stmt = self.conn.prepare("SELECT state, account_id, COUNT(*) FROM flight_sync GROUP BY state, account_id")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))?;
        for row in rows {
            let (state, account, n) = row?;
            if bound.as_deref() != Some(account.as_str()) {
                o.other_account += n;
                continue;
            }
            match state.as_str() {
                "pending" => o.pending += n,
                "uploading" => o.uploading += n,
                "synced" => o.synced += n,
                "failed" => o.failed += n,
                "retry_pending" => o.retry_pending += n,
                _ => {}
            }
        }
        o.local_only_completed = self.conn.query_row(
            "SELECT COUNT(*) FROM flights f WHERE f.status = 'completed' AND NOT EXISTS (SELECT 1 FROM flight_sync x WHERE x.flight_id = f.id)",
            [],
            |r| r.get(0),
        )?;
        Ok(o)
    }

    /// IDs of completed flights that are local-only (candidates for an explicit backfill).
    pub fn sync_local_only_ids(&self) -> Result<Vec<String>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT f.id FROM flights f WHERE f.status = 'completed' AND NOT EXISTS (SELECT 1 FROM flight_sync x WHERE x.flight_id = f.id) ORDER BY f.started_at_utc LIMIT 1000",
        )?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
}
