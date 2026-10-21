//! Local SQLite flight store (S1-04).
//!
//! * One connection, owned by a dedicated writer thread (`actor.rs`); the UI thread and the
//!   telemetry relay never touch SQLite directly.
//! * Versioned migrations recorded in `schema_migrations` (and `PRAGMA user_version`).
//! * The webview gets a fixed, validated API — never raw SQL.
//! * A database that cannot be opened safely is reported as unavailable with an actionable
//!   message; it is never deleted. `reset_damaged` moves it aside (kept on disk) and starts fresh.

pub mod actor;
pub mod commands;
pub mod dispatch;
pub mod ledger;
pub mod release;
pub mod sync;
pub mod turnaround;
pub mod watch;

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, ErrorCode, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};

pub const DB_FILE: &str = "flightsim.db";

/// (version, SQL). Append only; never edit a released migration.
const MIGRATIONS: &[(i64, &str)] = &[
    (1, include_str!("../../migrations/0001_local_flight_store.sql")),
    (2, include_str!("../../migrations/0002_cloud_sync.sql")),
    (3, include_str!("../../migrations/0003_dispatch.sql")),
    (4, include_str!("../../migrations/0004_dispatch_release.sql")),
    (5, include_str!("../../migrations/0005_manual_milestone_clock.sql")),
    (6, include_str!("../../migrations/0006_turnaround_ledger.sql")),
    (7, include_str!("../../migrations/0007_receipt_watcher.sql")),
];

pub fn latest_schema_version() -> i64 {
    MIGRATIONS.last().map(|m| m.0).unwrap_or(0)
}

const MAX_EVENTS_PER_COMMIT: usize = 500;
const MAX_SAMPLES_PER_COMMIT: usize = 2_000;
const MAX_INTERRUPTIONS_PER_COMMIT: usize = 50;
const MAX_JSON_BYTES: usize = 64 * 1024;
const MAX_DETAILS_BYTES: usize = 4 * 1024;
const MAX_TEXT: usize = 256;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum StoreErrorKind {
    /// File exists but is not a valid/healthy SQLite database.
    Corrupt,
    /// Written by a newer FlightSimApp; not touched.
    NewerSchema,
    /// Filesystem / permission / disk problems.
    Io,
    /// Request rejected by validation (bad input from the webview).
    Invalid,
    /// Other SQLite error.
    Database,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreError {
    pub kind: StoreErrorKind,
    pub message: String,
}

impl StoreError {
    fn new(kind: StoreErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }
    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Self::new(StoreErrorKind::Invalid, message)
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        match e.sqlite_error_code() {
            Some(ErrorCode::NotADatabase) | Some(ErrorCode::DatabaseCorrupt) => {
                Self::new(StoreErrorKind::Corrupt, "The flight database is damaged and cannot be read.")
            }
            Some(ErrorCode::CannotOpen) | Some(ErrorCode::PermissionDenied) | Some(ErrorCode::ReadOnly) | Some(ErrorCode::DiskFull) | Some(ErrorCode::SystemIoFailure) => {
                Self::new(StoreErrorKind::Io, format!("The flight database could not be written: {e}"))
            }
            Some(ErrorCode::ConstraintViolation) => Self::invalid(format!("Rejected by database constraints: {e}")),
            _ => Self::new(StoreErrorKind::Database, e.to_string()),
        }
    }
}

// ---------- API types (camelCase JSON, mirrored in apps/desktop/src/recording/types.ts) ----------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlightRow {
    pub id: String,
    pub status: String,
    pub completion: Option<String>,
    pub phase: String,
    pub simulator: String,
    pub simulator_version: Option<String>,
    pub aircraft_title: Option<String>,
    pub aircraft_icao: Option<String>,
    pub origin_icao: Option<String>,
    pub destination_icao: Option<String>,
    pub started_at_utc: String,
    pub ended_at_utc: Option<String>,
    pub last_seen_at_utc: String,
    pub takeoff_at_utc: Option<String>,
    pub landing_at_utc: Option<String>,
    pub airborne_seconds: f64,
    pub started_airborne: bool,
    /// Opaque engine snapshot (JSON).
    pub engine_state: String,
    /// Opaque availability counters (JSON).
    pub stats: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EventRow {
    pub seq: i64,
    pub event_id: String,
    pub kind: String,
    pub occurred_at_utc: String,
    pub source: String,
    pub from_phase: Option<String>,
    pub to_phase: Option<String>,
    /// JSON object.
    pub details: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InterruptionRow {
    pub started_at_utc: String,
    pub ended_at_utc: Option<String>,
    pub cause: String,
    pub resolution: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SampleRow {
    pub seq: i64,
    pub observed_at_utc: String,
    pub phase: String,
    pub reason: String,
    pub on_ground: Option<bool>,
    pub lat_deg: Option<f64>,
    pub lon_deg: Option<f64>,
    pub indicated_alt_ft: Option<f64>,
    pub radio_alt_ft: Option<f64>,
    pub ground_speed_kt: Option<f64>,
    pub indicated_kt: Option<f64>,
    pub vertical_fpm: Option<f64>,
    pub heading_deg: Option<f64>,
    pub fuel_kg: Option<f64>,
}

/// Everything one recorder flush changes, applied atomically (all or nothing) and idempotently
/// (events/samples keyed by (flight, seq); interruptions by (flight, started_at)).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitBatch {
    pub flight: FlightRow,
    #[serde(default)]
    pub events: Vec<EventRow>,
    #[serde(default)]
    pub samples: Vec<SampleRow>,
    #[serde(default)]
    pub interruptions: Vec<InterruptionRow>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlightSummaryOut {
    pub id: String,
    pub status: String,
    pub completion: Option<String>,
    pub phase: String,
    pub simulator: String,
    pub simulator_version: Option<String>,
    pub aircraft_title: Option<String>,
    pub aircraft_icao: Option<String>,
    pub origin_icao: Option<String>,
    pub destination_icao: Option<String>,
    pub started_at_utc: String,
    pub ended_at_utc: Option<String>,
    pub last_seen_at_utc: String,
    pub takeoff_at_utc: Option<String>,
    pub landing_at_utc: Option<String>,
    pub airborne_seconds: f64,
    pub started_airborne: bool,
    pub interruption_count: i64,
    pub sample_count: i64,
    /// Cloud sync bookkeeping for this flight, if it was ever queued.
    pub sync: Option<sync::FlightSyncOut>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventOut {
    pub seq: i64,
    pub event_id: String,
    pub kind: String,
    pub occurred_at_utc: String,
    pub source: String,
    pub from_phase: Option<String>,
    pub to_phase: Option<String>,
    pub details: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightDetailOut {
    pub summary: FlightSummaryOut,
    pub events: Vec<EventOut>,
    pub interruptions: Vec<InterruptionRow>,
    pub stats: serde_json::Value,
    pub samples_pruned: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenFlightOut {
    pub flight: FlightRow,
}

// ---------- validation ----------

const STATUSES: &[&str] = &["active", "interrupted", "completed", "aborted", "discarded"];
const SOURCES: &[&str] = &["detected", "user", "system"];
const SIMULATORS: &[&str] = &["mock", "msfs2020", "msfs2024"];
const COMPLETIONS: &[&str] = &["arrival_confirmed", "landing_confirmed", "user_confirmed_without_evidence"];
const PHASES: &[&str] = &["NOT_STARTED", "PREPARING", "TAXI_OUT", "TAKEOFF", "CLIMB", "CRUISE", "DESCENT", "APPROACH", "LANDING", "TAXI_IN", "COMPLETED", "INTERRUPTED"];

/// `YYYY-MM-DDTHH:MM:SS[.fff…]Z` — UTC only, no offsets.
pub fn is_utc_timestamp(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() < 20 || b.len() > 35 || *b.last().unwrap() != b'Z' {
        return false;
    }
    let digits = |r: std::ops::Range<usize>| b[r].iter().all(u8::is_ascii_digit);
    if !(digits(0..4) && b[4] == b'-' && digits(5..7) && b[7] == b'-' && digits(8..10) && b[10] == b'T' && digits(11..13) && b[13] == b':' && digits(14..16) && b[16] == b':' && digits(17..19)) {
        return false;
    }
    let rest = &b[19..b.len() - 1];
    rest.is_empty() || (rest[0] == b'.' && rest.len() > 1 && rest[1..].iter().all(u8::is_ascii_digit))
}

pub(crate) fn check_ts(name: &str, v: &str) -> Result<(), StoreError> {
    if is_utc_timestamp(v) { Ok(()) } else { Err(StoreError::invalid(format!("{name} must be a UTC timestamp ending in Z"))) }
}
fn check_opt_ts(name: &str, v: &Option<String>) -> Result<(), StoreError> {
    v.as_deref().map_or(Ok(()), |v| check_ts(name, v))
}
fn check_one_of(name: &str, v: &str, allowed: &[&str]) -> Result<(), StoreError> {
    if allowed.contains(&v) { Ok(()) } else { Err(StoreError::invalid(format!("{name} has an unsupported value"))) }
}
fn check_text(name: &str, v: &Option<String>) -> Result<(), StoreError> {
    match v {
        Some(t) if t.chars().count() > MAX_TEXT => Err(StoreError::invalid(format!("{name} is too long"))),
        _ => Ok(()),
    }
}
fn check_json_object(name: &str, v: &str, max: usize) -> Result<(), StoreError> {
    if v.len() > max {
        return Err(StoreError::invalid(format!("{name} is too large")));
    }
    match serde_json::from_str::<serde_json::Value>(v) {
        Ok(serde_json::Value::Object(_)) => Ok(()),
        _ => Err(StoreError::invalid(format!("{name} must be a JSON object"))),
    }
}
fn check_finite(name: &str, v: Option<f64>) -> Result<(), StoreError> {
    match v {
        Some(x) if !x.is_finite() => Err(StoreError::invalid(format!("{name} must be finite"))),
        _ => Ok(()),
    }
}

fn validate(batch: &CommitBatch) -> Result<(), StoreError> {
    let f = &batch.flight;
    if f.id.is_empty() || f.id.len() > 64 || !f.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(StoreError::invalid("flight id is invalid"));
    }
    check_one_of("status", &f.status, STATUSES)?;
    check_one_of("phase", &f.phase, PHASES)?;
    check_one_of("simulator", &f.simulator, SIMULATORS)?;
    if let Some(c) = &f.completion {
        check_one_of("completion", c, COMPLETIONS)?;
    }
    check_ts("startedAtUtc", &f.started_at_utc)?;
    check_ts("lastSeenAtUtc", &f.last_seen_at_utc)?;
    check_opt_ts("endedAtUtc", &f.ended_at_utc)?;
    check_opt_ts("takeoffAtUtc", &f.takeoff_at_utc)?;
    check_opt_ts("landingAtUtc", &f.landing_at_utc)?;
    for (n, v) in [("simulatorVersion", &f.simulator_version), ("aircraftTitle", &f.aircraft_title), ("aircraftIcao", &f.aircraft_icao), ("originIcao", &f.origin_icao), ("destinationIcao", &f.destination_icao)] {
        check_text(n, v)?;
    }
    if !f.airborne_seconds.is_finite() || f.airborne_seconds < 0.0 {
        return Err(StoreError::invalid("airborneSeconds is invalid"));
    }
    check_json_object("engineState", &f.engine_state, MAX_JSON_BYTES)?;
    check_json_object("stats", &f.stats, MAX_JSON_BYTES)?;
    if batch.events.len() > MAX_EVENTS_PER_COMMIT || batch.samples.len() > MAX_SAMPLES_PER_COMMIT || batch.interruptions.len() > MAX_INTERRUPTIONS_PER_COMMIT {
        return Err(StoreError::invalid("commit batch is too large"));
    }
    for e in &batch.events {
        if e.seq <= 0 || e.event_id.is_empty() || e.event_id.len() > 64 || e.kind.is_empty() || e.kind.len() > 64 {
            return Err(StoreError::invalid("event is invalid"));
        }
        check_ts("occurredAtUtc", &e.occurred_at_utc)?;
        check_one_of("source", &e.source, SOURCES)?;
        for p in [&e.from_phase, &e.to_phase].into_iter().flatten() {
            check_one_of("phase", p, PHASES)?;
        }
        check_json_object("details", &e.details, MAX_DETAILS_BYTES)?;
    }
    for s in &batch.samples {
        if s.seq <= 0 {
            return Err(StoreError::invalid("sample seq is invalid"));
        }
        check_ts("observedAtUtc", &s.observed_at_utc)?;
        check_one_of("phase", &s.phase, PHASES)?;
        for (n, v) in [("latDeg", s.lat_deg), ("lonDeg", s.lon_deg), ("indicatedAltFt", s.indicated_alt_ft), ("radioAltFt", s.radio_alt_ft), ("groundSpeedKt", s.ground_speed_kt), ("indicatedKt", s.indicated_kt), ("verticalFpm", s.vertical_fpm), ("headingDeg", s.heading_deg), ("fuelKg", s.fuel_kg)] {
            check_finite(n, v)?;
        }
    }
    for i in &batch.interruptions {
        check_ts("startedAtUtc", &i.started_at_utc)?;
        check_opt_ts("endedAtUtc", &i.ended_at_utc)?;
    }
    Ok(())
}

pub(crate) fn now_utc() -> String {
    // Seconds precision is enough for bookkeeping columns.
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    format_unix_utc(secs)
}

/// Real-world UTC with millisecond precision, generated natively (never taken from the webview).
pub(crate) fn now_utc_ms() -> String {
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let base = format_unix_utc(ms.div_euclid(1000));
    format!("{}.{:03}Z", &base[..base.len() - 1], ms.rem_euclid(1000))
}

/// A random (v4) UUID generated natively.
pub(crate) fn new_uuid() -> Result<String, StoreError> {
    let mut b = [0u8; 16];
    getrandom::getrandom(&mut b).map_err(|e| StoreError::new(StoreErrorKind::Io, format!("No randomness available: {e}")))?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    Ok(format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32]))
}

/// Format seconds since the epoch as `YYYY-MM-DDTHH:MM:SSZ` (civil-from-days, no chrono needed).
pub fn format_unix_utc(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, (rem % 3600) / 60, rem % 60)
}

// ---------- store ----------

pub struct Store {
    pub(crate) conn: Connection,
}

const SUMMARY_COLUMNS: &str = "f.id, f.status, f.completion, f.phase, f.simulator, f.simulator_version, f.aircraft_title, f.aircraft_icao, \
    f.origin_icao, f.destination_icao, f.started_at_utc, f.ended_at_utc, f.last_seen_at_utc, f.takeoff_at_utc, f.landing_at_utc, \
    f.airborne_seconds, f.started_airborne, \
    (SELECT COUNT(*) FROM flight_interruptions i WHERE i.flight_id = f.id), \
    (SELECT COUNT(*) FROM flight_samples s WHERE s.flight_id = f.id), \
    fs.state, fs.account_id, fs.synced_at_utc, fs.last_error, fs.attempts, fs.next_attempt_at_utc";
const SUMMARY_FROM: &str = "flights f LEFT JOIN flight_sync fs ON fs.flight_id = f.id";

fn summary_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<FlightSummaryOut> {
    Ok(FlightSummaryOut {
        id: r.get(0)?,
        status: r.get(1)?,
        completion: r.get(2)?,
        phase: r.get(3)?,
        simulator: r.get(4)?,
        simulator_version: r.get(5)?,
        aircraft_title: r.get(6)?,
        aircraft_icao: r.get(7)?,
        origin_icao: r.get(8)?,
        destination_icao: r.get(9)?,
        started_at_utc: r.get(10)?,
        ended_at_utc: r.get(11)?,
        last_seen_at_utc: r.get(12)?,
        takeoff_at_utc: r.get(13)?,
        landing_at_utc: r.get(14)?,
        airborne_seconds: r.get(15)?,
        started_airborne: r.get::<_, i64>(16)? == 1,
        interruption_count: r.get(17)?,
        sample_count: r.get(18)?,
        sync: match r.get::<_, Option<String>>(19)? {
            Some(state) => Some(sync::FlightSyncOut {
                state,
                account_id: r.get(20)?,
                synced_at_utc: r.get(21)?,
                last_error: r.get(22)?,
                attempts: r.get(23)?,
                next_attempt_at_utc: r.get(24)?,
            }),
            None => None,
        },
    })
}

impl Store {
    /// Open (creating if needed), verify health, and migrate.
    pub fn open(path: &Path) -> Result<Store, StoreError> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| StoreError::new(StoreErrorKind::Io, format!("Could not create the data folder: {e}")))?;
        }
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Store, StoreError> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Store, StoreError> {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        // Reading the header first turns "not a database" into a clean Corrupt error.
        let check: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        if check != "ok" {
            return Err(StoreError::new(StoreErrorKind::Corrupt, format!("The flight database failed its integrity check ({check}).")));
        }
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let mut store = Store { conn };
        store.migrate()?;
        Ok(store)
    }

    pub fn schema_version(&self) -> Result<i64, StoreError> {
        Ok(self.conn.query_row("PRAGMA user_version", [], |r| r.get(0))?)
    }

    fn migrate(&mut self) -> Result<(), StoreError> {
        let current = self.schema_version()?;
        let latest = latest_schema_version();
        if current > latest {
            return Err(StoreError::new(
                StoreErrorKind::NewerSchema,
                format!("The flight database was created by a newer FlightSimApp (schema {current}, this app supports {latest}). Update FlightSimApp; the database was not modified."),
            ));
        }
        for (version, sql) in MIGRATIONS.iter().filter(|(v, _)| *v > current) {
            let tx = self.conn.transaction()?;
            tx.execute_batch("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at_utc TEXT NOT NULL);")?;
            tx.execute_batch(sql)?;
            tx.execute("INSERT INTO schema_migrations (version, applied_at_utc) VALUES (?1, ?2)", params![version, now_utc()])?;
            tx.pragma_update(None, "user_version", version)?;
            tx.commit()?;
        }
        Ok(())
    }

    /// The single open (active/interrupted) flight, if any — used for crash recovery.
    pub fn open_flight(&self) -> Result<Option<FlightRow>, StoreError> {
        Ok(self
            .conn
            .query_row(
                "SELECT id, status, completion, phase, simulator, simulator_version, aircraft_title, aircraft_icao, origin_icao, destination_icao, \
                 started_at_utc, ended_at_utc, last_seen_at_utc, takeoff_at_utc, landing_at_utc, airborne_seconds, started_airborne, engine_state, stats \
                 FROM flights WHERE profile_id = 'local' AND open_slot = 1",
                [],
                |r| {
                    Ok(FlightRow {
                        id: r.get(0)?,
                        status: r.get(1)?,
                        completion: r.get(2)?,
                        phase: r.get(3)?,
                        simulator: r.get(4)?,
                        simulator_version: r.get(5)?,
                        aircraft_title: r.get(6)?,
                        aircraft_icao: r.get(7)?,
                        origin_icao: r.get(8)?,
                        destination_icao: r.get(9)?,
                        started_at_utc: r.get(10)?,
                        ended_at_utc: r.get(11)?,
                        last_seen_at_utc: r.get(12)?,
                        takeoff_at_utc: r.get(13)?,
                        landing_at_utc: r.get(14)?,
                        airborne_seconds: r.get(15)?,
                        started_airborne: r.get::<_, i64>(16)? == 1,
                        engine_state: r.get(17)?,
                        stats: r.get(18)?,
                    })
                },
            )
            .optional()?)
    }

    /// Apply one recorder flush atomically. Re-sending the same batch is a no-op.
    pub fn commit(&mut self, batch: &CommitBatch) -> Result<(), StoreError> {
        validate(batch)?;
        let tx = self.conn.transaction()?;
        Self::upsert_flight(&tx, &batch.flight)?;
        {
            let mut ins = tx.prepare_cached(
                "INSERT INTO flight_events (flight_id, seq, event_id, kind, occurred_at_utc, source, from_phase, to_phase, details) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT (flight_id, seq) DO NOTHING",
            )?;
            for e in &batch.events {
                ins.execute(params![batch.flight.id, e.seq, e.event_id, e.kind, e.occurred_at_utc, e.source, e.from_phase, e.to_phase, e.details])?;
            }
            let mut ins = tx.prepare_cached(
                "INSERT INTO flight_samples (flight_id, seq, observed_at_utc, phase, reason, on_ground, lat_deg, lon_deg, indicated_alt_ft, radio_alt_ft, \
                 ground_speed_kt, indicated_kt, vertical_fpm, heading_deg, fuel_kg) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15) \
                 ON CONFLICT (flight_id, seq) DO NOTHING",
            )?;
            for s in &batch.samples {
                ins.execute(params![
                    batch.flight.id, s.seq, s.observed_at_utc, s.phase, s.reason, s.on_ground.map(i64::from), s.lat_deg, s.lon_deg, s.indicated_alt_ft,
                    s.radio_alt_ft, s.ground_speed_kt, s.indicated_kt, s.vertical_fpm, s.heading_deg, s.fuel_kg
                ])?;
            }
            let mut up = tx.prepare_cached(
                "INSERT INTO flight_interruptions (flight_id, started_at_utc, ended_at_utc, cause, resolution) VALUES (?1, ?2, ?3, ?4, ?5) \
                 ON CONFLICT (flight_id, started_at_utc) DO UPDATE SET \
                   ended_at_utc = COALESCE(flight_interruptions.ended_at_utc, excluded.ended_at_utc), \
                   resolution = COALESCE(flight_interruptions.resolution, excluded.resolution)",
            )?;
            for i in &batch.interruptions {
                up.execute(params![batch.flight.id, i.started_at_utc, i.ended_at_utc, i.cause, i.resolution])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    fn upsert_flight(tx: &Transaction<'_>, f: &FlightRow) -> Result<(), StoreError> {
        // A closed flight can never be reopened by a late or replayed batch.
        let existing: Option<String> = tx.query_row("SELECT status FROM flights WHERE id = ?1", [&f.id], |r| r.get(0)).optional()?;
        if let Some(status) = existing.as_deref() {
            let closed = !matches!(status, "active" | "interrupted");
            if closed && f.status != status {
                return Err(StoreError::invalid("flight is already closed"));
            }
            if closed {
                return Ok(());
            }
        }
        let open_slot: Option<i64> = matches!(f.status.as_str(), "active" | "interrupted").then_some(1);
        let now = now_utc();
        tx.execute(
            "INSERT INTO flights (id, open_slot, status, completion, phase, simulator, simulator_version, aircraft_title, aircraft_icao, origin_icao, \
             destination_icao, started_at_utc, ended_at_utc, last_seen_at_utc, takeoff_at_utc, landing_at_utc, airborne_seconds, started_airborne, \
             engine_state, stats, created_at_utc, updated_at_utc) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?21) \
             ON CONFLICT (id) DO UPDATE SET open_slot = excluded.open_slot, status = excluded.status, completion = excluded.completion, \
               phase = excluded.phase, simulator_version = COALESCE(excluded.simulator_version, flights.simulator_version), \
               aircraft_title = COALESCE(excluded.aircraft_title, flights.aircraft_title), aircraft_icao = COALESCE(excluded.aircraft_icao, flights.aircraft_icao), \
               ended_at_utc = excluded.ended_at_utc, last_seen_at_utc = excluded.last_seen_at_utc, \
               takeoff_at_utc = COALESCE(flights.takeoff_at_utc, excluded.takeoff_at_utc), landing_at_utc = COALESCE(excluded.landing_at_utc, flights.landing_at_utc), \
               airborne_seconds = MAX(flights.airborne_seconds, excluded.airborne_seconds), engine_state = excluded.engine_state, stats = excluded.stats, \
               updated_at_utc = excluded.updated_at_utc",
            params![
                f.id, open_slot, f.status, f.completion, f.phase, f.simulator, f.simulator_version, f.aircraft_title, f.aircraft_icao, f.origin_icao,
                f.destination_icao, f.started_at_utc, f.ended_at_utc, f.last_seen_at_utc, f.takeoff_at_utc, f.landing_at_utc, f.airborne_seconds,
                i64::from(f.started_airborne), f.engine_state, f.stats, now
            ],
        )
        .map_err(|e| match e.sqlite_error_code() {
            Some(ErrorCode::ConstraintViolation) if existing.is_none() => StoreError::invalid("Another flight is still open. Resume, end or discard it first."),
            _ => StoreError::from(e),
        })?;
        Ok(())
    }

    /// Newest first.
    pub fn list_flights(&self, limit: i64, offset: i64) -> Result<Vec<FlightSummaryOut>, StoreError> {
        let mut stmt = self.conn.prepare_cached(&format!(
            "SELECT {SUMMARY_COLUMNS} FROM {SUMMARY_FROM} WHERE f.profile_id = 'local' ORDER BY f.started_at_utc DESC, f.id LIMIT ?1 OFFSET ?2"
        ))?;
        let rows = stmt.query_map(params![limit.clamp(1, 500), offset.max(0)], summary_from_row)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn flight_detail(&self, id: &str) -> Result<Option<FlightDetailOut>, StoreError> {
        let summary = self
            .conn
            .query_row(&format!("SELECT {SUMMARY_COLUMNS} FROM {SUMMARY_FROM} WHERE f.id = ?1"), [id], summary_from_row)
            .optional()?;
        let Some(summary) = summary else { return Ok(None) };
        let (stats, pruned): (String, i64) = self.conn.query_row("SELECT stats, samples_pruned FROM flights WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        let mut stmt = self.conn.prepare_cached(
            "SELECT seq, kind, occurred_at_utc, source, from_phase, to_phase, details, event_id FROM flight_events WHERE flight_id = ?1 ORDER BY seq",
        )?;
        let events = stmt
            .query_map([id], |r| {
                let details: String = r.get(6)?;
                Ok(EventOut {
                    seq: r.get(0)?,
                    event_id: r.get(7)?,
                    kind: r.get(1)?,
                    occurred_at_utc: r.get(2)?,
                    source: r.get(3)?,
                    from_phase: r.get(4)?,
                    to_phase: r.get(5)?,
                    details: serde_json::from_str(&details).unwrap_or(serde_json::Value::Null),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut stmt = self.conn.prepare_cached(
            "SELECT started_at_utc, ended_at_utc, cause, resolution FROM flight_interruptions WHERE flight_id = ?1 ORDER BY started_at_utc",
        )?;
        let interruptions = stmt
            .query_map([id], |r| Ok(InterruptionRow { started_at_utc: r.get(0)?, ended_at_utc: r.get(1)?, cause: r.get(2)?, resolution: r.get(3)? }))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Some(FlightDetailOut {
            summary,
            events,
            interruptions,
            stats: serde_json::from_str(&stats).unwrap_or(serde_json::Value::Null),
            samples_pruned: pruned == 1,
        }))
    }

    /// Recorded track points of one flight, in order (S2-03 debrief). Read-only; empty when the
    /// samples were pruned by retention (the caller checks `samples_pruned` in the detail).
    pub fn flight_track(&self, id: &str) -> Result<Vec<SampleRow>, StoreError> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT seq, observed_at_utc, phase, reason, on_ground, lat_deg, lon_deg, indicated_alt_ft, radio_alt_ft, ground_speed_kt, indicated_kt, vertical_fpm, heading_deg, fuel_kg \
             FROM flight_samples WHERE flight_id = ?1 ORDER BY seq",
        )?;
        let rows = stmt
            .query_map([id], |r| {
                Ok(SampleRow {
                    seq: r.get(0)?,
                    observed_at_utc: r.get(1)?,
                    phase: r.get(2)?,
                    reason: r.get(3)?,
                    on_ground: r.get::<_, Option<i64>>(4)?.map(|v| v == 1),
                    lat_deg: r.get(5)?,
                    lon_deg: r.get(6)?,
                    indicated_alt_ft: r.get(7)?,
                    radio_alt_ft: r.get(8)?,
                    ground_speed_kt: r.get(9)?,
                    indicated_kt: r.get(10)?,
                    vertical_fpm: r.get(11)?,
                    heading_deg: r.get(12)?,
                    fuel_kg: r.get(13)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Retention: drop detailed samples of closed flights beyond the newest `keep`. Summaries,
    /// events and interruptions are kept. Returns the number of samples deleted.
    pub fn prune_samples(&mut self, keep: i64) -> Result<usize, StoreError> {
        let tx = self.conn.transaction()?;
        // "Newest `keep`" is counted over all closed flights, so repeated pruning is stable.
        let old = "SELECT id FROM (SELECT id, samples_pruned FROM flights WHERE ended_at_utc IS NOT NULL ORDER BY started_at_utc DESC LIMIT -1 OFFSET ?1) WHERE samples_pruned = 0";
        let deleted = tx.execute(&format!("DELETE FROM flight_samples WHERE flight_id IN ({old})"), [keep.max(1)])?;
        tx.execute(&format!("UPDATE flights SET samples_pruned = 1 WHERE id IN ({old})"), [keep.max(1)])?;
        tx.commit()?;
        Ok(deleted)
    }
}

/// Where the store lives and its current health. Owned by the actor thread.
pub struct StoreSlot {
    pub path: PathBuf,
    pub store: Result<Store, StoreError>,
}

impl StoreSlot {
    pub fn open(path: PathBuf) -> Self {
        let store = Store::open(&path);
        StoreSlot { path, store }
    }

    pub fn get(&mut self) -> Result<&mut Store, StoreError> {
        self.store.as_mut().map_err(|e| e.clone())
    }

    /// Re-try opening (e.g. after the user fixed permissions or freed disk space).
    pub fn retry(&mut self) {
        if self.store.is_err() {
            self.store = Store::open(&self.path);
        }
    }

    /// Move a damaged/unreadable database aside (never deleted) and start a fresh one.
    pub fn reset_damaged(&mut self) -> Result<PathBuf, StoreError> {
        if self.store.is_ok() {
            return Err(StoreError::invalid("The flight database is healthy; nothing to reset."));
        }
        self.store = Err(StoreError::new(StoreErrorKind::Io, "closing"));
        let stamp = now_utc().replace([':', '-'], "");
        let aside = self.path.with_file_name(format!("{DB_FILE}.damaged-{stamp}"));
        std::fs::rename(&self.path, &aside).map_err(|e| StoreError::new(StoreErrorKind::Io, format!("Could not move the damaged database aside: {e}")))?;
        for suffix in ["-wal", "-shm"] {
            let side = PathBuf::from(format!("{}{suffix}", self.path.display()));
            if side.exists() {
                let _ = std::fs::rename(&side, PathBuf::from(format!("{}{suffix}", aside.display())));
            }
        }
        self.store = Store::open(&self.path);
        self.store.as_ref().map_err(|e| e.clone())?;
        Ok(aside)
    }
}

#[cfg(test)]
mod tests;
