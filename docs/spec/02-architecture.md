# FlightSimApp — Technical Architecture
Version 0.1 | 2026-10-10

## Principles
- A modular monolith in the backend at first; do not deploy independent microservices prematurely.
- Local-first live telemetry; cloud for identities, entitlements, synchronization, durable cross-device history and future shared airlines.
- Simulator adapters, vendor adapters and airline core are separate packages. Events are the integration boundary.
- Business time uses UTC `timestamptz`; operator/airport local time is presentation only.
- Disallow silent fabrication of authoritative ATC/slot data.

## Deployment topology
```
Windows desktop:
  Tauri 2 / React + TypeScript
       | local loopback IPC (authenticated, restricted origin)
  .NET 8+ C# bridge sidecar
       | SimConnect (single dedicated serialized client thread)
  MSFS 2020 or MSFS 2024
       |
  SQLite spool (flight sessions, sequenced frames, outage queue)
       |
  HTTPS authenticated sync
Cloud:
  API (Node.js/TypeScript, modular monolith)
       | auth and PostgreSQL (Supabase)
       | Stripe webhooks + entitlement service
       | future SimBrief, GSX coordination and content APIs
```
Do not expose the bridge on a public interface. Prefer OS-specific named pipes or restricted loopback with ephemeral bearer token and origin validation. Never expose service-role or Stripe secret keys to desktop. Scope IPC commands narrowly and sanitize log data.

## Modules / bounded contexts
- `identity`: users, settings, sessions, login and deletion.
- `billing`: product tiers, provider events, idempotent webhook handling, entitlement projection.
- `airline`: airlines, fleets, aircraft, schedules; only a system-managed airline exposed at first.
- `operations`: flights, planned rotations, phase timeline, operational events, causes and delay attribution.
- `dispatch`: OFP releases, flight plan revisions, fuel/alternate provenance.
- `telemetry`: observations, unit normalization, quality and reconnect gaps.
- `passenger`: synthetic manifests, seat/bag totals and deterministic boarding progress.
- `turnaround`: tasks and target-off-block calculation; future GSX adapter.
- `restrictions`: simulated/authoritative constraint provenance with jurisdiction-scoped rules.
- `debrief`: measured versus inferred metrics with source attribution.

## Event envelope (canonical)
```json
{
  "event_id": "uuid",
  "schema_version": 1,
  "event_type": "sim.telemetry.sampled",
  "tenant_id": "uuid-or-null",
  "flight_id": "uuid-or-null",
  "session_id": "uuid",
  "occurred_at": "2026-10-10T21:00:00Z",
  "received_at": "2026-10-10T21:00:00.090Z",
  "seq": 1234,
  "source": "simconnect-msfs2024",
  "source_kind": "observed",
  "payload": {"on_ground":true,"ground_speed_kt":0,"pressure_altitude_ft":123,"fuel_total_kg":5120},
  "quality": {"confidence":"high","missing":[],"gap":false}
}
```
IDs must be UUIDs, event uniqueness enforced by `event_id`; ordering is `(session_id,seq)` and timestamps are not a reliable unique ordering key. Treat raw readings with unit conversions at adapter ingress. Schema versions require forward-compatible migration.

## Flight lifecycle
PLANNED -> PREPARING -> BOARDING -> READY -> TAXI_OUT -> AIRBORNE -> APPROACH -> LANDED -> TAXI_IN -> COMPLETED (or CANCELLED / ABORTED / DIVERTED). Start with an intentionally small detector (`PARKED`, `TAXI_OUT`, `AIRBORNE`, `LANDED`, `TAXI_IN`, `COMPLETED`), and model uncertain transitions through manual correction. Persist state transitions as idempotent events, not client-only flags. A user may explicitly end an abandoned flight.

## Telemetry baseline
- simulator_connected, simulator_version (where detectable), aircraft_title/icao_type (if available)
- on_ground, lat_deg, lon_deg, indicated_altitude_ft, radio_altitude_ft (when available)
- indicated_airspeed_kt, ground_speed_kt, vertical_speed_fpm, heading_deg
- total_fuel_kg (when possible), engine_count/engine_running (when possible), parking_brake (when possible)
- sample_monotonic_seq, observed UTC, units, availability/quality per reading
Baseline polling target: 2 Hz for dashboard and phase detection; higher-frequency landing data later with explicit capability and performance tests. Never treat an unavailable sensor as zero.

## Integration contracts
### SimConnect
Out-of-process C# bridge recommended by Microsoft; avoid thread-unsafe concurrent SDK calls. Maintain simulator-version-specific test fixtures and feature flags.
Official: https://docs.flightsimulator.com/msfs2024/retail/programming-apis/simconnect/simconnect-sdk/

### SimBrief (not Sprint 1)
Allow user to import a generated OFP using permitted mechanisms and map into an immutable normalized dispatch-release snapshot. Applying for API access to generate plans is a separate approval milestone. Do not claim that a universal username-lookup endpoint, login scraping or API generation is available without checking permissions.
Developer docs: https://developers.navigraph.com/docs/simbrief/introduction

### GSX (not Sprint 1)
Design `GroundServiceProvider` with event subscription, capability discovery, connection health and read/write feature flags. Never promise passenger identity linkage; manifest totals are app-side unless GSX supports compatible aggregates. Fall back to internal simulated service timers. Verify specific remote API methods and licensing before implementing.

## Local/cloud conflict policy
- Event log is append-only and durable locally until cloud ACK by event ID.
- Cloud is canonical for identity, subscriptions and shared airline resources.
- Client-sim observations are canonical for a flight's local telemetry, synchronized eventually.
- Server rejects malformed, unauthorized or duplicate events; no implicit merge of simultaneous conflicting edits.
- Crash recovery reloads most recent active session and displays gap/unknown data clearly.

## Security & operations
- Supabase RLS: each pilot only sees own flights; airline memberships later; server service-role functions isolated.
- Signed Stripe webhooks, replay protection and idempotency keys. Provider subscription status is mapped to server-side entitlement, never trusted from client.
- Minimize logs, encrypt sensitive data in transit and at rest, provide deletion/export.
- Build automated dependency checks, telemetry diagnostics, structured errors and feature flags.
- GDPR/CCPA applicability, app EULA, license terms and third-party product branding require review before general release.

## Suggested monorepo
```
apps/desktop             Tauri + React
apps/api                 Node API (later deployment)
services/sim-bridge      C# .NET SimConnect service
packages/contracts       JSON schema / TypeScript types
packages/flight-core     deterministic lifecycle and metrics
packages/integrations    SimBrief/GSX interfaces, stubs
packages/ui              accessible UI primitives
db/migrations            SQL + RLS
fixtures                 recorded/mock telemetry
scripts                  local build/test helpers
```

## Architecture decision records to create
ADR-001 Windows/Tauri/.NET bridge; ADR-002 deterministic domain events; ADR-003 local-first telemetry; ADR-004 Supabase/Postgres/RLS; ADR-005 adapter capabilities and fallbacks; ADR-006 subscription entitlements; ADR-007 future multi-tenant airlines.
