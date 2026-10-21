# SimuNet native sender — staging-only boundary

This draft PR adds a Rust command `simunet_send_dev_frame` with a **fixed local-only** endpoint `http://127.0.0.1:8000/v1/telemetry`. It does not activate a live uploader. It is not a production HTTPS implementation, and must not be merged as an enabled flight-sharing feature.

## What is implemented

- A native-only OS-keyring read that requires separate SimuNet consent and a saved operator key.
- The credential is never returned to JavaScript. The command returns only a coarse response category.
- Rejects mock source, unsupported simulator, invalid or unavailable coordinates, invalid timestamp, and timestamps outside the 30-second recent window.
- Rejects duplicate/out-of-order session sequences and throttles to one frame every five seconds per active session.
- Limits JSON request to 2 KiB, sets an eight-second timeout, disables redirects and proxy use.
- Only the loopback URL can receive the API key; callers cannot choose host, path, or URL.

## Critical next gates

1. **No automatic sender wiring yet.** Explicitly design a per-session activation control with counters, backoff, and cancellation on opt-out. Do not send every bridge snapshot replay.
2. **No production API hostname configured.** Verify the actual SimuNet staging HTTPS hostname and certificate before allowing any non-loopback target. Hard-code a vetted HTTPS allowlist, not a user-controlled URL.
3. **Local development only.** Do not point this at an active production service; local SimuNet must use disposable test operator credentials and data.
4. **Race/consent hardening.** The keyring consent is checked before each request; in-flight requests must be canceled when consent is revoked before the sender can be activated automatically.
5. **Server assignment.** A SimuNet API key authenticates an operator, but the backend must still have a matching active MSFS job assignment before any accepted frame counts as Journey Proof.
6. **Telemetry validity.** Bridge connection status and frame freshness must be checked by the caller. Server-side anti-replay, time validation and flight-evidence checks remain authoritative.
7. **Network tests.** Add a mock local HTTP server to verify header secrecy, no redirects, error categorization and duplicate throttling before a real-flight pilot.

This work is stacked after Turnline PRs #38 and #39. No merge, production deployment, migration or real MSFS flight acceptance was performed.
