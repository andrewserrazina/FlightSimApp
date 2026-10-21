# Turnline native SimuNet sender (review-only)

Stacked on Turnline #38 (telemetry contract) and #39 (OS-keyring account/consent Settings).

## Security design
- Rust owns HTTP transport and reads the SimuNet operator key directly from the OS keyring. No JavaScript-accessible token getter. The webview passes **only** a single pre-mapped telemetry frame.
- Endpoint is a **build-time approved origin** `SIMUNET_HTTPS_ORIGIN`, such as `https://approved-api.example.com`, and MUST be selected/reviewed by the maintainer. **Do not** set it to an unknown production hostname or embed a real credential in builds. Missing/invalid config disables sending.
- Validates HTTPS origin, no custom port, path, query, fragment, username/password, raw IP address or local/internal domain. Redirect following disabled so `x-api-key` is not forwarded elsewhere.
- Keyring opt-in must be enabled independently of Turnline's cloud sync and rechecked before each send. Replacing/disconnecting key revokes future sending permission. A request already in flight may finish before revocation; strict instantaneous cancellation needs future sender cancellation tokens.
- Input bounds: MSFS2020/2024 only, source=Turnline, valid lat/lon, finite readings, observed UTC timestamp no more than 60 seconds stale or 15 seconds future; 4 KB payload limit, one frame per request. Sender rate limit: at most one per 5 seconds. No historical flight replay.
- Timeouts 6 seconds; no request/response bodies or credentials logged. Non-success HTTP statuses return only the status code. SimuNet continues to derive active assignment from authenticated operator, not from supplied job identifiers.
- Turnline's recorder and Supabase flight sync remain independent. Failed SimuNet sends do not fail or block local recording.

## Acceptance blockers
1. CI TypeScript/Rust/Windows package validation.
2. Configure a **reviewed** HTTPS origin in an **isolated staging build** and verify it against SimuNet's test operator key.
3. Add native send counters and visible connection diagnostics; currently failures are intentionally silent to avoid noisy errors or leaked secrets.
4. Add local mock HTTP integration harness to test HTTP status codes and credential handling. Current CI is build/test checks and does not prove network delivery.
5. Verify consent revocation during in-flight send and bridge disconnect race behavior.
6. Build authenticated job claim UI, confirmation of binding, and test end-to-end MSFS2020/2024 Journey Proof.
7. Validate SimuNet API domain, TLS, secret lifecycle and privacy disclosure before enabling for users.

**No merge, release, production activation, simulator change, or live credential handling in this PR.**
