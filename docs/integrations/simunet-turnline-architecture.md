# Turnline → SimuNet connector integration (MSFS 2020 / 2024)

## Product decision

**Turnline is the sole MSFS-side connector** for SimuNet; users do not install or run the separate SimuNet Python MSFS connector or SimuNet Desktop launcher. SimuNet supplies online economy, assignments and authorization; Turnline remains the pilot-facing, local-first desktop companion and source of live simulator telemetry.

This PR introduces a *pure*, importable mapping contract in `apps/desktop/src/integrations/simunet/telemetry.ts`; **no network transmission, authentication UI or enabled integration** is included yet. This ensures Turnline's existing flight recorder, history, SimBrief release and opt-in Supabase cloud sync are unaffected.

## Architecture

```text
MSFS 2020 / MSFS 2024
       │ SimConnect
       ▼
Turnline's existing .NET bridge (one connection only)
       │ validated TelemetryFrameV1
       ▼
Turnline's desktop session
       ├── local recorder + optional Turnline cloud sync (unchanged)
       └── optional SimuNet integration → HTTPS ingest
                                              │ SimuNet operator token
                                              ▼
                                  SimuNet /v1/telemetry
                                              │ backend stamps active assignment
                                              ▼
                                  authoritative Journey Proof
                                              │ future integration gate
                                              ▼
                             economy / flight settlement
```

## Non-negotiable requirements for network feature PR

1. Off by default. Turnline user separately enables SimuNet integration and links a SimuNet operator. Turnline's own Supabase login/cloud-sync permission is **not consent** to sending data to SimuNet.
2. SimuNet operator API key stored in OS keyring, never URL parameters, log output, local SQLite, or local webview state. Tokens sent only to allowlisted HTTPS backend origin; development localhost permitted only with explicit developer mode. Prevent SSRF/redirect token leakage and disallow caller-configurable arbitrary hosts without review.
3. One source of simulator readings: the existing Turnline bridge. No second SimConnect polling client, listener, or separate app. Support both adapter IDs `msfs2020` and `msfs2024`.
4. Send observed UTC timestamps and Turnline session IDs unchanged. Never turn unavailable readings into numeric zeros, synthesize positions, or replay completed cloud-history uploads as fresh Journey Proof.
5. Send bounded, rate-limited batches with transient backoff; respect SimuNet's 15-minute ingestion window and duplicate-key handling. The server must stamp the operator's currently active assignment; do not allow a client-supplied assignment ID as trust proof.
6. No SimuNet dispatch assignment *ownership* inferred from Turnline flight IDs. Associate the user's selected SimuNet contract through an authenticated claim flow; display the bound assignment before taxi/departure.
7. Persist no redundant raw telemetry without explicit review. Disable and stop uploads immediately on opt-out/logout/operator switch.
8. Server-side Journey Proof should be tested with real MSFS2020 first and repeated with MSFS2024. Live air-cargo inventory movement must use a newly designed aviation shipment lifecycle, **not** E1B's ETS2-only leg settlement.

## First real-world acceptance

1. User runs MSFS2020 and only Turnline desktop.
2. Turnline shows connected, aircraft, lat/lon, groundspeed, timestamps and flight status.
3. User separately connects a SimuNet test operator in Turnline, explicitly opts in to test telemetry, and claims a coordinate-verified aviation job on a test backend.
4. Turnline reports send/ack counters and assignment-binding state; SimuNet reports accepted/deduped frames.
5. User flies a matching route, lands, and tests existing MSFS Journey Proof without manual simulator switching or another client.
6. Repeat with MSFS2024 after 2020 acceptance. Verify opt-out stops transmissions and disconnected/stale frames never masquerade as live evidence.

## Follow-up PR sequence

A. This pure mapping contract and unit tests.
B. Secure Rust-side HTTP sender/keyring token handling, gated by separate SimuNet opt-in.
C. SimuNet test-operator pairing and authenticated claim/status views in Turnline.
D. Real MSFS2020 acceptance with SimuNet backend, then MSFS2024.
E. Aviation-compatible shipment ledger and feature-flagged economics after verified evidence.

No merge, deployment, live operator balance action, or production API endpoint change in this PR.
