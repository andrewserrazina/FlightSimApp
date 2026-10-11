use super::*;
use super::sync::SyncMark;

fn temp_db(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("flightsim-store-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(DB_FILE)
}

fn flight(id: &str, status: &str, started: &str) -> FlightRow {
    let open = matches!(status, "active" | "interrupted");
    FlightRow {
        id: id.into(),
        status: status.into(),
        completion: (status == "completed").then(|| "arrival_confirmed".into()),
        phase: if status == "completed" { "COMPLETED".into() } else { "CRUISE".into() },
        simulator: "mock".into(),
        simulator_version: Some("mock-1".into()),
        aircraft_title: Some("Mock Twinjet (demo data)".into()),
        aircraft_icao: None,
        origin_icao: None,
        destination_icao: None,
        started_at_utc: started.into(),
        ended_at_utc: (!open).then(|| "2026-10-10T23:00:00.000Z".into()),
        last_seen_at_utc: started.into(),
        takeoff_at_utc: None,
        landing_at_utc: None,
        airborne_seconds: 0.0,
        started_airborne: false,
        engine_state: "{}".into(),
        stats: "{}".into(),
    }
}

fn event(seq: i64, kind: &str) -> EventRow {
    EventRow { seq, event_id: format!("e-{seq}-{kind}"), kind: kind.into(), occurred_at_utc: "2026-10-10T21:00:01.000Z".into(), source: "detected".into(), from_phase: None, to_phase: Some("PREPARING".into()), details: "{}".into() }
}

fn sample(seq: i64) -> SampleRow {
    SampleRow { seq, observed_at_utc: "2026-10-10T21:00:02.000Z".into(), phase: "CRUISE".into(), reason: "interval".into(), on_ground: Some(false), lat_deg: Some(47.0), lon_deg: Some(-122.0), indicated_alt_ft: Some(8433.0), radio_alt_ft: None, ground_speed_kt: Some(300.0), indicated_kt: None, vertical_fpm: Some(0.0), heading_deg: Some(340.0), fuel_kg: None }
}

fn batch(f: FlightRow) -> CommitBatch {
    CommitBatch { flight: f, events: vec![], samples: vec![], interruptions: vec![] }
}

#[test]
fn migrates_a_new_database_to_the_latest_version() {
    let store = Store::open_in_memory().unwrap();
    assert_eq!(store.schema_version().unwrap(), latest_schema_version());
    let applied: i64 = store.conn.query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r.get(0)).unwrap();
    assert_eq!(applied, MIGRATIONS.len() as i64);
}

#[test]
fn reopening_does_not_reapply_migrations_and_keeps_data() {
    let path = temp_db("reopen");
    {
        let mut s = Store::open(&path).unwrap();
        s.commit(&batch(flight("f1", "active", "2026-10-10T21:00:00.000Z"))).unwrap();
    }
    let s = Store::open(&path).unwrap();
    let applied: i64 = s.conn.query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r.get(0)).unwrap();
    assert_eq!(applied, MIGRATIONS.len() as i64);
    assert_eq!(s.open_flight().unwrap().unwrap().id, "f1");
}

#[test]
fn refuses_a_database_from_a_newer_app_without_modifying_it() {
    let path = temp_db("newer");
    {
        let c = Connection::open(&path).unwrap();
        c.pragma_update(None, "user_version", 99).unwrap();
    }
    let err = Store::open(&path).err().unwrap();
    assert_eq!(err.kind, StoreErrorKind::NewerSchema);
    let c = Connection::open(&path).unwrap();
    let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(v, 99);
}

#[test]
fn reports_a_corrupt_file_and_never_deletes_it() {
    let path = temp_db("corrupt");
    std::fs::write(&path, b"this is definitely not a sqlite database file, just garbage bytes.......").unwrap();
    let mut slot = StoreSlot::open(path.clone());
    let err = slot.get().err().unwrap();
    assert_eq!(err.kind, StoreErrorKind::Corrupt);
    assert!(path.exists(), "damaged file must be kept");
    // Explicit reset moves it aside and starts fresh.
    let aside = slot.reset_damaged().unwrap();
    assert!(aside.exists());
    assert!(std::fs::read(&aside).unwrap().starts_with(b"this is definitely"));
    assert!(slot.get().is_ok());
}

#[test]
fn reset_refuses_a_healthy_database() {
    let mut slot = StoreSlot::open(temp_db("healthy"));
    assert_eq!(slot.reset_damaged().err().unwrap().kind, StoreErrorKind::Invalid);
}

#[test]
fn a_failing_commit_rolls_back_entirely() {
    let mut s = Store::open_in_memory().unwrap();
    let mut b = batch(flight("f1", "active", "2026-10-10T21:00:00.000Z"));
    b.events = vec![event(1, "flight.started")];
    s.commit(&b).unwrap();

    // Second batch: a valid new event + sample, then an interruption violating a CHECK constraint.
    let mut bad = batch(flight("f1", "interrupted", "2026-10-10T21:00:00.000Z"));
    bad.events = vec![event(2, "flight.interrupted")];
    bad.samples = vec![sample(1)];
    bad.interruptions = vec![InterruptionRow { started_at_utc: "2026-10-10T21:00:05.000Z".into(), ended_at_utc: None, cause: "cosmic_rays".into(), resolution: None }];
    assert!(s.commit(&bad).is_err());

    let d = s.flight_detail("f1").unwrap().unwrap();
    assert_eq!(d.summary.status, "active");
    assert_eq!(d.events.len(), 1);
    assert_eq!(d.summary.sample_count, 0);
    assert!(d.interruptions.is_empty());
}

#[test]
fn replaying_a_batch_is_idempotent() {
    let mut s = Store::open_in_memory().unwrap();
    let mut b = batch(flight("f1", "active", "2026-10-10T21:00:00.000Z"));
    b.events = vec![event(1, "flight.started"), event(2, "phase.changed")];
    b.samples = vec![sample(1), sample(2)];
    b.interruptions = vec![InterruptionRow { started_at_utc: "2026-10-10T21:00:05.000Z".into(), ended_at_utc: None, cause: "app_closed".into(), resolution: None }];
    s.commit(&b).unwrap();
    s.commit(&b).unwrap();
    let d = s.flight_detail("f1").unwrap().unwrap();
    assert_eq!(d.events.len(), 2);
    assert_eq!(d.summary.sample_count, 2);
    assert_eq!(d.summary.interruption_count, 1);
    assert_eq!(s.list_flights(10, 0).unwrap().len(), 1);
}

#[test]
fn interruption_end_is_recorded_once_and_never_overwritten() {
    let mut s = Store::open_in_memory().unwrap();
    let start = "2026-10-10T21:00:05.000Z";
    let mut b = batch(flight("f1", "interrupted", "2026-10-10T21:00:00.000Z"));
    b.interruptions = vec![InterruptionRow { started_at_utc: start.into(), ended_at_utc: None, cause: "app_closed".into(), resolution: None }];
    s.commit(&b).unwrap();
    b.flight.status = "active".into();
    b.interruptions[0].ended_at_utc = Some("2026-10-10T21:10:00.000Z".into());
    b.interruptions[0].resolution = Some("user_resumed".into());
    s.commit(&b).unwrap();
    b.interruptions[0].ended_at_utc = Some("2026-10-10T22:00:00.000Z".into());
    s.commit(&b).unwrap();
    let i = &s.flight_detail("f1").unwrap().unwrap().interruptions[0];
    assert_eq!(i.ended_at_utc.as_deref(), Some("2026-10-10T21:10:00.000Z"));
    assert_eq!(i.resolution.as_deref(), Some("user_resumed"));
}

#[test]
fn only_one_flight_can_be_open() {
    let mut s = Store::open_in_memory().unwrap();
    s.commit(&batch(flight("f1", "active", "2026-10-10T21:00:00.000Z"))).unwrap();
    let err = s.commit(&batch(flight("f2", "active", "2026-10-10T21:05:00.000Z"))).err().unwrap();
    assert_eq!(err.kind, StoreErrorKind::Invalid);
    assert!(err.message.contains("Another flight is still open"));
    // After closing f1 a new flight may start.
    s.commit(&batch(flight("f1", "completed", "2026-10-10T21:00:00.000Z"))).unwrap();
    s.commit(&batch(flight("f2", "active", "2026-10-10T21:05:00.000Z"))).unwrap();
    assert_eq!(s.open_flight().unwrap().unwrap().id, "f2");
}

#[test]
fn a_closed_flight_cannot_be_reopened_by_a_late_batch() {
    let mut s = Store::open_in_memory().unwrap();
    s.commit(&batch(flight("f1", "completed", "2026-10-10T21:00:00.000Z"))).unwrap();
    assert!(s.commit(&batch(flight("f1", "active", "2026-10-10T21:00:00.000Z"))).is_err());
    assert!(s.open_flight().unwrap().is_none());
}

#[test]
fn rejects_invalid_input() {
    let mut s = Store::open_in_memory().unwrap();
    let mut f = flight("f1", "active", "2026-10-10T23:00:00+02:00");
    assert_eq!(s.commit(&batch(f.clone())).err().unwrap().kind, StoreErrorKind::Invalid);
    f.started_at_utc = "2026-10-10T21:00:00.000Z".into();
    f.engine_state = "not json".into();
    assert_eq!(s.commit(&batch(f.clone())).err().unwrap().kind, StoreErrorKind::Invalid);
    f.engine_state = "{}".into();
    f.id = "'; DROP TABLE flights; --".into();
    assert_eq!(s.commit(&batch(f.clone())).err().unwrap().kind, StoreErrorKind::Invalid);
    f.id = "f1".into();
    let mut b = batch(f);
    b.samples = vec![SampleRow { lat_deg: Some(f64::NAN), ..sample(1) }];
    assert_eq!(s.commit(&b).err().unwrap().kind, StoreErrorKind::Invalid);
}

#[test]
fn keeps_unavailable_values_as_null() {
    let mut s = Store::open_in_memory().unwrap();
    let mut b = batch(flight("f1", "active", "2026-10-10T21:00:00.000Z"));
    b.samples = vec![sample(1)];
    s.commit(&b).unwrap();
    let (fuel, ra): (Option<f64>, Option<f64>) = s.conn.query_row("SELECT fuel_kg, radio_alt_ft FROM flight_samples", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!((fuel, ra), (None, None));
}

#[test]
fn lists_flights_newest_first_with_counts() {
    let mut s = Store::open_in_memory().unwrap();
    s.commit(&batch(flight("old", "completed", "2026-10-09T10:00:00.000Z"))).unwrap();
    s.commit(&batch(flight("new", "aborted", "2026-10-10T10:00:00.000Z"))).unwrap();
    let mut b = batch(flight("open", "active", "2026-10-11T10:00:00.000Z"));
    b.samples = vec![sample(1), sample(2), sample(3)];
    s.commit(&b).unwrap();
    let list = s.list_flights(10, 0).unwrap();
    assert_eq!(list.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(), ["open", "new", "old"]);
    assert_eq!(list[0].sample_count, 3);
    assert_eq!(s.list_flights(1, 1).unwrap()[0].id, "new");
    assert!(s.flight_detail("missing").unwrap().is_none());
}

#[test]
fn retention_prunes_samples_of_old_closed_flights_only() {
    let mut s = Store::open_in_memory().unwrap();
    for (i, id) in ["a", "b", "c"].iter().enumerate() {
        let mut b = batch(flight(id, "completed", &format!("2026-10-0{}T10:00:00.000Z", i + 1)));
        b.samples = vec![sample(1), sample(2)];
        b.events = vec![EventRow { event_id: format!("e-{id}"), ..event(1, "flight.started") }];
        s.commit(&b).unwrap();
    }
    let mut open = batch(flight("open", "active", "2026-10-09T10:00:00.000Z"));
    open.samples = vec![sample(1)];
    s.commit(&open).unwrap();
    assert_eq!(s.prune_samples(2).unwrap(), 2); // only "a"
    assert_eq!(s.prune_samples(2).unwrap(), 0); // stable on repeat
    let a = s.flight_detail("a").unwrap().unwrap();
    assert!(a.samples_pruned);
    assert_eq!(a.summary.sample_count, 0);
    assert_eq!(a.events.len(), 1, "events are retained");
    assert_eq!(s.flight_detail("open").unwrap().unwrap().summary.sample_count, 1);
}

#[test]
fn timestamp_validation() {
    assert!(is_utc_timestamp("2026-10-10T21:00:00Z"));
    assert!(is_utc_timestamp("2026-10-10T21:00:00.123Z"));
    assert!(!is_utc_timestamp("2026-10-10T21:00:00+00:00"));
    assert!(!is_utc_timestamp("2026-10-10 21:00:00Z"));
    assert!(!is_utc_timestamp("2026-10-10T21:00:00.Z"));
    assert_eq!(format_unix_utc(0), "1970-01-01T00:00:00Z");
    assert_eq!(format_unix_utc(1_791_666_000), "2026-10-10T21:00:00Z");
}

#[tokio::test]
async fn actor_serializes_work_off_the_calling_thread() {
    let handle = actor::StoreHandle::spawn(temp_db("actor"));
    let caller = std::thread::current().id();
    let ran_on = handle.call(|_| Ok(std::thread::current().id())).await.unwrap();
    assert_ne!(ran_on, caller);
    let n = handle.call(|slot| Ok(slot.get()?.list_flights(10, 0)?.len())).await.unwrap();
    assert_eq!(n, 0);
}

// ---------- schema v2: cloud sync bookkeeping ----------

fn completed(id: &str, ended: &str) -> CommitBatch {
    let mut f = flight(id, "completed", "2026-10-10T20:00:00.000Z");
    f.ended_at_utc = Some(ended.into());
    let mut b = batch(f);
    b.events = vec![EventRow { event_id: format!("ev-{id}"), ..event(1, "flight.started") }];
    b
}

#[test]
fn migrates_to_schema_v2_with_sync_disabled_by_default() {
    let s = Store::open_in_memory().unwrap();
    assert_eq!(s.schema_version().unwrap(), 2);
    let st = s.sync_settings().unwrap();
    assert!(!st.enabled);
    assert_eq!(st.bound_account_id, None);
}

#[test]
fn only_flights_completed_after_opt_in_are_queued_automatically() {
    let mut s = Store::open_in_memory().unwrap();
    s.commit(&completed("before", "2000-01-01T00:00:00.000Z")).unwrap();
    s.commit(&batch(flight("open", "active", "2026-10-10T21:00:00.000Z"))).unwrap();
    assert_eq!(s.sync_enqueue_after_opt_in("acct-a").unwrap(), 0, "nothing while disabled");
    s.sync_enable("acct-a", "a***@example.test").unwrap();
    s.commit(&completed("after", "2999-01-01T00:00:00.000Z")).unwrap();
    assert_eq!(s.sync_enqueue_after_opt_in("acct-a").unwrap(), 1);
    assert_eq!(s.sync_enqueue_after_opt_in("acct-a").unwrap(), 0, "idempotent");
    let due = s.sync_due("acct-a", "2999-12-31T00:00:00Z", 10).unwrap();
    assert_eq!(due.iter().map(|d| d.flight_id.as_str()).collect::<Vec<_>>(), ["after"]);
    let o = s.sync_overview().unwrap();
    assert_eq!((o.pending, o.local_only_completed), (1, 1));
}

#[test]
fn earlier_flights_need_explicit_backfill_consent_for_the_bound_account() {
    let mut s = Store::open_in_memory().unwrap();
    s.commit(&completed("old", "2000-01-01T00:00:00.000Z")).unwrap();
    assert!(s.sync_backfill("acct-a", &["old".into()]).is_err(), "sync must be enabled first");
    s.sync_enable("acct-a", "a").unwrap();
    assert!(s.sync_backfill("acct-b", &["old".into()]).is_err(), "only the bound account");
    assert_eq!(s.sync_local_only_ids().unwrap(), ["old"]);
    assert_eq!(s.sync_backfill("acct-a", &["old".into()]).unwrap(), 1);
    assert_eq!(s.sync_backfill("acct-a", &["old".into()]).unwrap(), 0);
    assert_eq!(s.flight_detail("old").unwrap().unwrap().summary.sync.unwrap().account_id, "acct-a");
}

#[test]
fn switching_accounts_never_transfers_queued_flights() {
    let mut s = Store::open_in_memory().unwrap();
    s.sync_enable("acct-a", "a").unwrap();
    s.commit(&completed("fa", "2999-01-01T00:00:00.000Z")).unwrap();
    s.sync_enqueue_after_opt_in("acct-a").unwrap();
    // Another account signs in and opts in on the same machine.
    let st = s.sync_enable("acct-b", "b").unwrap();
    assert_eq!(st.bound_account_id.as_deref(), Some("acct-b"));
    assert_eq!(s.sync_enqueue_after_opt_in("acct-b").unwrap(), 0, "fa is already bound to acct-a");
    assert!(s.sync_due("acct-b", "2999-12-31T00:00:00Z", 10).unwrap().is_empty());
    assert!(s.sync_backfill("acct-b", &["fa".into()]).unwrap() == 0, "backfill cannot re-bind");
    let mark = SyncMark { flight_id: "fa".into(), account_id: "acct-b".into(), state: "synced".into(), attempts: None, next_attempt_at_utc: None, last_error: None, cloud_event_count: Some(1), cloud_interruption_count: Some(0) };
    assert!(s.sync_mark(&mark).is_err(), "cannot mark another account's flight");
    assert_eq!(s.flight_detail("fa").unwrap().unwrap().summary.sync.unwrap().account_id, "acct-a");
    assert_eq!(s.sync_overview().unwrap().other_account, 1);
}

#[test]
fn state_transitions_retry_and_crash_recovery() {
    let mut s = Store::open_in_memory().unwrap();
    s.sync_enable("acct-a", "a").unwrap();
    s.commit(&completed("f1", "2999-01-01T00:00:00.000Z")).unwrap();
    s.sync_enqueue_after_opt_in("acct-a").unwrap();
    let mk = |state: &str| SyncMark { flight_id: "f1".into(), account_id: "acct-a".into(), state: state.into(), attempts: None, next_attempt_at_utc: None, last_error: None, cloud_event_count: None, cloud_interruption_count: None };
    s.sync_mark(&mk("uploading")).unwrap();
    assert_eq!(s.sync_recover_interrupted().unwrap(), 1, "crash during upload");
    assert_eq!(s.flight_detail("f1").unwrap().unwrap().summary.sync.unwrap().state, "retry_pending");
    s.sync_mark(&SyncMark { attempts: Some(2), next_attempt_at_utc: Some("2999-06-01T00:00:00Z".into()), last_error: Some("timeout".into()), ..mk("retry_pending") }).unwrap();
    assert!(s.sync_due("acct-a", "2999-05-01T00:00:00Z", 10).unwrap().is_empty(), "backoff respected");
    assert_eq!(s.sync_due("acct-a", "2999-07-01T00:00:00Z", 10).unwrap().len(), 1);
    s.sync_mark(&SyncMark { last_error: Some("permission denied".into()), ..mk("failed") }).unwrap();
    assert_eq!(s.sync_overview().unwrap().failed, 1);
    assert_eq!(s.sync_retry_failed("acct-a").unwrap(), 1);
    s.sync_mark(&SyncMark { cloud_event_count: Some(1), cloud_interruption_count: Some(0), ..mk("synced") }).unwrap();
    let sync = s.flight_detail("f1").unwrap().unwrap().summary.sync.unwrap();
    assert_eq!(sync.state, "synced");
    assert!(sync.synced_at_utc.is_some());
    assert!(s.sync_settings().unwrap().last_success_at_utc.is_some());
    assert_eq!(s.list_flights(10, 0).unwrap()[0].sync.as_ref().unwrap().state, "synced");
}

#[test]
fn disabling_keeps_the_binding_and_never_touches_flights() {
    let mut s = Store::open_in_memory().unwrap();
    s.sync_enable("acct-a", "a").unwrap();
    s.commit(&completed("f1", "2999-01-01T00:00:00.000Z")).unwrap();
    s.sync_enqueue_after_opt_in("acct-a").unwrap();
    let st = s.sync_disable().unwrap();
    assert!(!st.enabled);
    assert_eq!(st.bound_account_id.as_deref(), Some("acct-a"));
    assert_eq!(s.list_flights(10, 0).unwrap().len(), 1);
    let opted = st.opted_in_at_utc.clone();
    assert_eq!(s.sync_enable("acct-a", "a").unwrap().opted_in_at_utc, opted, "same account keeps its opt-in");
}

#[test]
fn detail_includes_event_ids_for_idempotent_upload() {
    let mut s = Store::open_in_memory().unwrap();
    s.commit(&completed("f1", "2999-01-01T00:00:00.000Z")).unwrap();
    assert_eq!(s.flight_detail("f1").unwrap().unwrap().events[0].event_id, "ev-f1");
}

#[test]
fn rejects_invalid_sync_input() {
    let mut s = Store::open_in_memory().unwrap();
    assert!(s.sync_enable("'; drop table flights; --", "x").is_err());
    assert!(s.sync_due("acct", "yesterday", 10).is_err());
    let bad = SyncMark { flight_id: "f".into(), account_id: "a".into(), state: "teleported".into(), attempts: None, next_attempt_at_utc: None, last_error: None, cloud_event_count: None, cloud_interruption_count: None };
    assert!(s.sync_mark(&bad).is_err());
}
