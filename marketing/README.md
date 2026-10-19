# Turnline marketing site

Static prelaunch site. It is NOT part of the desktop app. Launch posture: `noindex,nofollow` (the meta tag on
every page plus the `X-Robots-Tag` header in `_headers`) stays until the owner approves discoverability and brand
clearance.

## Deployment

| | |
|---|---|
| Production domain | https://turnlineops.com |
| Platform | Cloudflare Pages |
| Production branch | `main` |
| Site directory (build output) | `marketing/` (static files; no build step) |
| Previews | Cloudflare Pages builds a preview URL for each pull-request branch (posted on the PR by the Cloudflare bot). Previews are not production. |

**A merge to `main` deploys production automatically.** Anything merged into `marketing/` on `main` goes live
without a separate release step, so merge marketing PRs only with explicit owner approval.

**Workflow:**
1. Work on a feature branch, open a PR against `main`, and check the Cloudflare preview URL on the PR.
2. Run the site tests, normally and with `--live-turnstile` (see Testing), and wait for CI on the PR.
3. The owner approves and merges. Cloudflare Pages then builds and publishes `main` (watch the deployment in the
   Cloudflare dashboard, or the commit status on `main`).
4. **To roll back,** re-deploy the previous production deployment from the Cloudflare Pages dashboard, or revert the
   merge commit on `main`.
   - Signups alone can be disabled without a redeploy of other content: set `apiUrl: ""` in `config.js` (the page then
     shows "Signups are not open yet").

**Verify production after an approved merge** (no real subscriber data):
- `https://turnlineops.com/` returns 200 and shows the merged content. Check the hero headline, and that the "What’s
  working today" section is present after V3.
- `curl -sI https://turnlineops.com/` includes `x-robots-tag: noindex, nofollow`, and the page source still has
  `<meta name="robots" content="noindex,nofollow">`.
- These return 200 with the right content type:
  - `/assets/site.css`, `/assets/site.js` and `/config.js`;
  - `/assets/og-image.png` and one screenshot, for example `/assets/screens/live-1600.webp` (`image/webp`).
- `/assets/definitely-missing.css` returns a real 404 (the root `404.html` prevents the SPA fallback).
- `config.js` still contains only the public `apiUrl` and `turnstileSiteKey`.
- In a desktop and a mobile browser:
  - the Turnstile widget renders in the early-access form, and the console shows no errors;
  - the privacy notice opens.
- The owner runs the manual live-signup check in `docs/testing/waitlist-live-acceptance.md` (sign up → confirmation
  email → confirm → unsubscribe) with an address they control.
- Check the social preview (for example with each network's post inspector). Previews may show the previous image
  until the network's cache refreshes.

## V4 (S2-05 GSX turnaround and expenses)
- **What changed:**
  - **Built and tested** gains three cards: live GSX Pro turnaround monitoring, flight-linked turnaround history, and
    GSX fuel invoices as simulated expenses. The limits box adds a GSX line and states the test-session result once.
  - New **operational flow** section (`#flow`, after `#product`): Dispatch → GSX turnaround → Debrief, using three real
    screens. It isn't in the navigation.
  - Statuses are updated in the hero facts, stages, Feature Explorer (Ground Ops and Debrief), Integrations, roadmap
    (new Milestone 5, done; Milestone 6, in development), FAQ and metadata. The navigation, the waitlist form and the
    prelaunch `noindex,nofollow` posture are unchanged.
- **Evidence behind the GSX "MSFS 2020 tested" labels:** the owner's MSFS 2020 + GSX Pro session on 2026-10-18,
  recorded in `docs/testing/s2-05-gsx-turnaround-acceptance.md`.
  - Use the label only for: live GSX connection; boarding, refuelling, pushback and deboarding states; departure and
    arrival turnaround activity; flight-linked turnaround history; Fuel receipt parsing; currency confirmation; expense
    association; persistence across a restart; no duplicate on re-scan; display in the flight's Debrief.
  - Catering and de-icing states, manual service entries, the servicing-readiness line and manual expenses are
    **Implemented internally** only: they are still Pending in the acceptance doc.
  - Automatic receipt import and matching is **In active development** (watcher PR open, matching disabled). Flight
    economics and revenue/profitability reporting are **Planned** (design approved, not built). Never label any of
    them tested or available until each passes owner acceptance and is merged.
  - The USD 2,912.46 figure is the owner-reported test result. State it only as a simulated fuel expense, never as
    real money.
- **Flow screenshots** (`assets/screens/receipt-confirm-*.webp`, `debrief-expenses-*.webp`):
  - Produced by `scripts/app-screens.mjs`. It renders the desktop app's real React UI in Chromium through
    `apps/desktop/screens/` (in-memory stores, not part of the app build), replays the bridge's recorded **mock** demo
    flight through the real `FlightRecorder`, and imports the sanitized GSX Fuel fixture
    (`fixtures/gsx/receipts/fuel-kbos-sanitized.html`, total $ 28,022.40). Currency confirmation, "Count as expense" and
    the flight association are clicked through the real UI. Nothing is retouched.
  - The transport only ever reports the `mock` adapter, so **no screenshot shows a simulated MSFS or GSX connection**.
    The live GSX Turnaround panel is deliberately not pictured until a real MSFS 2020 + GSX capture exists.
  - The flow note discloses the sample data and that the receipt amount differs from the USD 2,912.46 session.
  - Dispatch reuses the V3 `dispatch-detail` crop.
  - To regenerate: `pnpm -r --filter "./packages/**" build`, then
    `PLAYWRIGHT_MODULE=<playwright>/index.mjs node scripts/app-screens.mjs`.
- **To replace with real MSFS 2020 + GSX captures:** capture the Live Flight Turnaround panel with GSX live, the
  receipt confirmation and the Debrief expenses at the same panel crops; hide your SimBrief username, pilot ID,
  aircraft registration and any Windows user name in file paths; update the alt text and the flow note.
- **Tests:** `scripts/marketing-site-test.mjs` now expects the ten tested capabilities and the flow section. It also
  checks that the S2-05 statuses are exact and that matching, economics and profitability stay In active development or
  Planned. It rejects wording that presents them as working, and requires the expenses to be called simulated.

## V3 (real product progress and early access)
- **What changed:**
  - Hero copy separates what works today from the long-term vision.
  - CTAs: "Join the Early Access List" (primary, the only conversion goal) and "See What’s Working".
  - The concept dashboard in the hero is replaced by a real Live Flight screen.
  - Two new sections after the hero:
    - **Built and tested** (`#working`): the seven capabilities the owner validated on real MSFS 2020 hardware, with their limits;
    - **Inside the app** (`#product`): four real screens.
  - Statuses are updated everywhere: stages, feature explorer, integrations, roadmap, FAQ, metadata and footer.
  - The navigation is unchanged.
- **Status vocabulary** (replaces the V2 list; keep it consistent and change a label only when the work changes):
  - *Implemented internally · MSFS 2020 tested*: in internal Windows builds and tested by the owner with MSFS 2020 on real
    hardware, in supported scenarios. Not public; broad aircraft/add-on/hardware compatibility not established.
  - *Implemented internally*: built and tested in internal builds; not separately validated with MSFS.
  - *In active development*: being built or validated now. S2-02 (dispatch release, OUT/OFF/ON/IN timeline) and S2-03
    (navlog, route monitoring, navigation debrief) stay here until each passes acceptance testing **and** is merged.
    CI passing is not enough.
  - *Planned*, *Research*: as before. Passenger, ground handling, GSX, SayIntentions, ACARS, airline scheduling,
    delay causes and cause-and-effect simulation are Planned or Research.
  - MSFS 2024 stays *In active development* (unverified) until there is separate documented acceptance evidence.
- **Evidence behind the "MSFS 2020 tested" label:** owner-reported hands-on acceptance with a real MSFS 2020 and a
  real SimBrief account, recorded in `docs/testing/msfs2020-owner-acceptance-s2-01.md` and as `OWNER-ACCEPTED` rows in
  `docs/compatibility/msfs2020-matrix.md`.
  - Use the label only for those checks: connection and recording, OFP import, scheduled OUT/OFF/ON/IN times,
    duplicate import, plan persistence, offline behaviour, plan attachment, flight completion, planned-versus-actual
    debrief.
  - Build, simulator version and aircraft were not recorded, and no recording exists. Don't strengthen the wording
    (e.g. "verified", "compatible", "supported aircraft") until instrumented evidence is committed.
- **Screenshots** (`assets/screens/`):
  - **Files:**
    - `<screen>-1600.webp` / `-800.webp`: the full app window (1600×944);
    - `<screen>-detail-1000.webp` / `-600.webp`: a 4:3 crop of the main panel. Phones get the detail crop through
      `<picture>`; the hero uses the Live Flight detail.
  - **Provenance:**
    - Captured from the desktop app as merged on `main`. S2-02 and S2-03 screens are excluded.
    - Rendered in Chromium with in-memory stores. Live Flight, History and Debrief come from the bridge's recorded
      mock-adapter demo flight (`fixtures/recordings/simulated/mock-nominal-markers.jsonl.gz`) replayed through the
      real `FlightRecorder`. Dispatch is the synthetic `fixtures/simbrief/ofp-v2-iso-times.json` (times moved to the
      capture day; a KSEA→KPAE copy is attached to the demo flight).
  - **Edits:** the app's top bar is cropped out. It carries the internal working name "FlightSimApp", the connection
    status and the clock. Nothing on the screens is retouched, and the in-app "DEMO DATA" notices are kept.
  - **Disclosure:** every screen shows **sample data**, and the page says so in the captions, the section intro, the
    note under the gallery, the lightbox and the footer.
  - **Lightbox:** selecting a screen opens the full-size image in a native `<dialog>`. It closes with Escape, the
    Close button or the backdrop, and focus returns to the link. Without JS or `<dialog>` support, the link opens the
    image directly.
  - **To replace with real MSFS 2020 captures:** use a 1600×1000 window, crop the top 56 px, make the detail crops
    with the same geometry, and keep the alt text accurate. Hide your SimBrief username, pilot ID and aircraft
    registration.
  - **Follow-up (desktop, not this site):** rename the app's visible title from "FlightSimApp" to "Turnline". Leave
    the bundle identifiers, SQLite paths and bridge identity alone; changing those needs its own migration plan.
- **Concept visuals:** only the scenario section and its debrief card remain; both are labelled.
- **Images:** the only `<img>` elements are Turnline screenshots, and the tests enforce that. Each has alt text and
  dimensions. The hero image loads eagerly; the gallery images load lazily. No third-party logos.
- **Metadata:** title, description and Open Graph/Twitter text describe the working product without promising MSFS
  2024, passengers or ground handling. `og-image.png` was regenerated from `docs/marketing/og-card.html`.
  `noindex,nofollow` and the `X-Robots-Tag` header are unchanged.
- **Waitlist:**
  - The contract, endpoint, Turnstile, consent text, UTM handling, messages and privacy links are unchanged.
  - Only the copy around the form changed. The submit button now reads "Join the Early Access List", and the form
    heading matches it.
- **Before/after captures:** `docs/screenshots/marketing-v3/{before,after}`, produced by
  `scripts/marketing-compare-screenshots.mjs <dir>`.

## V2 (redesign)
- `index.html`: the full landing page. Sections: hero with a labelled concept dashboard, What is Turnline,
  How it works (6 stages), Feature Explorer (6 categories), Why different, an illustrative scenario,
  Integrations, Roadmap, FAQ, Early access, footer.
- `assets/site.css`, `assets/site.js`: no framework, no external fonts. The only third-party script is
  Cloudflare Turnstile, loaded only when signups are configured. Without JS every section stays readable.
- `assets/favicon.svg`, `assets/og-image.png`: the OG image is rendered from `docs/marketing/og-card.html` by
  `scripts/marketing-og-image.mjs`.
- **Status vocabulary** (used everywhere on the page; keep it consistent):
  - *Implemented internally*: built and tested in internal builds; not public; not validated with MSFS
  - *In active development*
  - *Planned*
  - *Research*: feasibility only
  - Change a label only when the underlying work changes.
- **Concept visuals** (the hero dashboard, the scenario and the debrief card) are HTML/CSS illustrations with
  fictional values. Each one is labelled as a concept. Never replace them with images presented as real software.
- **No third-party logos.** Provider names are plain text, with a non-affiliation disclaimer.

### Confirmation and unsubscribe pages
- `confirm.html` and `unsubscribe.html` (served as `/confirm` and `/unsubscribe`), with `assets/verify.js`.
- Email links carry `#id=…&token=…` in the fragment. The page strips it from the URL and POSTs
  `{action, id, token}` to `apiUrl` only when the user clicks.
- `_headers` gives these paths `no-store`, `no-referrer` and an enforced CSP.
- Details, the rollout order and the manual acceptance procedure are in
  `docs/testing/waitlist-first-party-confirmation.md`.

### Waitlist contract (unchanged from V1; do not change without the backend)
- `config.js` provides `window.TURNLINE_CONFIG = { apiUrl, turnstileSiteKey }`. Both values are public. An empty
  `apiUrl` is the documented rollback, and the page then shows "Signups are not open yet".
- The form POSTs JSON `{email, consent:true, captcha, source:'turnline_waitlist', utm_source, utm_medium,
  utm_campaign}`, with the UTM values capped at 100 characters. The Turnstile container `#turnstile` must stay
  inside `#signup`.
- Older function versions redirected back to `/?waitlist=confirmed|unsubscribed|invalid|error#early-access`. The
  homepage still shows those messages, and the `#early-access` id must not change.
- V2 client-side additions:
  - messages for `error`, 429 and 400
  - a duplicate-submit guard
  - a visible consent message instead of only the browser bubble

### Testing
`PLAYWRIGHT_MODULE=<playwright>/index.mjs node scripts/marketing-site-test.mjs [--live-turnstile] [--out dir]`

- **What it checks:**
  - layout at 320–1440 px with no horizontal scroll
  - anchors, resources and console errors
  - mobile navigation, the FAQ, tabs and the scenario toggle
  - reduced motion and no-JS rendering
  - Turnstile initialisation
  - form validation, the exact request contract, UTM handling, success and failure messages, and redirect
    messages
  - the rollback config
  - a secret scan
- **Safety:** the signup endpoint and Cloudflare are intercepted, and only reserved `example.com` /
  `example.invalid` addresses are used.
- **`--live-turnstile`** loads the real Turnstile widget with Cloudflare's public always-pass test key.
- **Not covered by automation:** the live production signup, delivery and confirmation flow
  (`docs/testing/waitlist-live-acceptance.md`). That is a manual owner test.

### Post-V2 production hardening
- `_headers` now adds X-Content-Type-Options, frame protection, referrer and permissions restrictions, and
  a **Content-Security-Policy-Report-Only** policy. This CSP does not block resources yet: inspect browser
  console warnings (Safari and Chromium) with real Turnstile and signup before enforcing. It currently permits
  inline scripts/styles because of the existing bootstrap, styling, and Turnstile integration; reduce these
  exceptions after checking production behavior. Cloudflare Pages applies these to static assets only.
- Root `404.html` avoids Cloudflare Pages' SPA fallback returning the homepage for missing assets. Verify
  `/assets/definitely-missing.css` gives a true HTTP 404, while `/assets/site.css` returns CSS.
- Keep `noindex,nofollow` and the X-Robots-Tag until explicit public-search/brand approval.
- These changes require a new production Pages deployment; GitHub commit alone does not verify the live site.
- **Safari acceptance (owner, iPhone):** 8/8 key mobile interactions reported passed on 2026-10-15,
  including navigation, tabs, scenario toggle, roadmap, FAQ, Turnstile rendering and privacy links.
  This was a manual browser check, not a production signup or security penetration test.
- **Still pending:** live confirm/unsubscribe regression for the latest Edge Function, rate-limit/invalid-captcha
  public HTTP tests, Safari CSP warning review, accessibility screen-reader pass and trademark review.

## Earlier MVP notes (V1)

### Contents
- `marketing/index.html`: responsive accessible landing page with explicit opt-in, UTM capture, CAPTCHA and noindex.
- `marketing/privacy.html`: prelaunch privacy notice draft. Review business identity, contact details, hosting and retention before publication.
- `marketing/config.example.js`: public configuration template.
- `db/migrations/0003_turnline_waitlist.sql`: private, RLS-enabled mailing-list table. **Not applied.**
- `supabase/functions/turnline-waitlist/index.ts`: email confirmation and unsubscribe endpoints; runs server-side, needs secrets.
- `marketing/email/`: future newsletter template.

### Activation steps — NOT completed
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

### Limitations / security review needed
- No hosting, mail delivery, staging database, and external e2e tests have been run.
- No automatic welcome/newsletter campaign has been enabled. Confirmation mail is implemented; marketing sends must filter `confirmed_at IS NOT NULL AND unsubscribed_at IS NULL`.
- The Edge Function has an application-level minimum resend interval but **needs infrastructure rate limits** before deployment. Protect against CAPTCHA abuse, bot traffic, and email enumeration.
- The privacy notice is a draft and requires actual controller identity/contact and retention terms.
- Current static concept should not claim that future dispatch, passenger, GSX or TOBT functions are shipped.
- Keep brand change separate from Tauri bundle identifier, local SQLite paths and migrations.

### Events and measurement
- Landing visit: count anonymized page views after consent requirements are met.
- Form submit: count submissions without recording email in analytics.
- Verified lead: count newly confirmed subscribers (authoritative server-side count).
- Referral source: `utm_source`, `utm_medium`, `utm_campaign`, each capped at 100 characters.
- Activation and paid conversion belong to future product milestones.

### Local page preview
Serve the `marketing` directory with a static server; do not open as a `file:` URL for testing integrations.
The default configuration intentionally has no live signup endpoint. You will see "Signups are not open yet."
