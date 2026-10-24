# Turnline website readiness audit, promotion blockers and first teaser plan

Prepared 2026-10-19 for the early-access marketing sprint. The site is https://turnlineops.com, built from `marketing/`.
The production checks ran from a cloud container on 2026-10-18 between 22:00 and 22:10 UTC. They did not submit a
real signup and did not use any real subscriber data.

## 1. Production audit

### Availability and assets

| Check | Result |
|---|---|
| `/`, `/privacy`, `/confirm`, `/unsubscribe` | 200, `text/html` |
| `/assets/site.css`, `/assets/site.js`, `/config.js` | 200, correct content types |
| `/assets/og-image.png`, `/assets/screens/live-1600.webp` | 200, `image/png` and `image/webp` |
| `/assets/definitely-missing.css` | Real 404, so the SPA fallback is avoided |
| `http://turnlineops.com/` | 301 to HTTPS |
| `https://www.turnlineops.com/` | **Fails. `www` has no DNS record (NXDOMAIN).** |
| `/sitemap.xml` | 404. Expected while prelaunch. |
| `/robots.txt` | Cloudflare's managed "content signals" file, with no Allow or Disallow rules. This is fine: `noindex` is enforced by the meta tag and header. Do not add `Disallow: /`, because crawlers would then never see `noindex`. |

**Production matches `main`.** `index.html`, `site.css`, `site.js`, `config.js`, `privacy.html` and `_headers` were
compared with `main` at `d9bfff6`. The only differences are two features Cloudflare injects at the edge:
- **Email Address Obfuscation** rewrites every `mailto:support@turnlineops.com` link. Without JavaScript, visitors see
  "[email protected]", including the privacy notice's contact line.
- **Cloudflare Web Analytics** injects its beacon (`static.cloudflareinsights.com`). The privacy notice doesn't
  mention it, and the report-only CSP flags it, so enforcing the CSP as written would block it.

### Headers and launch posture
- `x-robots-tag: noindex, nofollow` is present on every page, along with
  `<meta name="robots" content="noindex,nofollow">`. **The prelaunch posture is intact, and this PR keeps it.**
- Present: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`.
- The main site has a report-only CSP.
- `/confirm` and `/unsubscribe` have an enforced CSP, `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
  - These two pages also send a second, broader `Referrer-Policy`. Browsers apply the last valid value, which is
    `no-referrer`, so this works but should be cleaned up.
- **No `Strict-Transport-Security` header.**
- `config.js` holds only the public `apiUrl` (the Turnline Supabase project `itapyrwjijnvzdsatttp`) and the Turnstile
  site key. No secrets are in browser files; the site test's secret scan passes.

### Waitlist API (live, non-destructive)
All requests used reserved `example.invalid` addresses or bogus tokens. Nothing was stored except, at most, the
function's rate-limit counters.

| Request | Expected | Result |
|---|---|---|
| CORS preflight from `https://turnlineops.com` | Allowed for that origin only | 204, `access-control-allow-origin: https://turnlineops.com` |
| POST from another origin | Rejected | 403 `invalid_origin` |
| GET without parameters | Rejected | 405 |
| Confirm with a bogus token | Generic rejection | 400 `invalid_or_expired` |
| Unsubscribe with a bogus token | Generic rejection | 400 `invalid_or_expired` |
| Signup without consent | Rejected before CAPTCHA | 400 `invalid_request` |
| Signup with an invalid Turnstile token | Rejected server-side | 400 `verification_failed` |

**Not run, and why:**
- The real signup → confirmation email → confirm → unsubscribe flow. It needs an inbox you control; it's the manual
  owner test in `docs/testing/waitlist-live-acceptance.md`.
- The 429 rate-limit test. It would use up the shared global signup quota.
- A Resend outage test.

### Turnstile, mobile layout and browser checks (production, Chromium)
- **Turnstile:** the real widget loads on turnlineops.com with the production site key. The challenge frame is
  served from `challenges.cloudflare.com` and the `cf-turnstile-response` field is present. The remaining console
  messages come from inside Cloudflare's own Turnstile frame and from the report-only CSP, not from Turnline's code.
- **Mobile layout:** no horizontal scroll at 320, 390, 768 or 1440 px, and the early-access form renders correctly at
  390 px.
- **Safari:** your iPhone check on 2026-10-15 (8 of 8 interactions passed) remains the only real-Safari evidence.

### Email and DNS

| Item | Status |
|---|---|
| Sending domain `mail.turnlineops.com` (Resend) | DKIM published (`resend._domainkey.mail`); SPF and MX for the return path on `send.mail` |
| DMARC (`_dmarc.turnlineops.com`, `_dmarc.mail.turnlineops.com`) | **Missing** |
| MX for `turnlineops.com` | **Missing, so mail to `support@turnlineops.com` cannot be delivered.** The privacy notice, FAQ, footer and confirm pages all point people there. |
| CAA | None (optional) |

## 2. Website changes in this PR
- **Feature statuses for the S2-05 MSFS 2020 + GSX Pro acceptance.** These capabilities are now "Implemented
  internally · MSFS 2020 tested":
  - live GSX boarding, refuelling, pushback and deboarding;
  - departure and arrival turnaround activity;
  - flight-linked turnaround history;
  - GSX Fuel invoice parsing, with currency confirmation and expense association.
  
  The USD 2,912.46 result is stated once, as a simulated fuel expense shown in the flight's Debrief.
- **Kept honest:**
  - Catering and de-icing, manual entries, readiness and manual expenses are "Implemented internally" only, because
    they're still Pending in acceptance.
  - Automatic receipt matching is "In active development".
  - Flight economics and revenue/profitability are "Planned".
  - New tests fail if any of these is presented as tested, working or available.
- **Operational flow section:** Dispatch → GSX turnaround → Debrief, using real app screens. The provenance is in
  `marketing/README.md` V4.
  - **No screenshot shows a simulated MSFS or GSX connection.** The live GSX panel is left out until there is a real
    capture.
- **Unchanged:** the early-access CTA (still the only conversion goal), the form contract, Turnstile, the navigation,
  the branding (navy, aviation gold, "Every flight. The whole operation.") and the `noindex,nofollow` posture.

## 3. Remaining blockers before promoting the website
In rough order. **Owner** means an action in Cloudflare, Supabase, Resend or with legal that this session can't take.

1. **Receive mail at `support@turnlineops.com`** (Owner, DNS).
   - Add MX records, for example Cloudflare Email Routing, then send a test message from an outside account.
   - The privacy notice's access and deletion route depends on this mailbox.
2. **Add `www.turnlineops.com`** (Owner, DNS).
   - Add the record and a 301 redirect to the apex, either as a Pages custom domain or a redirect rule.
   - People will type `www` from video captions.
3. **Publish DMARC** (Owner, DNS).
   - Start with `p=none; rua=…` for `turnlineops.com` and confirm alignment for `mail.turnlineops.com`.
   - Check that a confirmation email lands in the inbox, not spam, in Gmail and Outlook.
4. **Run the live waitlist acceptance on production** (Owner).
   - Follow `docs/testing/waitlist-live-acceptance.md` with an address you control: sign up → email delivered →
     confirm → unsubscribe → sign up again.
   - This also covers the pending regression check of the latest Edge Function's confirm and unsubscribe.
5. **Decide on Cloudflare Web Analytics** (Owner + privacy review).
   - Either disclose it in the privacy notice, or turn it off.
   - If you keep it, the CSP must allow `static.cloudflareinsights.com` before it is enforced.
6. **Turn off Cloudflare Email Address Obfuscation** (Owner; Cloudflare → Scrape Shield), or accept that contact links
   need JavaScript.
7. **Brand and legal review** (Owner, explicitly gated).
   - Trademark clearance for "Turnline".
   - Privacy notice review: controller identity, retention, and processors including Cloudflare.
   - Review of third-party names: Microsoft, Navigraph/SimBrief, FSDreamTeam/GSX.
8. **Discoverability approval** (Owner). Remove `noindex,nofollow`, then add a sitemap, only after item 7. This PR
   doesn't change it.
9. **Approve, merge and verify this PR on production** (Owner). Use the checklist in `marketing/README.md` →
   "Verify production after an approved merge".
10. **Real MSFS 2020 + GSX captures** (Owner).
    - The flow section uses sample data and leaves out the live GSX panel.
    - Before promotion, capture the Turnaround panel with GSX live and the real USD 2,912.46 Debrief (the expense
      persists, so you can still reopen that flight's Debrief and capture it).
    - The same footage feeds the teaser.
11. **Security hardening.**
    - Add HSTS. Start with a short `max-age`, without `preload`, until `www` is settled.
    - Remove the duplicate `Referrer-Policy` on `/confirm` and `/unsubscribe`.
    - Enforce the main-site CSP after the Safari review.
    - Decide whether the function-level rate limits are enough without a WAF in front of the Supabase function. Run
      the 429 test once on staging.
12. **Accessibility:** a screen-reader pass (VoiceOver on iOS, NVDA on Windows). Still pending from V3.
13. **Measurement.**
    - The measurement plan isn't live yet. Agree the UTM conventions for the teaser (for example
      `utm_source=tiktok&utm_medium=video&utm_campaign=teaser01`).
    - Count confirmed subscribers server-side (`confirmed_at`), not form submits.
14. **Optional:** refresh `og-image.png`, which still describes the V3 scope. It is accurate, but doesn't mention
    GSX.

## 4. First 30-second vertical teaser

**Format:** 1080×1920 (9:16), 30 s, 30 or 60 fps. Captions are burned in, because most viewers watch with the sound
off.
- **Safe area:** keep text out of the top ~250 px and the bottom ~420 px, where the TikTok, Reels and Shorts controls
  sit.
- **Look:** navy (`#0b1f3a`) caption plates, aviation-gold (`#f4b400`) highlights, and the Turnline mark and tagline
  on the end card.

### Asset list (all real footage; nothing mocked)

| # | Asset | Source and capture notes |
|---|---|---|
| A1 | Exterior: aircraft at the gate, jet bridge or stairs, GSX boarding | MSFS 2020 drone camera, 60 fps, 4K if possible. Use a fictional or house livery, not a real airline's. |
| A2 | GSX fuel truck refuelling | MSFS exterior, the same session as A1 |
| A3 | Pushback | MSFS exterior, low angle |
| A4 | Takeoff, 3–4 s | MSFS exterior or cockpit |
| A5 | Arrival and deboarding, 2–3 s | MSFS exterior |
| T1 | Dispatch: SimBrief plan imported | Screen recording of Turnline, window 1600×1000. Hide your SimBrief username and pilot ID before recording. |
| T2 | Live Flight → **Turnaround panel with GSX live**, states changing (boarding → refuelling → pushback) | Screen recording during the same session as A1–A3, so the states really change |
| T3 | Receipts & Expenses: scan → **Confirm currency → USD** → Count as expense → Associate | Screen recording. Use the real receipt from the session. |
| T4 | **Debrief: USD 2,912.46 simulated fuel expense** | Reopen the accepted flight's Debrief; the expense persists |
| B1 | End card | Turnline mark, "Every flight. The whole operation.", "Join the early-access list · turnlineops.com", "In development · internal build" |
| M1 | Music bed | A licensed track that allows commercial social use |
| L1 | Disclaimer line on the end card | "Not affiliated with Microsoft or FSDreamTeam. Expenses are simulated." |

**Before recording:**
- Hide the Windows taskbar, notifications and any user names in file paths.
- Turn off third-party overlays.
- Record Turnline and MSFS at the same time (OBS with two scenes), so the matching shots line up.
- **Keep every clip from one real session.** Don't stage UI states.

### Edit plan

| Time | Picture | Caption (burned in) |
|---|---|---|
| 0.0–2.5 s | A1 hero exterior at the gate; slow push-in | "Your flight doesn't start at takeoff." |
| 2.5–6.0 s | T1 Dispatch, cropped to the plan panel | "Plan it from your SimBrief OFP." |
| 6.0–13.0 s | Split screen: A2 on top, T2 below, with GSX states updating | "Turnline follows the GSX turnaround live." Small text if sped up: "sped up". |
| 13.0–16.0 s | A3 pushback over T2's pushback state | "Boarding. Refuelling. Pushback." |
| 16.0–18.5 s | A4 takeoff | none |
| 18.5–22.0 s | T3 currency confirmation (quick cuts) | "GSX's fuel invoice, confirmed by you…" |
| 22.0–26.0 s | T4 Debrief, highlighting USD 2,912.46 | "…lands in your flight Debrief. (Simulated cost)" |
| 26.0–30.0 s | B1 end card | "Every flight. The whole operation." + "Early access list → turnlineops.com" |

**Claims rules for the teaser** (the same as the site):
- Say "in development". No "available now", no download prompt and no price.
- Don't mention or show automatic receipt matching, flight economics, revenue or profit, or MSFS 2024.
- Any time-lapse must be labelled as sped up.
- The amount is a simulated fuel cost, not real money.

**Deliverables:**
- An H.264 master and a ProRes mezzanine.
- An SRT caption file.
- Three cover frames: the T2 GSX-live frame, T4 and B1.
- A one-line post caption with the UTM-tagged link.

**Pre-publish checks:**
- Legal and brand review (blocker 7). Showing GSX vehicles and naming GSX is a nominative use, so check it with
  counsel. Ask FSDreamTeam if you'd like their blessing.
- Blockers 1–4 and 9 must be done first, so the link the video drives traffic to fully works.
