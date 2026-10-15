# ADR-002: Contract-first, versioned telemetry

Status: accepted (Sprint 1A)

- Canonical JSON Schemas (draft 2020-12) in `packages/contracts/schemas/v1/` are the source of
  truth. TypeScript types and validators, and C# records, mirror them. Both sides test against the
  same `fixtures/contracts/v1/{valid,invalid}` files.
- Every reading is `{ value, unit, quality }` and always present. `quality: "unavailable"` requires
  `value: null`; an available reading may not be null. **Unavailable is never encoded as zero.**
- Units are fixed per field (`ft`, `kt`, `fpm`, `deg`, `kg`, `count`, `bool`, `text`) and converted
  at adapter ingress (e.g. MSFS pounds to kg).
- Timestamps are UTC and must end in `Z`. Ordering is `(session_id, seq)`; frames and events share
  one session-wide sequence that keeps increasing across simulator reconnects.
- A reconnect after data has flowed emits a `sim.telemetry.gap` event (FR-03). Gaps are never
  silently filled.
- Validators are generated ahead of time (Ajv standalone), so the webview needs neither
  `unsafe-eval` nor CommonJS.
