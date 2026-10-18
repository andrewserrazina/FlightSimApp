//! S2-05 store tests: turnarounds, receipt import, currency confirmation and the expense ledger.
//! Receipts come from the sanitized real KBOS GSX Fuel receipt, scanned from a temporary folder laid out
//! like GSX's `Receipts\<group>\` tree; negative cases are one-text-change variants of it.

use std::path::{Path, PathBuf};

use super::{open_flight, temp_db};
use crate::receipts::scan::{scan, RootStatus};
use crate::store::ledger::{ManualExpense, RevisionResolution};
use crate::store::turnaround::TurnaroundOpen;
use crate::store::Store;

const KBOS: &str = include_str!("../../../../../../fixtures/gsx/receipts/fuel-kbos-sanitized.html");
const KBOS_TOTAL_MINOR: i64 = 2_802_240;

fn variant(from: &str, to: &str) -> String {
    assert_eq!(KBOS.matches(from).count(), 1, "fixture must contain {from:?} exactly once");
    KBOS.replacen(from, to, 1)
}

/// A fresh `Receipts` folder holding the given files under `Fuel\`.
fn receipts_root(name: &str, files: &[(&str, &str)]) -> PathBuf {
    let root = std::env::temp_dir().join(format!("flightsim-receipts-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("Fuel")).unwrap();
    for (file, html) in files {
        std::fs::write(root.join("Fuel").join(file), html).unwrap();
    }
    root
}

fn add_file(root: &Path, file: &str, html: &str) {
    std::fs::write(root.join("Fuel").join(file), html).unwrap();
}

fn import(s: &mut Store, root: &Path) -> crate::store::ledger::ImportReport {
    s.receipts_import(scan(root)).unwrap()
}

fn only_receipt(s: &mut Store) -> crate::store::ledger::ReceiptOut {
    let mut all = s.receipts_list().unwrap();
    assert_eq!(all.len(), 1);
    all.pop().unwrap()
}

fn active_total(s: &Store, flight: Option<&str>, currency: &str) -> i64 {
    s.expenses_list(flight).unwrap().iter().filter(|e| e.status == "active" && e.currency == currency).map(|e| e.amount_minor).sum()
}

fn departure() -> TurnaroundOpen {
    TurnaroundOpen { side: "departure".into(), airport_icao: Some("kbos".into()), airport_source: Some("user".into()), gate_text: Some("B12".into()) }
}

// ---------- the owner's acceptance path, end to end ----------

#[test]
fn kbos_receipt_is_imported_confirmed_associated_and_counted_once_across_restarts() {
    let db = temp_db("s205-kbos");
    let root = receipts_root("kbos", &[("GSX-20261017T164423Z-KBOS.html", KBOS)]);
    let receipt_id;
    {
        let mut s = Store::open(&db).unwrap();
        open_flight(&mut s, "f-1");
        let report = import(&mut s, &root);
        assert_eq!((report.root_status.clone(), report.imported, report.duplicates), (RootStatus::Found, 1, 0));

        let r = only_receipt(&mut s);
        receipt_id = r.id.clone();
        assert_eq!(r.review_state, "needs_currency_confirmation");
        assert_eq!(r.receipt_number.as_deref(), Some("GSX-20261017T164423Z-KBOS"));
        assert!(r.compatible_currencies.contains(&"USD".to_string()) && r.compatible_currencies.contains(&"CAD".to_string()));
        assert!(!r.compatible_currencies.contains(&"EUR".to_string()), "$ cannot denote EUR");
        assert!(r.confirmations.is_empty() && r.flight_id.is_none(), "nothing is confirmed or associated automatically");

        // Not countable before the person confirms; incompatible codes are refused.
        assert!(s.expense_create_from_receipt(&receipt_id, None).is_err());
        assert!(s.receipt_confirm_currency(&receipt_id, "EUR", None, false).is_err());
        assert!(s.receipt_confirm_currency(&receipt_id, "XYZ", None, false).is_err());

        let r = s.receipt_confirm_currency(&receipt_id, "usd", Some("Boston, US airport"), false).unwrap();
        assert_eq!(r.review_state, "currency_confirmed");
        let c = &r.confirmations[0];
        assert_eq!((c.currency.as_str(), c.confirmed_by.as_str(), c.receipt_sha256.as_str()), ("USD", "local", r.sha256.as_str()));
        assert!(c.confirmed_at_utc.ends_with('Z') && c.confirmed_at_utc.contains('T'));

        s.receipt_associate(&receipt_id, Some("f-1"), None).unwrap();
        let e = s.expense_create_from_receipt(&receipt_id, None).unwrap();
        assert_eq!((e.amount_minor, e.currency.as_str(), e.minor_exponent), (KBOS_TOTAL_MINOR, "USD", 2));
        assert_eq!((e.source.as_str(), e.category.as_str(), e.currency_source.as_str(), e.cost_kind.as_str()), ("gsx_invoiced", "fuel", "user_confirmed", "simulated"));
        assert_eq!(e.flight_id.as_deref(), Some("f-1"));
        assert_eq!(e.printed_total.as_deref(), Some("$ 28,022.40"));
        assert_eq!(e.audit[0].action, "created");
        assert!(s.expense_create_from_receipt(&receipt_id, None).is_err(), "a receipt is counted once");

        // Re-scanning the same folder imports nothing new.
        let again = import(&mut s, &root);
        assert_eq!((again.imported, again.duplicates), (0, 1));
    }
    // After a restart: the same single expense, and a re-import still adds nothing.
    let mut s = Store::open(&db).unwrap();
    assert_eq!(active_total(&s, Some("f-1"), "USD"), KBOS_TOTAL_MINOR);
    assert_eq!(s.expenses_list(None).unwrap().len(), 1);
    let again = import(&mut s, &root);
    assert_eq!((again.imported, again.duplicates), (0, 1));
    assert_eq!(active_total(&s, None, "USD"), KBOS_TOTAL_MINOR);
    let r = only_receipt(&mut s);
    assert_eq!((r.id.as_str(), r.review_state.as_str(), r.active_expense_id.is_some()), (receipt_id.as_str(), "currency_confirmed", true));
}

#[test]
fn a_receipt_that_prints_its_currency_code_counts_without_confirmation() {
    let mut s = Store::open_in_memory().unwrap();
    let root = receipts_root("explicit", &[("usd.html", &KBOS.replace("<td class=\"amount\">$ ", "<td class=\"amount\">USD "))]);
    import(&mut s, &root);
    let r = only_receipt(&mut s);
    assert_eq!((r.review_state.as_str(), r.compatible_currencies.len()), ("verified", 0));
    assert!(s.receipt_confirm_currency(&r.id, "USD", None, false).is_err(), "nothing to confirm");
    let e = s.expense_create_from_receipt(&r.id, None).unwrap();
    assert_eq!((e.amount_minor, e.currency_source.as_str(), e.flight_id.is_none()), (KBOS_TOTAL_MINOR, "receipt_explicit", true), "unassigned is allowed");
}

#[test]
fn confirmation_never_bypasses_other_receipt_problems() {
    for (name, html, state) in [
        ("total", variant(r#"<td class="amount">$ 28,022.40</td>"#, r#"<td class="amount">$ 28,022.41</td>"#), "needs_review"),
        ("conflict", variant("$ 1,122.14", "€ 1,122.14"), "needs_review"),
        ("volume", variant("5147 Gallons", "5148 Gallons"), "needs_review"),
        ("layout", variant(r#"<table class="items">"#, r#"<table class="charges">"#), "unsupported"),
        ("hostile", r#"<html><body><script>alert(1)</script><img src=x onerror=alert(1)></body></html>"#.to_string(), "unsupported"),
    ] {
        let mut s = Store::open_in_memory().unwrap();
        let root = receipts_root(&format!("refuse-{name}"), &[("r.html", &html)]);
        let report = import(&mut s, &root);
        assert_eq!((report.imported, report.not_verifiable), (1, 1), "{name}");
        let r = only_receipt(&mut s);
        assert_eq!(r.review_state, state, "{name}");
        assert!(r.compatible_currencies.is_empty(), "{name}");
        assert!(s.receipt_confirm_currency(&r.id, "USD", None, false).is_err(), "{name}");
        assert!(s.expense_create_from_receipt(&r.id, None).is_err(), "{name}");
        assert!(s.expenses_list(None).unwrap().is_empty(), "{name}");
    }
}

#[test]
fn correcting_a_confirmation_supersedes_it_and_its_expense_with_an_audit_trail() {
    let mut s = Store::open_in_memory().unwrap();
    open_flight(&mut s, "f-1");
    let root = receipts_root("correct", &[("r.html", KBOS)]);
    import(&mut s, &root);
    let id = only_receipt(&mut s).id;
    s.receipt_confirm_currency(&id, "USD", None, false).unwrap();
    s.receipt_associate(&id, Some("f-1"), None).unwrap();
    let first = s.expense_create_from_receipt(&id, None).unwrap();

    assert!(s.receipt_confirm_currency(&id, "CAD", None, false).is_err(), "a correction must be explicit");
    assert!(s.receipt_confirm_currency(&id, "USD", None, true).is_err(), "same currency is not a correction");
    let r = s.receipt_confirm_currency(&id, "CAD", Some("Mis-click"), true).unwrap();
    assert_eq!(r.confirmations.len(), 2);
    let old = r.confirmations.iter().find(|c| c.currency == "USD").unwrap();
    let new = r.confirmations.iter().find(|c| c.currency == "CAD").unwrap();
    assert_eq!(old.superseded_by.as_deref(), Some(new.id.as_str()));
    assert!(old.superseded_at_utc.is_some() && new.superseded_by.is_none());

    let old_e = s.expense_get(&first.id).unwrap();
    assert_eq!(old_e.status, "superseded");
    let new_e = s.expense_get(old_e.superseded_by.as_deref().unwrap()).unwrap();
    assert_eq!((new_e.currency.as_str(), new_e.amount_minor, new_e.flight_id.as_deref()), ("CAD", KBOS_TOTAL_MINOR, Some("f-1")));
    assert_eq!(new_e.confirmation_id.as_deref(), Some(new.id.as_str()));
    assert_eq!(old_e.audit.iter().map(|a| a.action.as_str()).collect::<Vec<_>>(), ["created", "superseded"]);
    assert_eq!((active_total(&s, None, "USD"), active_total(&s, None, "CAD")), (0, KBOS_TOTAL_MINOR), "never double-counted");
}

#[test]
fn a_possible_revision_needs_an_explicit_resolution_before_it_is_counted() {
    let mut s = Store::open_in_memory().unwrap();
    let root = receipts_root("revision", &[("a.html", KBOS)]);
    import(&mut s, &root);
    let first = only_receipt(&mut s).id;
    s.receipt_confirm_currency(&first, "USD", None, false).unwrap();
    let first_e = s.expense_create_from_receipt(&first, None).unwrap();

    add_file(&root, "b.html", &variant("Example Airline Inc.", "Example Airlines Inc."));
    let report = import(&mut s, &root);
    assert_eq!((report.imported, report.duplicates, report.possible_revisions), (1, 1, 1));
    let revised = s.receipts_list().unwrap().into_iter().find(|r| r.id != first).unwrap();
    assert_eq!(revised.possible_revision_of, vec![first.clone()]);
    s.receipt_confirm_currency(&revised.id, "USD", None, false).unwrap();

    assert!(s.expense_create_from_receipt(&revised.id, None).is_err(), "would double count");
    assert!(s.expense_create_from_receipt(&revised.id, Some(RevisionResolution::Supersedes { expense_id: "nope".into() })).is_err());
    let e = s.expense_create_from_receipt(&revised.id, Some(RevisionResolution::Supersedes { expense_id: first_e.id.clone() })).unwrap();
    let old = s.expense_get(&first_e.id).unwrap();
    assert_eq!((old.status.as_str(), old.superseded_by.as_deref()), ("superseded", Some(e.id.as_str())));
    assert_eq!(active_total(&s, None, "USD"), KBOS_TOTAL_MINOR);
}

#[test]
fn manual_expenses_void_and_totals_stay_per_currency() {
    let mut s = Store::open_in_memory().unwrap();
    open_flight(&mut s, "f-1");
    let manual = |amount: i64, currency: &str| ManualExpense {
        category: "catering".into(),
        description: "Crew meals".into(),
        amount_minor: amount,
        currency: currency.into(),
        flight_id: Some("f-1".into()),
        turnaround_id: None,
        note: None,
    };
    let a = s.expense_create_manual(&manual(12_500, "usd")).unwrap();
    assert_eq!((a.currency.as_str(), a.currency_source.as_str(), a.source.as_str()), ("USD", "user_entered", "manual"));
    s.expense_create_manual(&manual(9_000, "EUR")).unwrap();
    assert!(s.expense_create_manual(&manual(0, "USD")).is_err());
    assert!(s.expense_create_manual(&manual(100, "XYZ")).is_err());
    assert!(s.expense_create_manual(&ManualExpense { category: "estimated".into(), ..manual(100, "USD") }).is_err());
    assert!(s.expense_create_manual(&ManualExpense { flight_id: Some("missing".into()), ..manual(100, "USD") }).is_err());
    assert_eq!((active_total(&s, Some("f-1"), "USD"), active_total(&s, Some("f-1"), "EUR")), (12_500, 9_000));

    assert!(s.expense_void(&a.id, " ").is_err(), "a reason is required");
    let v = s.expense_void(&a.id, "Entered twice").unwrap();
    assert_eq!((v.status.as_str(), v.audit.last().unwrap().action.as_str()), ("voided", "voided"));
    assert!(s.expense_void(&a.id, "again").is_err());
    assert!(s.expense_associate(&a.id, None, None).is_err(), "voided expenses do not change");
    assert_eq!(active_total(&s, Some("f-1"), "USD"), 0);
}

#[test]
fn ledger_records_are_immutable_and_kept() {
    let mut s = Store::open_in_memory().unwrap();
    let root = receipts_root("immutable", &[("r.html", KBOS)]);
    import(&mut s, &root);
    let id = only_receipt(&mut s).id;
    s.receipt_confirm_currency(&id, "USD", None, false).unwrap();
    let e = s.expense_create_from_receipt(&id, None).unwrap();
    for sql in [
        "UPDATE expenses SET amount_minor = 1",
        "UPDATE expenses SET currency = 'CAD'",
        "DELETE FROM expenses",
        "UPDATE gsx_receipts SET parsed_json = '{}'",
        "UPDATE gsx_receipts SET raw_source = x'00'",
        "DELETE FROM gsx_receipts",
        "UPDATE receipt_currency_confirmations SET currency = 'CAD'",
        "DELETE FROM receipt_currency_confirmations",
        "UPDATE expense_audit SET detail = 'x'",
        "DELETE FROM expense_audit",
    ] {
        assert!(s.conn.execute(sql, []).is_err(), "{sql}");
    }
    // A void is final.
    s.expense_void(&e.id, "test").unwrap();
    assert!(s.conn.execute("UPDATE expenses SET status = 'active', void_reason = NULL", []).is_err());
    assert!(s.receipt_dismiss(&id).is_ok(), "dismissal is allowed once nothing is counted");
}

#[test]
fn dismissing_a_counted_receipt_is_refused() {
    let mut s = Store::open_in_memory().unwrap();
    let root = receipts_root("dismiss", &[("r.html", KBOS)]);
    import(&mut s, &root);
    let id = only_receipt(&mut s).id;
    s.receipt_confirm_currency(&id, "USD", None, false).unwrap();
    s.expense_create_from_receipt(&id, None).unwrap();
    assert!(s.receipt_dismiss(&id).is_err());
}

// ---------- scanning GSX's folder ----------

#[test]
fn scan_reads_only_bounded_html_files_and_never_follows_links() {
    let root = receipts_root("scan", &[("ok.html", KBOS), ("notes.txt", "x")]);
    std::fs::write(root.join("Fuel").join("big.html"), vec![b'a'; crate::receipts::fuel::MAX_RECEIPT_BYTES + 1]).unwrap();
    std::fs::create_dir_all(root.join("Fuel").join("a").join("b").join("c")).unwrap();
    std::fs::write(root.join("Fuel").join("a").join("b").join("c").join("deep.html"), KBOS).unwrap();
    #[cfg(unix)]
    {
        let outside = std::env::temp_dir().join(format!("flightsim-receipts-outside-{}.html", std::process::id()));
        std::fs::write(&outside, KBOS).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("Fuel").join("link.html")).unwrap();
    }
    let r = scan(&root);
    assert_eq!(r.root_status, RootStatus::Found);
    assert_eq!(r.files.iter().map(|f| (f.group.as_str(), f.file_name.as_str())).collect::<Vec<_>>(), [("Fuel", "ok.html")]);
    let skipped: Vec<_> = r.skipped.iter().map(|k| (k.file_name.as_str(), k.reason.as_str())).collect();
    assert!(skipped.contains(&("big.html", "larger than the receipt size limit")));
    #[cfg(unix)]
    assert!(skipped.contains(&("link.html", "link not followed")));

    assert_eq!(scan(&root.join("missing")).root_status, RootStatus::NotFound);
}

// ---------- turnarounds ----------

#[test]
fn a_departure_turnaround_opens_before_recording_and_is_linked_only_by_the_user() {
    let mut s = Store::open_in_memory().unwrap();
    let t = s.turnaround_open(&departure()).unwrap();
    assert_eq!((t.status.as_str(), t.flight_link.as_str(), t.flight_id.is_none()), ("open", "unlinked", true));
    assert_eq!((t.airport_icao.as_deref(), t.gate_text.as_deref()), (Some("KBOS"), Some("B12")));
    assert!(s.turnaround_open(&departure()).is_err(), "one unfinished turnaround at a time");

    open_flight(&mut s, "f-1");
    assert!(s.turnaround_get(&t.id).unwrap().flight_id.is_none(), "starting a recording does not link it");
    let t = s.turnaround_link_flight(&t.id, "f-1").unwrap();
    assert_eq!((t.flight_id.as_deref(), t.flight_link.as_str()), (Some("f-1"), "user_confirmed"));
    assert!(s.conn.execute("UPDATE turnarounds SET flight_id = NULL, flight_link = 'unlinked'", []).is_err());
    assert_eq!(s.turnarounds_for_flight("f-1").unwrap().len(), 1);

    s.turnaround_set_status(&t.id, "close", None).unwrap();
    assert!(s.turnaround_set_status(&t.id, "resume", None).is_err(), "closed is final");
    // While recording, a new turnaround links to that flight automatically.
    let arr = s.turnaround_open(&TurnaroundOpen { side: "arrival".into(), airport_icao: None, airport_source: None, gate_text: None }).unwrap();
    assert_eq!((arr.flight_id.as_deref(), arr.flight_link.as_str()), (Some("f-1"), "recording_at_open"));
}

#[test]
fn gsx_observations_are_validated_deduplicated_and_kept_apart_from_manual_entries() {
    let mut s = Store::open_in_memory().unwrap();
    let t = s.turnaround_open(&departure()).unwrap();
    let at = "2026-10-17T16:40:00.000Z";
    assert!(s.turnaround_record_gsx(&t.id, "boarding", "requested", 4.0, at).unwrap());
    assert!(!s.turnaround_record_gsx(&t.id, "boarding", "requested", 4.0, at).unwrap(), "unchanged state is not recorded twice");
    assert!(s.turnaround_record_gsx(&t.id, "boarding", "being_performed", 5.0, at).unwrap());
    assert!(s.turnaround_record_gsx(&t.id, "boarding", "completed", 5.0, at).is_err(), "raw must match the state");
    assert!(s.turnaround_record_gsx(&t.id, "lavatory", "completed", 6.0, at).is_err());
    assert!(s.turnaround_record_gsx(&t.id, "boarding", "completed", 6.0, "yesterday").is_err());
    assert!(s.turnaround_record_manual(&t.id, "catering", "completed", "  ").is_err(), "manual entries need a note");
    let t = s.turnaround_record_manual(&t.id, "catering", "completed", "Catering truck left").unwrap();
    assert_eq!(t.events.len(), 3);
    let manual = t.events.iter().find(|e| e.source == "manual").unwrap();
    assert_eq!((manual.gsx_state.as_deref(), manual.manual_status.as_deref()), (None, Some("completed")));
    assert!(s.conn.execute("UPDATE turnaround_service_events SET gsx_state = 'completed'", []).is_err());
    assert!(s.conn.execute("DELETE FROM turnaround_service_events", []).is_err());

    assert!(s.turnaround_record_feed(&t.id, "live").unwrap());
    assert!(!s.turnaround_record_feed(&t.id, "live").unwrap());
    assert!(s.turnaround_record_feed(&t.id, "stale").unwrap());
}

#[test]
fn an_app_restart_interrupts_the_open_turnaround_until_the_user_resumes_it() {
    let db = temp_db("s205-restart");
    let id = {
        let mut s = Store::open(&db).unwrap();
        let t = s.turnaround_open(&departure()).unwrap();
        s.turnaround_record_gsx(&t.id, "refueling", "being_performed", 5.0, "2026-10-17T16:40:00.000Z").unwrap();
        t.id
    };
    let mut s = Store::open(&db).unwrap();
    let t = s.turnaround_mark_restarted().unwrap().unwrap();
    assert_eq!(t.id, id);
    assert_eq!(t.status, "interrupted");
    assert_eq!(t.feed_log.last().unwrap().feed, "app_restarted");
    assert_eq!(t.events.len(), 1, "no transitions are invented for the gap");
    assert!(s.turnaround_record_gsx(&id, "refueling", "completed", 6.0, "2026-10-17T16:50:00.000Z").is_err());
    s.turnaround_set_status(&id, "resume", None).unwrap();
    assert!(s.turnaround_record_gsx(&id, "refueling", "completed", 6.0, "2026-10-17T16:50:00.000Z").unwrap());
    assert!(s.turnaround_set_status(&id, "abandon", None).is_err(), "abandoning needs a reason");
    let t = s.turnaround_set_status(&id, "abandon", Some("Changed aircraft")).unwrap();
    assert_eq!((t.status.as_str(), t.close_reason.as_deref()), ("abandoned", Some("Changed aircraft")));
    assert!(s.turnaround_current().unwrap().is_none());
    assert!(s.conn.execute("DELETE FROM turnarounds", []).is_err());
}

#[test]
fn expenses_can_be_associated_with_a_turnaround_but_not_across_flights() {
    let mut s = Store::open_in_memory().unwrap();
    open_flight(&mut s, "f-1");
    let t = s.turnaround_open(&departure()).unwrap();
    let root = receipts_root("assoc", &[("r.html", KBOS)]);
    import(&mut s, &root);
    let id = only_receipt(&mut s).id;
    let r = s.receipt_associate(&id, None, Some(&t.id)).unwrap();
    assert_eq!((r.turnaround_id.as_deref(), r.flight_id.as_deref()), (Some(t.id.as_str()), Some("f-1")), "flight follows the turnaround");
    s.commit(&super::batch(super::flight("f-2", "completed", "2026-10-15T12:30:00.000Z"))).unwrap();
    assert!(s.receipt_associate(&id, Some("f-2"), Some(&t.id)).is_err());
    assert!(s.receipt_associate(&id, None, None).is_err());
}
