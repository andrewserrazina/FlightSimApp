# FlightSimApp — Product Requirements Document
Version 0.1 | 2026-10-10 | Status: proposed baseline

## Vision
FlightSimApp is a subscription-based, pilot-first virtual airline operations experience for desktop flight simulators. The pilot flies; the system coordinates dispatch, passengers, turnaround and operational consequences. A future airline-management interface will reuse the same flight, airline, fleet and event domain model.

## Decisions
- First market: Windows PC users of MSFS 2020 and MSFS 2024; hardware simulator compatibility must be tested, not assumed.
- First UX: pilot-first; airline management deferred.
- Business model: free limited experience + one Pro plan, with tentative prices $14.99/month and $129/year; unvalidated hypotheses, not configured products.
- Cloud account required for subscription; flight recording must survive brief network outages locally.
- Prefer deterministic events over opaque AI decisions; optional AI dialogue later.
- Actual FAA EDCT/European A-CDM constraints must never be represented as real without a licensed, authoritative source and explicit provenance.

## Personas & jobs-to-be-done
1. Casual airliner pilot: wants a complete airline-style flight without manually role-playing every station.
2. Advanced simmer: wants believable operational rules, flight plans, delays and detailed debriefs.
3. Future virtual airline administrator: wants shared fleet rotations and management without a rewrite.

## MVP user journey
1. Sign in or enter demo mode.
2. See simulator connection status, supported simulator version and aircraft telemetry.
3. Pick an aircraft/route or start an ad-hoc flight; import a SimBrief-generated OFP in a later phase.
4. Review dispatch release: origin, destination, planned time, route, aircraft, fuel planning (future for SimBrief).
5. Start flight; detect and display phases from parked to arrival/shutdown.
6. Recover gracefully from sim disconnect, app restart or network interruption.
7. Complete and save a basic debrief, comparing planned versus observed time and fuel where reliably available.

## Release scopes
### Sprint 1 — Connectivity vertical slice (committed)
- Windows desktop shell; local bridge; typed telemetry protocol; simulator connection states; authentication scaffold; local record/replay; simulator session and flight lifecycle scaffold; offline-safe basic debrief; migration-ready database schema; automated test harness and diagnostics.
- Provide a `MockSimulatorAdapter` so UI and tests work without MSFS.
- No promises of SimBrief, GSX or complete airline ops in this sprint.

### Beta foundation (subsequent sprints)
- SimBrief OFP import with permission-compliant authentication and explicit data mapping.
- Passenger manifest simulation and synthetic events (clearly simulated).
- GSX adapter with graceful standalone fallback after verifying documented capabilities and permitted integration methods.
- TOBT calculation and reason-coded delays; slot management with simulated versus authoritative sources separated.
- Flight analytics/debrief, entitlement enforcement and Stripe self-service billing.

### Excluded from initial paid beta
- Full airline finances, airline ownership/management UI, crew rosters and multiplayer operations.
- Guaranteed GSX control across add-on versions; real traffic-flow slots without authoritative source.
- Voice AI, realistic medical emergency simulations, live airline schedules and airports data licensing.

## Functional requirements
FR-01: Connection state is one of DISCONNECTED, CONNECTING, CONNECTED, STALE, RECONNECTING, ERROR; UI accurately reflects it.
FR-02: Telemetry frames use explicit SI/aviation units, UTC timestamps, sequence numbers and quality flags.
FR-03: Disconnect and reconnection do not duplicate a flight or silently fill a telemetry gap.
FR-04: Flight detection is event-driven, debounced, and stores confidence and source.
FR-05: A flight has independent planned and actual timing records, both UTC.
FR-06: One active flight per pilot+simulator session; state survives process restart using durable local storage.
FR-07: An imported flight plan is immutable as a versioned dispatch release; later amendments create revisions.
FR-08: Passenger/cargo events are idempotent and do not claim simulator write capability without confirmation.
FR-09: Operational restrictions include source_type, provenance, validity interval and simulation label.
FR-10: A debrief cites measured versus estimated metrics and displays missing data honestly.
FR-11: Entitlements must be checked server-side; no billing secrets shipped to client.
FR-12: Future airline-management domain entities exist but are not exposed prematurely.

## Quality targets (engineering targets, not external claims)
- P95 local UI telemetry display lag under 500 ms on a reference PC under normal conditions.
- Local recording tolerates at least 10 minutes without cloud connectivity.
- >99% of valid replay frames persist exactly once in deterministic tests.
- Reconnection preserves flight ID and inserts gap markers.
- No hard crash on simulator absence, malformed frames, sidecar failure, or subscription service outage.
- Export/delete personal flight history; minimal PII in passenger manifests (synthetic passenger records).

## Commercial validation
- Run private pilot usability sessions after first full lifecycle.
- Verify willingness to pay for $14.99 monthly and $129 annually before public billing launch.
- Instrument: onboarding completion, successful sim connections, first flight completed, OFP import success, GSX integration success, debrief viewed, trial-to-paid conversion, 30-day retention, crashes per active user.
- Pricing strategy is a test hypothesis; no projections without measured conversion and infrastructure costs.

## Risks & assumptions
- API/licensing: SimBrief generation requires appropriate developer access; start with separate OFP import workflow, never scrape credentials.
- GSX remote API features/version/terms require documented verification and hands-on testing.
- MSFS aircraft and third-party avionics expose telemetry inconsistently; maintain capability matrix and confidence flags.
- Windows packaging/signing, safe auto-updates and local IPC security are first-class release requirements.
- Copyright/trademarks: don't imply airline affiliation; use fictional defaults and allow user-provided airline identity in a rights-respecting way.

## Definition of first commercial beta
A new user can install, register, select an airline flight, import a permitted dispatch plan, complete a monitored flight with simulated passengers and reliable ground-service fallback, receive a clear debrief, and subscribe/cancel without intervention. A narrower technical Sprint 1 is not itself paid-beta-ready.
