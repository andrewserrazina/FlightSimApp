# ADR-003: Local-first flight recording in SQLite owned by the native shell

Status: accepted (S1-04)

## Context
Flights must survive app crashes and restarts and work offline. The UI must not stall on disk I/O.
The webview must not gain new powers (no raw SQL, no file paths, no network listener).

## Decision
- SQLite, compiled into the Tauri shell via `rusqlite` (`bundled`): no system library, works on Windows.
  This is the only new dependency.
- One writer thread owns the connection. Tauri async commands send it closures and await the reply.
- A fixed command surface: `store_status`, `store_reset_damaged`, `flight_open`, `flight_commit`
  (one atomic, idempotent batch), `flights_list`, `flight_detail` and `flights_prune`.
  Every payload is validated (enums, UTC timestamps, sizes, finite numbers).
- The lifecycle logic stays in TypeScript (`flight-core`), as a pure reducer shared with future
  airline-management features. The recorder runs it in the webview and persists engine snapshots.
- Batched writes with event-triggered flushes and down-sampled track points
  (see `docs/architecture/flight-recording.md`).

## Consequences
- If the webview is unresponsive, recording pauses. The bridge and shell are unaffected, and the
  recovery path treats it like an interruption.
- Cloud sync (S1-05) can read events and summaries from this store. The cloud schema stays separate
  and is not applied by the desktop app.
