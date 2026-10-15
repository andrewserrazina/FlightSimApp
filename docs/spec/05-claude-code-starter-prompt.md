# Claude Code — FlightSimApp Sprint 1A Prompt

You are the lead engineer implementing FlightSimApp, a Windows-first, subscription-oriented, pilot-first airline operations simulator application. A future airline-management product will share the core domain model.

First read `01-product-requirements.md`, `02-architecture.md`, `03-database.sql`, and `04-sprint-1.md`. Implement ONLY the S1-01 and S1-02 tasks in `04-sprint-1.md`. Do not implement billing, GSX, SimBrief, TOBT, EDCT or airline management yet.

Requirements:
1. Create a clean monorepo with apps/desktop (Tauri v2 + React + TypeScript), services/sim-bridge (C#/.NET out-of-process SimConnect adapter), packages/contracts (versioned schemas + TS typings), packages/flight-core (typed lifecycle utilities), db/migrations and fixtures.
2. Use .NET interfaces `ISimulatorAdapter`, `MockSimulatorAdapter`, `MsfsSimConnectAdapter`; isolate MSFS 2020/2024 compatibility logic. Simulator-unavailable case must be a supported state. Mock must work without MSFS.
3. All SimConnect calls must be serialized onto one dedicated owner thread, not concurrently dispatched. Consult installed SDK docs when coding; if simulator SDK is unavailable, provide compilation-safe abstractions and explicitly mark the unverified SDK integration instead of fabricating API types.
4. Define `TelemetryFrameV1` with schema version, monotonically increasing session sequence, UTC observation timestamp, simulator identifier, explicit units and optional nullable readings; distinguish unavailable from zero. Implement connection state machine with disconnect/reconnect/backoff.
5. Provide secure local bridge transport: strictly localhost or OS-restricted named pipe, authenticated with per-session token or equivalent, explicit CORS/origin checks if HTTP, no public binding. Do not leak secrets into browser-exposed code.
6. Include automated tests for mock frames, schema validation, no-simulator behavior, reconnect, and invalid frames. Add README with exact build/test commands for Windows.
7. Prepare SQL migration script; do not apply to production database or provision cloud resources without explicit authorization.
8. Do not push changes, alter remote repos, create live paid products, or claim tested MSFS integrations without actual simulator verification.

Working style:
- Inspect the repository first; preserve existing work. If empty, scaffold.
- Implement in small reviewable steps, favor robust baseline over visually impressive mockups.
- Run available builds, typechecking and tests; report which platforms and simulators were actually tested.
- At the end provide file tree, important architecture decisions, commands run, passing/failing tests, blocked issues and exact next recommended task S1-03.

Design direction: premium, restrained airline OCC-inspired desktop experience; dark navy backgrounds, high-contrast flight data, selective amber for operational alerts, accessible typography. Visual polish must not take priority over connection reliability.
