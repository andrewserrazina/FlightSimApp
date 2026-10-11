# FlightSimApp — Sprint 1 Implementation Specification
Version 0.1 | Goal: proven simulator-to-debrief technical vertical slice

## Deliverable
A runnable Windows desktop prototype that connects to MSFS, displays real telemetry, records one flight lifecycle, survives an interruption, and saves a basic debrief. It must also run end-to-end with mock data on a development machine without MSFS or vendor credentials.

## Execution order
### S1-01 Repo foundation
- Monorepo scaffolding with Tauri v2 + React/TypeScript desktop, C# .NET bridge, contracts, flight-core and tests.
- Document prerequisite toolchains. CI builds/contracts/lints on appropriate OS runners.
- Add environment template; `.env`, signing keys and cloud service-role secrets excluded from Git.
- Ensure MSFS 2020 and MSFS 2024 selections can use capability-specific bridge implementations.

### S1-02 Contract-first bridge
- Define typed `ConnectionState`, `TelemetryFrameV1`, `FlightEventV1`, `BridgeHealthV1` with schema version, units and quality.
- Implement `ISimulatorAdapter`, `MockSimulatorAdapter`, `MsfsSimConnectAdapter`.
- Serialize all SimConnect access onto one dedicated thread; bind localhost IPC securely.
- Handle missing simulator, bridge restart, malformed messages and backoff reconnect.

### S1-03 Desktop UI
- Pages: Welcome/connection, Live Flight, Flight History, Debrief, Settings/Diagnostics.
- Real visible states: no sim, connecting, connected, stale, error, reconnecting.
- Basic accessible layout with keyboard focus, clear unit labels, no fake realtime information.
- Simulator mock mode labeled explicitly as demo data.

### S1-04 Persistence + lifecycle
- SQLite local event spool with indexes/unique event IDs and per-session sequence constraints.
- Flight lifecycle state machine with debounce and manual start/end override.
- Persist input frames with gaps; restore unfinished session after app restart.
- Compute basic duration, observed taxi/airborne times, max altitude and fuel delta only where source data supports it.

### S1-05 Cloud groundwork
- Baseline Postgres schema/migrations and RLS; optional Supabase login integration behind environment config.
- Auth-enabled cloud sync stub, not an insecure anonymous write endpoint.
- Account/profile/entitlement schema present; Stripe integration postponed to commercial sprint.
- User can complete prototype demo locally even if Supabase credentials absent.

### S1-06 QA, observability and release artifact
- Unit tests: transitions, debounce, telemetry normalization, deduplication, fuel-data absence, disconnect recovery.
- Integration test: mock flight fixture taxi->takeoff->landing->shutdown->debrief.
- Error reports redact identifiers and tokens. Diagnostics include bridge version and connection health.
- Produce unsigned internal Windows build with repeatable instructions, *not* a general-public installer until signing/update/security checks.

## Test matrix
| Test | Expected outcome |
|---|---|
| Open without simulator | App operates, shows disconnected and retry |
| Connect to supported MSFS version | Telemetry and sim version appear, no fake values |
| Flight phases from replay | One ordered flight history, no rapid toggling |
| Kill bridge for 30s | STALE/RECONNECTING; gap recorded; session resumes |
| Kill desktop during flight | Restarts into saved active flight |
| Network disabled for 10m | Local sample record persists; cloud sync pending |
| Duplicate frames/events | Exactly one stored canonical event |
| Fuel unavailable | Debrief says unavailable, not 0 kg |
| Unknown aircraft telemetry | Missing fields marked unknown; no crash |
| Complete mock flight | Saved debrief and repeatable fixture results |

## Acceptance gate: DONE only if
- Clean clone builds on documented Windows environment.
- Both `MockSimulatorAdapter` and MSFS adapter compile and can be selected; real MSFS runtime test evidence recorded separately for 2020 and 2024.
- Real MSFS telemetry proven with at least one tested aircraft for each supported simulator version before claiming support.
- No simulator installed => no fatal error.
- Flight recovery, deduplication, state machine and debrief test cases pass.
- RLS denies cross-user flight access in tests.
- README documents features, gaps, setup and reproducible test commands.

## Out of scope / explicit follow-on tickets
- SimBrief authorization and OFP import; GSX API proof-of-concept; passenger manifests; TOBT; EDCT; airport flow; Stripe checkout/webhooks; airline administration; paid launch.

## Risks and unknowns for Sprint 1
- Actual test PC and simulator installations; the implementation may compile without runtime verification.
- Default simulator aircraft telemetry differs; document field-level compatibility rather than claiming universal aircraft support.
- Windows code-signing / distribution setup may require commercial infrastructure.

## Recommended initial Claude Code task
Implement ONLY S1-01 and S1-02 initially. Create scaffold, typed contracts, mock bridge, and tests. Do not simulate project completion or commit secrets. Return changed files, build commands, test results and blockers. Once stable, complete remaining tickets in order with a review at each gate.
