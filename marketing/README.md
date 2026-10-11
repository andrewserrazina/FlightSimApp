# Turnline marketing MVP (unpublished)

This is a **prelaunch marketing implementation**, NOT part of the flight-simulator webview. It is committed on feature branch `claude/new-session-2b3s69` and has not been deployed.

## Contents
- `marketing/index.html`: responsive accessible landing page with explicit opt-in, UTM capture, CAPTCHA and noindex.
- `marketing/privacy.html`: prelaunch privacy notice draft. Review business identity, contact details, hosting and retention before publication.
- `marketing/config.example.js`: public configuration template.
- `db/migrations/0003_turnline_waitlist.sql`: private, RLS-enabled mailing-list table. **Not applied.**
- `supabase/functions/turnline-waitlist/index.ts`: email confirmation and unsubscribe endpoints; runs server-side, needs secrets.
- `marketing/email/`: future newsletter template.

## Activation steps — NOT completed
1. Obtain trademark clearance for Turnline; choose and verify a domain.
2. Choose a real business contact address, update privacy page and obtain legal/privacy review.
3. Provision approved **staging** Supabase and Resend accounts and verify an email sending domain.
4. Create Cloudflare Turnstile site/secret pair restricted to the staging host.
5. Review migration compatibility with the existing Supabase project, then apply `0003` in staging only. Keep RLS active; do not grant anon/authenticated direct table access.
6. Deploy the edge function in staging with JWT verification **disabled intentionally for public waitlist intake**, with server-side Turnstile validation mandatory. No `service_role`, CAPTCHA or Resend secrets in browser code. Rate-limit at the gateway/WAF in addition to Turnstile.
7. Configure secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TURNSTILE_SECRET_KEY`, `RESEND_API_KEY`, `WAITLIST_FROM_EMAIL`, `WAITLIST_ALLOWED_ORIGIN` (exact scheme + host), `WAITLIST_SITE_URL`, `WAITLIST_FUNCTION_URL` (absolute HTTPS URL, no trailing parameters), `WAITLIST_SIGNING_SECRET` (32+ random bytes).
8. Copy `marketing/config.example.js` to `marketing/config.js` and populate the public URL and site key **only**. Edit deployment CSP to permit Cloudflare Turnstile and your edge function endpoint.
9. Host `marketing/` on a preview/staging domain with noindex and access restrictions during review. Verify that analytics tools do not receive raw email addresses. Add a durable conversion event on the server only after confirmation.
10. Test subscribe, email delivery, confirm, duplicate signup, unsubscribe, expired link, invalid captcha, rate limit, unavailable Resend, cross-origin rejection and opt-out suppression before public launch.

## Limitations / security review needed
- No hosting, mail delivery, staging database, and external e2e tests have been run.
- No automatic welcome/newsletter campaign has been enabled. Confirmation mail is implemented; marketing sends must filter `confirmed_at IS NOT NULL AND unsubscribed_at IS NULL`.
- The Edge Function has an application-level minimum resend interval but **needs infrastructure rate limits** before deployment. Protect against CAPTCHA abuse, bot traffic, and email enumeration.
- The privacy notice is a draft and requires actual controller identity/contact and retention terms.
- Current static concept should not claim that future dispatch, passenger, GSX or TOBT functions are shipped.
- Keep brand change separate from Tauri bundle identifier, local SQLite paths and migrations.

## Events and measurement
- Landing visit: count anonymized page views after consent requirements are met.
- Form submit: count submissions without recording email in analytics.
- Verified lead: count newly confirmed subscribers (authoritative server-side count).
- Referral source: `utm_source`, `utm_medium`, `utm_campaign`, each capped at 100 characters.
- Activation and paid conversion belong to future product milestones.

## Local page preview
Serve the `marketing` directory with a static server; do not open as a `file:` URL for testing integrations.
The default configuration intentionally has no live signup endpoint. You will see "Signups are not open yet."
