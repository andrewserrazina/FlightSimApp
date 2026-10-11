# Local Supabase test stack (development and CI only)

An isolated local stack used for the S1-05 security integration tests and the desktop smoke test.
**It is never production.** The JWT secret and passwords below are well-known local-only values.

| Service | Image | Host port |
|---|---|---|
| Postgres (Supabase build) | `supabase/postgres:15.8.1.060` | 127.0.0.1:54322 |
| Auth (GoTrue) | `ghcr.io/supabase/gotrue:v2.177.0` | 127.0.0.1:54325 |
| REST (PostgREST) | `postgrest/postgrest:v12.2.12` | 127.0.0.1:54324 |
| Mail catcher (Mailpit) | `ghcr.io/axllent/mailpit:v1.27` | 127.0.0.1:54327 (UI/API) |
| Gateway (`gateway.mjs`, Node on the host) | — | **127.0.0.1:54321**: `/auth/v1`, `/rest/v1`, email templates |

The gateway replaces Kong. It maps the Supabase URL layout (`/auth/v1`, `/rest/v1`) onto the
services, adds CORS for the desktop webview, and serves the OTP email templates.

```bash
infra/supabase-local/up.sh      # start containers, wait for health, apply db/migrations/*.sql, start gateway
infra/supabase-local/keys.mjs   # print the local anon / service-role keys (derived from the local secret)
infra/supabase-local/down.sh    # stop everything and delete the volume
```

Then run the security integration tests: `pnpm --filter @flightsim/cloud test:integration`.

**Email.** Confirmation and recovery emails contain a 6-digit code (desktop OTP flow, so there are
no redirect callbacks). They are caught by Mailpit: http://127.0.0.1:54327.
