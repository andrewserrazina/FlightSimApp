# Turnline native SimuNet sender (review-only)

Stacked on Turnline #38 (telemetry contract) and #39 (OS-keyring account/consent Settings).

## Security design
- Rust owns HTTP transport and reads the SimuNet operator key directly from the OS keyring. No JavaScript-accessible token getter. The webview passes **only** a single pre-mapped telemetry frame.
- Endpoint is a **build-time approved origin** `SIMUNET_HTTPS_ORIGIN`, such as `https://approved-api.example.com`, and MUST be selected/reviewed by the maintainer. **Do not** set it to an unknown production hostname or embed a real credential in builds. Missing/invalid config disables sending.
- Validates HTTPS origin, no custom port, path, query, fragment, username/password, raw IP address or local/internal domain. Redirect following disabled so `x-api-key` is not forwarded elsewhere.
- Keyring opt-in must be enabled independently of Turnline's cloud sync and rechecked before each send. Turning consent off, replacing the key or disconnecting also **revokes requests already in flight**: the request is dropped (connection closed) and its result discarded, so nothing sent under the old permission is reported as delivered. Permission is taken before the credential is read, so a revocation at any later point is observed.
- Input bounds: MSFS2020/2024 only, source=Turnline, valid lat/lon, finite readings, observed UTC timestamp no more than 60 seconds stale or 15 seconds future; 4 KB payload limit, one frame per request. Sender rate limit: at most one per 5 seconds. No historical flight replay.
- Timeouts 6 seconds; no request/response bodies or credentials logged. Replies are read up to 16 KiB and must be a JSON object; anything larger or malformed is refused, not buffered.
- Errors reach the webview only as coarse codes (`not_configured`, `disabled`, `credential_unavailable`, `rate_limited`, `stale_frame`, `invalid_frame`, `unsupported_source`, `too_large`, `cancelled`, `network`, `unauthorized`, `server_rate_limited`, `redirected`, `rejected`, `invalid_response`): no status text, URL, body or environment detail. Settings diagnostics count only real delivery failures; local refusals (rate limit, stale or invalid frame) and cancellations are not counted as failed requests. SimuNet continues to derive active assignment from authenticated operator, not from supplied job identifiers.
- Turnline's recorder and Supabase flight sync remain independent. Failed SimuNet sends do not fail or block local recording.

## Acceptance blockers
1. CI TypeScript/Rust/Windows package validation.
2. Configure a **reviewed** HTTPS origin in an **isolated staging build** and verify it against SimuNet's test operator key.
3. ~~Visible diagnostics~~ **Done:** Settings shows delivery state and counters, with failures categorised by the native error code (counters live in the webview's diagnostics store; native counters would duplicate them).
4. ~~Local mock HTTP harness~~ **Done:** Rust tests run a local plain-HTTP mock server and cover the key travelling only in the `x-api-key` header, status mapping (401/403/429/4xx/5xx), redirects never followed (301/302/307/308, the redirect target receives nothing), oversized and malformed replies, and an unreachable endpoint. They prove the transport logic, not delivery to a real SimuNet staging API (blocker 2).
5. ~~Consent revocation during an in-flight send~~ **Done** (tested: revoked mid-request, revoked before the request starts, revoked while the result is produced). The bridge-disconnect race is handled by the relay sending only fresh frames from a connected bridge session; the server's own time and replay checks stay authoritative.
6. Build authenticated job claim UI, confirmation of binding, and test end-to-end MSFS2020/2024 Journey Proof.
7. Validate SimuNet API domain, TLS, secret lifecycle and privacy disclosure before enabling for users.

**No merge, release, production activation, simulator change, or live credential handling in this PR.**
