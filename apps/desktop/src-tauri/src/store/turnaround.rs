//! GSX turnarounds (schema v6, S2-05). Local only.
//!
//! A turnaround is the ground handling at one airport for one side of a flight. A departure turnaround
//! may open before a flight is recorded. It is linked to a flight only when that is unambiguous (the
//! flight being recorded when the turnaround opened) or when the user confirms the link; never by airport
//! or registration.
//!
//! Service history keeps GSX observations and manual entries apart. A GSX row is written only for a
//! *valid* reading (state from GSX's documented enum) and only when the state changed; periods without
//! fresh GSX data are recorded as feed gaps, never filled in. Times are real-world UTC.

use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use super::{check_ts, new_uuid, now_utc_ms, Store, StoreError};

pub const SERVICES: &[&str] = &["boarding", "deboarding", "catering", "refueling", "pushback", "deice"];
/// GSX's documented service-state enum, index + 1 = the L: variable value.
pub const GSX_STATES: &[&str] = &["can_be_called", "not_available", "bypassed", "requested", "being_performed", "completed"];
pub const MANUAL_STATUSES: &[&str] = &["started", "completed", "not_required"];
pub const FEEDS: &[&str] = &["live", "stale", "not_detected", "sim_not_connected", "app_restarted"];
const MAX_NOTE: usize = 500;
const MAX_REASON: usize = 200;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceEventOut {
    pub id: i64,
    pub service: String,
    pub source: String,
    pub gsx_state: Option<String>,
    pub gsx_raw: Option<f64>,
    pub manual_status: Option<String>,
    pub note: Option<String>,
    pub observed_at_utc: String,
    pub recorded_at_utc: String,
    pub clock_source: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FeedLogOut {
    pub feed: String,
    pub at_utc: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TurnaroundOut {
    pub id: String,
    pub side: String,
    pub status: String,
    pub flight_id: Option<String>,
    pub flight_link: String,
    pub airport_icao: Option<String>,
    pub airport_source: Option<String>,
    pub gate_text: Option<String>,
    pub gate_source: Option<String>,
    pub opened_at_utc: String,
    pub closed_at_utc: Option<String>,
    pub close_reason: Option<String>,
    pub events: Vec<ServiceEventOut>,
    pub feed_log: Vec<FeedLogOut>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnaroundOpen {
    pub side: String,
    pub airport_icao: Option<String>,
    /// "plan" or "user"; required with an airport.
    pub airport_source: Option<String>,
    pub gate_text: Option<String>,
}

fn invalid(m: impl Into<String>) -> StoreError {
    StoreError::invalid(m)
}

fn check_one(name: &str, v: &str, allowed: &[&str]) -> Result<(), StoreError> {
    if allowed.contains(&v) { Ok(()) } else { Err(invalid(format!("{name} has an unsupported value"))) }
}

pub(crate) fn check_id(name: &str, v: &str) -> Result<(), StoreError> {
    if v.is_empty() || v.len() > 64 || !v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(invalid(format!("{name} is invalid")));
    }
    Ok(())
}

pub(crate) fn check_note(name: &str, v: &str, max: usize) -> Result<String, StoreError> {
    let t = v.trim();
    if t.is_empty() || t.chars().count() > max || t.chars().any(|c| c.is_control() && c != '\n') {
        return Err(invalid(format!("{name} must be 1-{max} characters")));
    }
    Ok(t.to_string())
}

const COLUMNS: &str = "id, side, status, flight_id, flight_link, airport_icao, airport_source, gate_text, gate_source, opened_at_utc, closed_at_utc, close_reason";

impl Store {
    fn turnaround_row(&self, where_sql: &str, p: &[&dyn rusqlite::ToSql]) -> Result<Vec<TurnaroundOut>, StoreError> {
        let mut stmt = self.conn.prepare(&format!("SELECT {COLUMNS} FROM turnarounds WHERE {where_sql}"))?;
        let rows = stmt
            .query_map(p, |r| {
                Ok(TurnaroundOut {
                    id: r.get(0)?,
                    side: r.get(1)?,
                    status: r.get(2)?,
                    flight_id: r.get(3)?,
                    flight_link: r.get(4)?,
                    airport_icao: r.get(5)?,
                    airport_source: r.get(6)?,
                    gate_text: r.get(7)?,
                    gate_source: r.get(8)?,
                    opened_at_utc: r.get(9)?,
                    closed_at_utc: r.get(10)?,
                    close_reason: r.get(11)?,
                    events: vec![],
                    feed_log: vec![],
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().map(|t| self.with_history(t)).collect()
    }

    fn with_history(&self, mut t: TurnaroundOut) -> Result<TurnaroundOut, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, service, source, gsx_state, gsx_raw, manual_status, note, observed_at_utc, recorded_at_utc, clock_source \
             FROM turnaround_service_events WHERE turnaround_id = ?1 ORDER BY id",
        )?;
        t.events = stmt
            .query_map([&t.id], |r| {
                Ok(ServiceEventOut {
                    id: r.get(0)?,
                    service: r.get(1)?,
                    source: r.get(2)?,
                    gsx_state: r.get(3)?,
                    gsx_raw: r.get(4)?,
                    manual_status: r.get(5)?,
                    note: r.get(6)?,
                    observed_at_utc: r.get(7)?,
                    recorded_at_utc: r.get(8)?,
                    clock_source: r.get(9)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut stmt = self.conn.prepare("SELECT feed, at_utc FROM turnaround_feed_log WHERE turnaround_id = ?1 ORDER BY id")?;
        t.feed_log = stmt.query_map([&t.id], |r| Ok(FeedLogOut { feed: r.get(0)?, at_utc: r.get(1)? }))?.collect::<Result<Vec<_>, _>>()?;
        Ok(t)
    }

    pub fn turnaround_get(&self, id: &str) -> Result<TurnaroundOut, StoreError> {
        check_id("turnaroundId", id)?;
        self.turnaround_row("id = ?1", &[&id])?.pop().ok_or_else(|| invalid("That turnaround does not exist."))
    }

    /// The unfinished (open or interrupted) turnaround, if any.
    pub fn turnaround_current(&self) -> Result<Option<TurnaroundOut>, StoreError> {
        Ok(self.turnaround_row("open_slot = 1", &[])?.pop())
    }

    pub fn turnarounds_for_flight(&self, flight_id: &str) -> Result<Vec<TurnaroundOut>, StoreError> {
        check_id("flightId", flight_id)?;
        self.turnaround_row("flight_id = ?1 ORDER BY opened_at_utc", &[&flight_id])
    }

    pub fn turnarounds_recent(&self, limit: i64) -> Result<Vec<TurnaroundOut>, StoreError> {
        let limit = limit.clamp(1, 200);
        self.turnaround_row("1 = 1 ORDER BY opened_at_utc DESC LIMIT ?1", &[&limit])
    }

    /// Open a turnaround. Linked to the flight being recorded, if exactly that one is open; otherwise unlinked.
    pub fn turnaround_open(&mut self, req: &TurnaroundOpen) -> Result<TurnaroundOut, StoreError> {
        check_one("side", &req.side, &["departure", "arrival"])?;
        let airport = match (&req.airport_icao, &req.airport_source) {
            (None, None) => None,
            (Some(a), Some(src)) => {
                let a = a.trim().to_ascii_uppercase();
                if !(3..=4).contains(&a.len()) || !a.chars().all(|c| c.is_ascii_alphanumeric()) {
                    return Err(invalid("airport must be a 3-4 character code"));
                }
                check_one("airportSource", src, &["plan", "user"])?;
                Some((a, src.clone()))
            }
            _ => return Err(invalid("airport and airportSource go together")),
        };
        let gate = match &req.gate_text {
            None => None,
            Some(g) => Some(check_note("gate", g, 32)?),
        };
        let tx = self.conn.transaction()?;
        if tx.query_row("SELECT 1 FROM turnarounds WHERE open_slot = 1", [], |_| Ok(())).optional()?.is_some() {
            return Err(invalid("Finish the current turnaround before starting another."));
        }
        let recording: Option<String> = tx.query_row("SELECT id FROM flights WHERE profile_id = 'local' AND open_slot = 1", [], |r| r.get(0)).optional()?;
        let id = new_uuid()?;
        let link = if recording.is_some() { "recording_at_open" } else { "unlinked" };
        tx.execute(
            "INSERT INTO turnarounds (id, side, status, flight_id, flight_link, airport_icao, airport_source, gate_text, gate_source, opened_at_utc, open_slot) \
             VALUES (?1, ?2, 'open', ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1)",
            params![
                id,
                req.side,
                recording,
                link,
                airport.as_ref().map(|a| a.0.clone()),
                airport.as_ref().map(|a| a.1.clone()),
                gate,
                gate.as_ref().map(|_| "user"),
                now_utc_ms()
            ],
        )?;
        tx.commit()?;
        self.turnaround_get(&id)
    }

    fn unfinished(&self, id: &str) -> Result<String, StoreError> {
        check_id("turnaroundId", id)?;
        let status: Option<String> = self.conn.query_row("SELECT status FROM turnarounds WHERE id = ?1", [id], |r| r.get(0)).optional()?;
        match status {
            None => Err(invalid("That turnaround does not exist.")),
            Some(s) if s == "open" || s == "interrupted" => Ok(s),
            Some(_) => Err(invalid("That turnaround is finished.")),
        }
    }

    /// Record one valid GSX observation. Only a change of state is stored; returns whether a row was added.
    /// The raw value must be the documented enum value of the state (1-6).
    pub fn turnaround_record_gsx(&mut self, id: &str, service: &str, state: &str, raw: f64, observed_at_utc: &str) -> Result<bool, StoreError> {
        if self.unfinished(id)? != "open" {
            return Err(invalid("Resume the turnaround before recording GSX observations."));
        }
        check_one("service", service, SERVICES)?;
        check_one("state", state, GSX_STATES)?;
        let expected = GSX_STATES.iter().position(|s| *s == state).map(|i| i as f64 + 1.0);
        if expected != Some(raw) {
            return Err(invalid("GSX raw value does not match the state"));
        }
        check_ts("observedAtUtc", observed_at_utc)?;
        let last: Option<String> = self
            .conn
            .query_row(
                "SELECT gsx_state FROM turnaround_service_events WHERE turnaround_id = ?1 AND service = ?2 AND source = 'gsx' ORDER BY id DESC LIMIT 1",
                params![id, service],
                |r| r.get(0),
            )
            .optional()?;
        if last.as_deref() == Some(state) {
            return Ok(false);
        }
        self.conn.execute(
            "INSERT INTO turnaround_service_events (turnaround_id, service, source, gsx_state, gsx_raw, observed_at_utc, recorded_at_utc) VALUES (?1, ?2, 'gsx', ?3, ?4, ?5, ?6)",
            params![id, service, state, raw, observed_at_utc, now_utc_ms()],
        )?;
        Ok(true)
    }

    /// Record a change of GSX feed availability while the turnaround is unfinished; returns whether it was new.
    pub fn turnaround_record_feed(&mut self, id: &str, feed: &str) -> Result<bool, StoreError> {
        self.unfinished(id)?;
        check_one("feed", feed, FEEDS)?;
        let last: Option<String> = self
            .conn
            .query_row("SELECT feed FROM turnaround_feed_log WHERE turnaround_id = ?1 ORDER BY id DESC LIMIT 1", [id], |r| r.get(0))
            .optional()?;
        if last.as_deref() == Some(feed) {
            return Ok(false);
        }
        self.conn.execute("INSERT INTO turnaround_feed_log (turnaround_id, feed, at_utc) VALUES (?1, ?2, ?3)", params![id, feed, now_utc_ms()])?;
        Ok(true)
    }

    /// The user's explicit service entry, with a required note. Time is the computer's real-world UTC.
    pub fn turnaround_record_manual(&mut self, id: &str, service: &str, status: &str, note: &str) -> Result<TurnaroundOut, StoreError> {
        if self.unfinished(id)? != "open" {
            return Err(invalid("Resume the turnaround before recording services."));
        }
        check_one("service", service, SERVICES)?;
        check_one("status", status, MANUAL_STATUSES)?;
        let note = check_note("note", note, MAX_NOTE)?;
        let now = now_utc_ms();
        self.conn.execute(
            "INSERT INTO turnaround_service_events (turnaround_id, service, source, manual_status, note, observed_at_utc, recorded_at_utc) VALUES (?1, ?2, 'manual', ?3, ?4, ?5, ?5)",
            params![id, service, status, note, now],
        )?;
        self.turnaround_get(id)
    }

    /// close / abandon (final), interrupt, or resume an interrupted turnaround.
    pub fn turnaround_set_status(&mut self, id: &str, action: &str, reason: Option<&str>) -> Result<TurnaroundOut, StoreError> {
        let current = self.unfinished(id)?;
        let now = now_utc_ms();
        match action {
            "close" | "abandon" => {
                let reason = match reason {
                    Some(r) => Some(check_note("reason", r, MAX_REASON)?),
                    None if action == "abandon" => return Err(invalid("Give a reason for abandoning the turnaround.")),
                    None => None,
                };
                let status = if action == "close" { "closed" } else { "abandoned" };
                self.conn.execute(
                    "UPDATE turnarounds SET status = ?2, closed_at_utc = ?3, close_reason = ?4, open_slot = NULL WHERE id = ?1",
                    params![id, status, now, reason],
                )?;
            }
            "interrupt" => {
                self.conn.execute("UPDATE turnarounds SET status = 'interrupted' WHERE id = ?1", [id])?;
            }
            "resume" => {
                if current != "interrupted" {
                    return Err(invalid("Only an interrupted turnaround can be resumed."));
                }
                self.conn.execute("UPDATE turnarounds SET status = 'open' WHERE id = ?1", [id])?;
            }
            _ => return Err(invalid("action has an unsupported value")),
        }
        self.turnaround_get(id)
    }

    /// After an app restart an open turnaround is marked interrupted (the feed was not observed meanwhile)
    /// and the restart is logged. The user resumes, closes or abandons it.
    pub fn turnaround_mark_restarted(&mut self) -> Result<Option<TurnaroundOut>, StoreError> {
        let Some(t) = self.turnaround_current()? else { return Ok(None) };
        if t.status == "open" {
            self.conn.execute("UPDATE turnarounds SET status = 'interrupted' WHERE id = ?1", [&t.id])?;
        }
        self.turnaround_record_feed(&t.id, "app_restarted")?;
        Ok(Some(self.turnaround_get(&t.id)?))
    }

    /// The user's explicit link of a turnaround to a recorded flight. Written once.
    pub fn turnaround_link_flight(&mut self, id: &str, flight_id: &str) -> Result<TurnaroundOut, StoreError> {
        check_id("turnaroundId", id)?;
        check_id("flightId", flight_id)?;
        let tx = self.conn.transaction()?;
        let linked: Option<Option<String>> = tx.query_row("SELECT flight_id FROM turnarounds WHERE id = ?1", [id], |r| r.get(0)).optional()?;
        match linked {
            None => return Err(invalid("That turnaround does not exist.")),
            Some(Some(f)) if f == flight_id => {}
            Some(Some(_)) => return Err(invalid("That turnaround is already linked to another flight.")),
            Some(None) => {
                if tx.query_row("SELECT 1 FROM flights WHERE id = ?1", [flight_id], |_| Ok(())).optional()?.is_none() {
                    return Err(invalid("That flight does not exist."));
                }
                tx.execute("UPDATE turnarounds SET flight_id = ?2, flight_link = 'user_confirmed' WHERE id = ?1", params![id, flight_id])?;
            }
        }
        tx.commit()?;
        self.turnaround_get(id)
    }
}
