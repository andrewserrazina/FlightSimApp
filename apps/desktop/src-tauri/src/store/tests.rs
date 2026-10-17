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
    assert!(s.schema_version().unwrap() >= 2);
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
    // A flight completed while sync was off was never consented to.
    std::thread::sleep(std::time::Duration::from_millis(1100));
    s.commit(&completed("while-off", &now_utc())).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(1100));
    let again = s.sync_enable("acct-a", "a").unwrap();
    assert!(again.opted_in_at_utc > st.opted_in_at_utc, "re-enabling restarts the opt-in clock");
    assert_eq!(s.sync_enqueue_after_opt_in("acct-a").unwrap(), 0, "flight completed while off is not queued");
    assert_eq!(s.sync_local_only_ids().unwrap(), ["while-off"]);
    assert_eq!(s.sync_due("acct-a", "2999-12-31T00:00:00Z", 10).unwrap().len(), 1, "already-queued flight resumes");
    // Enabling while already enabled keeps the opt-in.
    assert_eq!(s.sync_enable("acct-a", "a").unwrap().opted_in_at_utc, again.opted_in_at_utc);
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

// ---------- dispatch (schema v3) ----------

use super::dispatch::AssociateOutcome;

fn plan_json(request_id: &str) -> serde_json::Value {
    serde_json::json!({ "schema": "turnline.flight_plan", "version": 1, "source": { "requestId": request_id }, "route": { "text": "DCT" } })
}

fn snapshot_json(flight_id: &str, request_id: &str) -> serde_json::Value {
    serde_json::json!({ "schema": "turnline.flight_plan_snapshot", "version": 1, "flightId": flight_id, "associatedAtUtc": "2026-10-15T14:00:00Z", "plan": plan_json(request_id) })
}

#[test]
fn dispatch_plan_is_saved_replaced_cleared_and_survives_reopen() {
    let path = temp_db("dispatch-plan");
    {
        let mut s = Store::open(&path).unwrap();
        assert!(s.schema_version().unwrap() >= 3);
        assert_eq!(s.dispatch_plan().unwrap(), None);
        s.save_dispatch_plan(&plan_json("111"), "2026-10-15T12:00:00Z").unwrap();
        s.save_dispatch_plan(&plan_json("222"), "2026-10-15T13:00:00Z").unwrap();
    }
    let mut s = Store::open(&path).unwrap(); // restart
    let got = s.dispatch_plan().unwrap().unwrap();
    assert_eq!(got.plan.pointer("/source/requestId").unwrap(), "222");
    assert_eq!(got.imported_at_utc, "2026-10-15T13:00:00Z");
    s.clear_dispatch_plan().unwrap();
    assert_eq!(s.dispatch_plan().unwrap(), None);
}

#[test]
fn dispatch_plan_rejects_wrong_schema_bad_timestamps_and_oversize() {
    let mut s = Store::open_in_memory().unwrap();
    assert!(s.save_dispatch_plan(&serde_json::json!({ "schema": "other" }), "2026-10-15T12:00:00Z").is_err());
    assert!(s.save_dispatch_plan(&serde_json::json!([1, 2]), "2026-10-15T12:00:00Z").is_err());
    assert!(s.save_dispatch_plan(&plan_json("1"), "yesterday").is_err());
    let big = serde_json::json!({ "schema": "turnline.flight_plan", "route": { "text": "X".repeat(70_000) } });
    assert!(s.save_dispatch_plan(&big, "2026-10-15T12:00:00Z").is_err());
}

#[test]
fn corrupt_cached_plan_is_reported_as_null_not_an_error() {
    let mut s = Store::open_in_memory().unwrap();
    s.save_dispatch_plan(&plan_json("1"), "2026-10-15T12:00:00Z").unwrap();
    s.conn.execute("UPDATE dispatch_plan SET plan_json = '{not json' WHERE id = 1", []).unwrap();
    let got = s.dispatch_plan().unwrap().unwrap();
    assert_eq!(got.plan, serde_json::Value::Null);
}

#[test]
fn snapshot_is_created_once_and_is_immutable() {
    let mut s = Store::open_in_memory().unwrap();
    s.commit(&batch(flight("f1", "active", "2026-10-15T13:00:00.000Z"))).unwrap();
    assert_eq!(s.associate_plan("f1", &snapshot_json("f1", "111")).unwrap(), AssociateOutcome::Created);
    // A later association (e.g. after a newer import) never replaces the first snapshot.
    assert_eq!(s.associate_plan("f1", &snapshot_json("f1", "222")).unwrap(), AssociateOutcome::AlreadyAssociated);
    // Neither do later imports of the current plan.
    s.save_dispatch_plan(&plan_json("333"), "2026-10-15T15:00:00Z").unwrap();
    let snap = s.plan_snapshot("f1").unwrap().unwrap();
    assert_eq!(snap.snapshot.pointer("/plan/source/requestId").unwrap(), "111");
    // The database itself refuses updates.
    let err = s.conn.execute("UPDATE flight_plan_snapshots SET snapshot_json = '{}' WHERE flight_id = 'f1'", []).unwrap_err();
    assert!(err.to_string().contains("immutable"), "{err}");
    assert_eq!(s.plan_snapshot("f1").unwrap().unwrap().snapshot.pointer("/plan/source/requestId").unwrap(), "111");
}

#[test]
fn snapshot_needs_an_existing_flight_and_a_matching_id() {
    let mut s = Store::open_in_memory().unwrap();
    assert!(s.associate_plan("nope", &snapshot_json("nope", "1")).is_err());
    s.commit(&batch(flight("f2", "active", "2026-10-15T13:00:00.000Z"))).unwrap();
    assert!(s.associate_plan("f2", &snapshot_json("other", "1")).is_err());
    let mut bad = snapshot_json("f2", "1");
    bad["associatedAtUtc"] = serde_json::json!("soon");
    assert!(s.associate_plan("f2", &bad).is_err());
    assert_eq!(s.plan_snapshot("f2").unwrap(), None);
}

#[test]
fn associating_a_plan_never_changes_the_recorded_flight() {
    let mut s = Store::open_in_memory().unwrap();
    let mut b = batch(flight("f3", "active", "2026-10-15T13:00:00.000Z"));
    b.events = vec![event(1, "flight.started")];
    b.samples = vec![sample(1)];
    s.commit(&b).unwrap();
    let before = serde_json::to_value(s.flight_detail("f3").unwrap().unwrap()).unwrap();
    s.associate_plan("f3", &snapshot_json("f3", "1")).unwrap();
    // Recording continues normally after association.
    let mut b2 = batch(flight("f3", "active", "2026-10-15T13:00:00.000Z"));
    b2.events = vec![event(2, "phase.changed")];
    s.commit(&b2).unwrap();
    let after = serde_json::to_value(s.flight_detail("f3").unwrap().unwrap()).unwrap();
    assert_eq!(before["summary"]["id"], after["summary"]["id"]);
    assert_eq!(after["events"].as_array().unwrap().len(), 2);
}

#[test]
fn upgrading_a_v2_database_keeps_flights_and_adds_dispatch_tables() {
    let path = temp_db("v2-upgrade");
    {
        // Build a genuine v2 database holding a flight: write with the current store, then remove
        // everything migration 3 added and mark the file as schema 2.
        let mut s = Store::open(&path).unwrap();
        s.commit(&batch(flight("old", "completed", "2026-10-01T10:00:00.000Z"))).unwrap();
        s.conn.execute_batch(DROP_V4).unwrap();
        s.conn.execute_batch("DROP TRIGGER flight_plan_snapshots_immutable; DROP TABLE flight_plan_snapshots; DROP TABLE dispatch_plan; DELETE FROM schema_migrations WHERE version = 3;").unwrap();
        s.conn.pragma_update(None, "user_version", 2).unwrap();
    }
    let mut s = Store::open(&path).unwrap();
    assert_eq!(s.schema_version().unwrap(), latest_schema_version());
    assert_eq!(s.list_flights(10, 0).unwrap().len(), 1);
    assert_eq!(s.dispatch_plan().unwrap(), None);
    assert_eq!(s.associate_plan("old", &snapshot_json("old", "9")).unwrap(), AssociateOutcome::Created);
}

// ---------- dispatch releases and recorded OUT/IN (schema v4) ----------

use super::release::MilestoneOutcome;

/// Removes everything migration 4 added (to build genuine older databases in tests).
const DROP_V4: &str = "DELETE FROM schema_migrations WHERE version = 5; DROP TRIGGER flight_manual_milestones_immutable; DROP TABLE flight_manual_milestones; \
    DROP TRIGGER dispatch_releases_no_delete; DROP TRIGGER dispatch_releases_link_once; DROP TRIGGER dispatch_releases_state_transition; \
    DROP TRIGGER dispatch_releases_immutable_record; DROP INDEX dispatch_releases_by_time; DROP TABLE dispatch_releases; \
    DELETE FROM schema_migrations WHERE version = 4;";

fn release_json(id: &str, request_id: &str) -> serde_json::Value {
    serde_json::json!({
        "schema": "turnline.dispatch_release", "version": 1, "releaseId": id, "releasedAtUtc": "2026-10-16T12:00:00Z",
        "ofp": { "key": format!("simbrief:{request_id}:2026-10-16T11:00:00Z"), "requestId": request_id, "generatedAtUtc": "2026-10-16T11:00:00Z" },
        "plan": plan_json(request_id),
        "acknowledgments": { "reviewed": true, "reviewedAtUtc": "2026-10-16T11:59:00Z", "warnings": [] }
    })
}

fn detail_json(s: &Store, id: &str) -> serde_json::Value {
    serde_json::to_value(s.flight_detail(id).unwrap().unwrap()).unwrap()
}

fn open_flight(s: &mut Store, id: &str) {
    s.commit(&batch(flight(id, "active", "2026-10-16T12:30:00.000Z"))).unwrap();
}

#[test]
fn release_is_created_once_and_its_record_is_immutable() {
    let mut s = Store::open_in_memory().unwrap();
    let r = s.create_release(&release_json("rel-1", "100")).unwrap();
    assert_eq!(r.state, "released");
    assert_eq!(r.flight_id, None);
    assert_eq!(r.record["plan"]["source"]["requestId"], "100");
    // Same OFP again: refused, not duplicated.
    let dup = s.create_release(&release_json("rel-2", "100")).unwrap_err();
    assert!(dup.message.contains("already released"), "{}", dup.message);
    // Different OFP while one is open: refused.
    let other = s.create_release(&release_json("rel-3", "200")).unwrap_err();
    assert!(other.message.contains("still open"), "{}", other.message);
    assert_eq!(s.list_releases(10).unwrap().len(), 1);
    // The reviewed record cannot be rewritten, and records cannot be deleted, even with raw SQL.
    assert!(s.conn.execute("UPDATE dispatch_releases SET release_json = '{}' WHERE release_id = 'rel-1'", []).is_err());
    assert!(s.conn.execute("UPDATE dispatch_releases SET released_at_utc = '2020-01-01T00:00:00Z'", []).is_err());
    assert!(s.conn.execute("DELETE FROM dispatch_releases", []).is_err());
}

#[test]
fn release_requires_acknowledgment_and_a_valid_record() {
    let mut s = Store::open_in_memory().unwrap();
    let mut no_ack = release_json("rel-1", "1");
    no_ack["acknowledgments"]["reviewed"] = serde_json::json!(false);
    assert!(s.create_release(&no_ack).is_err());
    let mut bad_ts = release_json("rel-1", "1");
    bad_ts["releasedAtUtc"] = serde_json::json!("now");
    assert!(s.create_release(&bad_ts).is_err());
    let mut bad_id = release_json("rel 1; DROP", "1");
    bad_id["releaseId"] = serde_json::json!("rel 1; DROP");
    assert!(s.create_release(&bad_id).is_err());
    let mut wrong_plan = release_json("rel-1", "1");
    wrong_plan["plan"]["schema"] = serde_json::json!("other");
    assert!(s.create_release(&wrong_plan).is_err());
    assert!(s.create_release(&serde_json::json!({ "schema": "turnline.dispatch_release" })).is_err());
    assert!(s.list_releases(10).unwrap().is_empty());
}

#[test]
fn cancellation_needs_a_reason_and_is_final() {
    let mut s = Store::open_in_memory().unwrap();
    s.create_release(&release_json("rel-1", "1")).unwrap();
    assert!(s.cancel_release("rel-1", "2026-10-16T12:10:00Z", "   ").is_err());
    let c = s.cancel_release("rel-1", "2026-10-16T12:10:00Z", "Aircraft change").unwrap();
    assert_eq!((c.state.as_str(), c.cancel_reason.as_deref(), c.cancelled_at_utc.as_deref()), ("cancelled", Some("Aircraft change"), Some("2026-10-16T12:10:00Z")));
    assert!(s.cancel_release("rel-1", "2026-10-16T12:11:00Z", "again").unwrap_err().message.contains("already cancelled"));
    // cancelled -> released is impossible, also with raw SQL.
    assert!(s.conn.execute("UPDATE dispatch_releases SET state = 'released', cancelled_at_utc = NULL, cancel_reason = NULL, open_slot = 1", []).is_err());
    // A cancelled release can never be attached to a flight.
    open_flight(&mut s, "f-1");
    assert!(s.attach_release("rel-1", "f-1", "2026-10-16T12:40:00Z").unwrap_err().message.contains("cancelled"));
    assert!(s.conn.execute("UPDATE dispatch_releases SET flight_id = 'f-1', linked_at_utc = '2026-10-16T12:40:00Z'", []).is_err());
    // After cancelling, the same OFP can be released again as a new record.
    s.create_release(&release_json("rel-2", "1")).unwrap();
    assert_eq!(s.list_releases(10).unwrap().len(), 2);
    assert!(s.cancel_release("missing", "2026-10-16T12:10:00Z", "x").is_err());
}

#[test]
fn attaching_links_once_and_stores_the_released_plan_as_the_flight_snapshot() {
    let mut s = Store::open_in_memory().unwrap();
    s.create_release(&release_json("rel-1", "100")).unwrap();
    assert!(s.attach_release("rel-1", "not-saved", "2026-10-16T12:40:00Z").unwrap_err().message.contains("not been saved"));
    open_flight(&mut s, "f-1");
    let before = detail_json(&s, "f-1");
    let r = s.attach_release("rel-1", "f-1", "2026-10-16T12:40:00Z").unwrap();
    assert_eq!((r.flight_id.as_deref(), r.linked_at_utc.as_deref()), (Some("f-1"), Some("2026-10-16T12:40:00Z")));
    let snap = s.plan_snapshot("f-1").unwrap().unwrap().snapshot;
    assert_eq!(snap["releaseId"], "rel-1");
    assert_eq!(snap["plan"], plan_json("100"));
    assert_eq!(s.release_for_flight("f-1").unwrap().unwrap().record["releaseId"], "rel-1");
    // Recorded flight data is untouched.
    assert_eq!(detail_json(&s, "f-1"), before);
    // Linked releases cannot be cancelled, re-linked or moved.
    assert!(s.cancel_release("rel-1", "2026-10-16T13:00:00Z", "late").unwrap_err().message.contains("cannot be cancelled"));
    assert!(s.attach_release("rel-1", "f-1", "2026-10-16T12:41:00Z").unwrap_err().message.contains("already attached"));
    assert!(s.conn.execute("UPDATE dispatch_releases SET flight_id = NULL, linked_at_utc = NULL", []).is_err());
    // A new release can now be issued, but not attached to a flight that already has one.
    s.create_release(&release_json("rel-2", "200")).unwrap();
    assert!(s.attach_release("rel-2", "f-1", "2026-10-16T12:42:00Z").unwrap_err().message.contains("already has a flight plan"));
}

#[test]
fn a_release_is_not_attached_over_a_legacy_plan_snapshot() {
    let mut s = Store::open_in_memory().unwrap();
    open_flight(&mut s, "f-1");
    assert_eq!(s.associate_plan("f-1", &snapshot_json("f-1", "9")).unwrap(), AssociateOutcome::Created);
    s.create_release(&release_json("rel-1", "100")).unwrap();
    assert!(s.attach_release("rel-1", "f-1", "2026-10-16T12:40:00Z").is_err());
    assert_eq!(s.plan_snapshot("f-1").unwrap().unwrap().snapshot["plan"]["source"]["requestId"], "9");
    assert_eq!(s.release_for_flight("f-1").unwrap(), None);
    // The release stays open and usable for another flight.
    assert_eq!(s.list_releases(10).unwrap()[0].flight_id, None);
}

#[test]
fn releases_and_milestones_survive_reopen() {
    let path = temp_db("release-reopen");
    {
        let mut s = Store::open(&path).unwrap();
        open_flight(&mut s, "f-1");
        s.create_release(&release_json("rel-1", "100")).unwrap();
        s.attach_release("rel-1", "f-1", "2026-10-16T12:40:00Z").unwrap();
        s.record_milestone("f-1", "out", "2026-10-16T12:45:00Z", "real_world_utc").unwrap();
        s.create_release(&release_json("rel-2", "200")).unwrap();
        s.cancel_release("rel-2", "2026-10-16T13:00:00Z", "Weather").unwrap();
    }
    let s = Store::open(&path).unwrap();
    let all = s.list_releases(10).unwrap();
    assert_eq!(all.len(), 2);
    assert_eq!(s.release_for_flight("f-1").unwrap().unwrap().state, "released");
    assert_eq!(all.iter().find(|r| r.record["releaseId"] == "rel-2").unwrap().cancel_reason.as_deref(), Some("Weather"));
    assert_eq!(s.milestones("f-1").unwrap()[0].occurred_at_utc, "2026-10-16T12:45:00Z");
}

#[test]
fn manual_milestones_are_explicit_once_ordered_and_only_for_open_flights() {
    let mut s = Store::open_in_memory().unwrap();
    assert!(s.record_milestone("f-1", "out", "2026-10-16T12:45:00Z", "real_world_utc").is_err());
    open_flight(&mut s, "f-1");
    assert!(s.record_milestone("f-1", "off", "2026-10-16T12:45:00Z", "real_world_utc").is_err());
    assert!(s.record_milestone("f-1", "out", "12:45", "real_world_utc").is_err());
    assert_eq!(s.record_milestone("f-1", "out", "2026-10-16T12:45:00Z", "real_world_utc").unwrap(), MilestoneOutcome::Recorded);
    assert_eq!(s.record_milestone("f-1", "out", "2026-10-16T12:50:00Z", "real_world_utc").unwrap(), MilestoneOutcome::AlreadyRecorded);
    assert!(s.record_milestone("f-1", "in", "2026-10-16T12:00:00Z", "real_world_utc").is_err());
    assert_eq!(s.record_milestone("f-1", "in", "2026-10-16T15:00:00Z", "real_world_utc").unwrap(), MilestoneOutcome::Recorded);
    let m = s.milestones("f-1").unwrap();
    assert_eq!(m.iter().map(|x| (x.milestone.as_str(), x.occurred_at_utc.as_str())).collect::<Vec<_>>(), vec![("out", "2026-10-16T12:45:00Z"), ("in", "2026-10-16T15:00:00Z")]);
    assert!(s.conn.execute("UPDATE flight_manual_milestones SET occurred_at_utc = '2026-10-16T11:00:00Z'", []).is_err());
    // Closed flights cannot get new manual milestones.
    s.commit(&batch(flight("f-2", "completed", "2026-10-16T09:00:00.000Z"))).unwrap();
    assert!(s.record_milestone("f-2", "out", "2026-10-16T09:10:00Z", "real_world_utc").unwrap_err().message.contains("while the flight is open"));
}

#[test]
fn milestones_and_releases_never_change_recorded_flight_rows() {
    let mut s = Store::open_in_memory().unwrap();
    let mut b = batch(flight("f-1", "active", "2026-10-16T12:30:00.000Z"));
    b.events = vec![event(1, "flight.started")];
    b.samples = vec![sample(1)];
    s.commit(&b).unwrap();
    let before = detail_json(&s, "f-1");
    s.record_milestone("f-1", "out", "2026-10-16T12:45:00Z", "real_world_utc").unwrap();
    s.create_release(&release_json("rel-1", "1")).unwrap();
    s.attach_release("rel-1", "f-1", "2026-10-16T12:46:00Z").unwrap();
    assert_eq!(detail_json(&s, "f-1"), before);
    // Recording continues normally afterwards.
    let mut next = batch(flight("f-1", "active", "2026-10-16T12:30:00.000Z"));
    next.events = vec![event(2, "phase.changed")];
    s.commit(&next).unwrap();
    assert_eq!(detail_json(&s, "f-1")["events"].as_array().unwrap().len(), 2);
}

#[test]
fn upgrading_a_populated_v3_database_keeps_flights_plans_and_snapshots() {
    let path = temp_db("v3-upgrade");
    {
        let mut s = Store::open(&path).unwrap();
        s.commit(&batch(flight("old", "completed", "2026-10-01T10:00:00.000Z"))).unwrap();
        open_flight(&mut s, "open-1");
        s.save_dispatch_plan(&plan_json("77"), "2026-10-15T12:00:00Z").unwrap();
        s.associate_plan("old", &snapshot_json("old", "55")).unwrap();
        s.conn.execute_batch(DROP_V4).unwrap();
        s.conn.pragma_update(None, "user_version", 3).unwrap();
    }
    let mut s = Store::open(&path).unwrap();
    assert_eq!(s.schema_version().unwrap(), latest_schema_version());
    assert_eq!(s.list_flights(10, 0).unwrap().len(), 2);
    assert_eq!(s.dispatch_plan().unwrap().unwrap().plan["source"]["requestId"], "77");
    assert_eq!(s.plan_snapshot("old").unwrap().unwrap().snapshot["plan"]["source"]["requestId"], "55");
    assert_eq!(s.open_flight().unwrap().unwrap().id, "open-1");
    assert!(s.list_releases(10).unwrap().is_empty());
    s.create_release(&release_json("rel-1", "77")).unwrap();
    s.attach_release("rel-1", "open-1", "2026-10-16T12:40:00Z").unwrap();
}

// ---------- manual milestone clock source (schema v5, S2-02 decision 4) ----------

#[test]
fn manual_milestones_persist_their_real_world_utc_clock_source() {
    let path = temp_db("milestone-clock");
    {
        let mut s = Store::open(&path).unwrap();
        open_flight(&mut s, "f-1");
        // Simulator time (or anything else) is not an accepted clock for manual entries.
        assert!(s.record_milestone("f-1", "out", "2026-10-16T12:45:00Z", "simulator").unwrap_err().message.contains("real-world UTC"));
        assert!(s.record_milestone("f-1", "out", "2026-10-16T12:45:00Z", "").is_err());
        assert!(s.milestones("f-1").unwrap().is_empty());
        s.record_milestone("f-1", "out", "2026-10-16T12:45:00Z", "real_world_utc").unwrap();
        // The clock source is as immutable as the time, and the CHECK refuses other values.
        assert!(s.conn.execute("UPDATE flight_manual_milestones SET clock_source = 'real_world_utc'", []).is_err());
        assert!(s.conn.execute("INSERT INTO flight_manual_milestones (flight_id, milestone, occurred_at_utc, recorded_at_utc, clock_source) VALUES ('f-1', 'in', '2026-10-16T15:00:00Z', '2026-10-16T15:00:00Z', 'simulator')", []).is_err());
    }
    let s = Store::open(&path).unwrap();
    let m = s.milestones("f-1").unwrap();
    assert_eq!((m[0].occurred_at_utc.as_str(), m[0].clock_source.as_str()), ("2026-10-16T12:45:00Z", "real_world_utc"));
}

#[test]
fn upgrading_a_populated_v4_database_labels_existing_manual_milestones_real_world_utc() {
    let path = temp_db("v4-upgrade");
    {
        let mut s = Store::open(&path).unwrap();
        open_flight(&mut s, "f-1");
        s.create_release(&release_json("rel-1", "100")).unwrap();
        s.attach_release("rel-1", "f-1", "2026-10-16T12:40:00Z").unwrap();
        s.record_milestone("f-1", "out", "2026-10-16T12:45:00Z", "real_world_utc").unwrap();
        // Turn it into a genuine v4 database (no clock_source column).
        s.conn.execute_batch("DROP TRIGGER flight_manual_milestones_immutable; ALTER TABLE flight_manual_milestones DROP COLUMN clock_source; \
            CREATE TRIGGER flight_manual_milestones_immutable BEFORE UPDATE ON flight_manual_milestones BEGIN SELECT RAISE(ABORT, 'recorded milestones are immutable'); END; \
            DELETE FROM schema_migrations WHERE version = 5;").unwrap();
        s.conn.pragma_update(None, "user_version", 4).unwrap();
        let cols: i64 = s.conn.query_row("SELECT COUNT(*) FROM pragma_table_info('flight_manual_milestones') WHERE name = 'clock_source'", [], |r| r.get(0)).unwrap();
        assert_eq!(cols, 0);
    }
    let mut s = Store::open(&path).unwrap();
    assert_eq!(s.schema_version().unwrap(), latest_schema_version());
    let m = s.milestones("f-1").unwrap();
    assert_eq!((m.len(), m[0].clock_source.as_str()), (1, "real_world_utc"));
    assert_eq!(s.release_for_flight("f-1").unwrap().unwrap().record["releaseId"], "rel-1");
    assert_eq!(s.plan_snapshot("f-1").unwrap().unwrap().snapshot["releaseId"], "rel-1");
    // Still immutable after the upgrade; new entries work.
    assert!(s.conn.execute("UPDATE flight_manual_milestones SET occurred_at_utc = '2026-10-16T11:00:00Z'", []).is_err());
    s.record_milestone("f-1", "in", "2026-10-16T15:00:00Z", "real_world_utc").unwrap();
}
