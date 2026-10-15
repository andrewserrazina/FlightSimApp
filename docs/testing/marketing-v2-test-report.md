# Marketing site V2: test report

- **Date:** 2026-10-15
- **Scope:** `marketing/` (index.html, privacy.html, assets/)
- **Tools:** Playwright 1.56 with headless Chromium, run in the Linux development container

## Automated: `scripts/marketing-site-test.mjs`: 65/65 passed

How the suite runs:
- **Safety:** the signup endpoint and every Cloudflare request are intercepted. Nothing reaches production, and
  only reserved `example.com` / `example.invalid` addresses are used.
- **`--live-turnstile`:** loads the real Cloudflare Turnstile script with Cloudflare's public always-pass test
  key.

| Area | Checks |
|---|---|
| Secrets and config | No secret patterns in any browser-delivered file. `config.js` holds only `apiUrl` and `turnstileSiteKey`. |
| Metadata | `noindex,nofollow` on both pages. Title, description, Open Graph, Twitter card and favicon present. |
| Layout | No horizontal scroll at 320, 390, 768, 1024, 1280 and 1440 px (privacy page at 390 and 1280). |
| Resources | Every local resource returns 200. No console or page errors. No unexpected external requests. |
| Navigation | Every in-page anchor has a target; no duplicate ids; one h1. All 10 sections and the footer are present. Nav links land below the sticky header. The join CTA focuses the email field. |
| Mobile menu | The toggle sets `aria-expanded`. Escape closes the menu and returns focus. Choosing a link closes the menu and navigates. |
| Footer and privacy | The footer has early access, roadmap, FAQ, privacy, support email, © 2026, operator and non-affiliation text. The privacy page has V2 navigation back to the site, its legal text is intact, and its footer FAQ link lands on the section. |
| Interactive | The FAQ opens by click and keyboard. Feature tabs follow the WAI-ARIA tabs pattern (arrow, Home, End). Only the four defined status labels are used. The scenario toggle works. Concept visuals are labelled. |
| Accessibility | First Tab reaches the skip link. Every link, button and input has an accessible name. Reduced motion shows all content. Without JS, all six feature panels and all content are readable. |
| Turnstile | The script loads and renders with the configured site key, inside `#signup`. **Live:** the real widget initialises and its token is submitted (test key). |
| Validation | Empty or malformed email is blocked and marked invalid. Consent is required, with a visible message. The verification check is required. No request is sent in any of these cases. |
| Request contract | POST to the configured `apiUrl` with JSON body keys exactly `captcha, consent, email, source, utm_campaign, utm_medium, utm_source`. UTM values are forwarded and capped at 100 characters. A second submit while one is in flight is ignored. |
| Results | Success shows the message, then resets the form and Turnstile. Distinct messages for 503, 429, 400 and network failure (the email is kept). Redirect messages for `confirmed`, `unsubscribed`, `invalid` and `error`; unknown values are ignored. The rollback config shows "Signups are not open yet" and loads no CAPTCHA. |

Run it with:

```
PLAYWRIGHT_MODULE=<path>/playwright/index.mjs node scripts/marketing-site-test.mjs --live-turnstile --out <dir>
```

## Manual and visual

- **Screenshots:** section-by-section on desktop and mobile in `docs/screenshots/marketing-v2/`, reviewed by eye.
  Fixed during review: CSS specificity bugs (nav CTA contrast, eyebrow colours, the join card), status-pill
  sizing, the legend layout, and the mobile timeline label.
- **WCAG contrast:** all text pairs used are ≥ 5.19:1 (AA); the input border is 4.04:1 (UI components need ≥ 3:1).
- **Privacy notice:** all 25 sentences of the committed notice are verified present after the layout change.

## Not verified (limitations)

- **Live production signup on turnlineops.com:** real delivery, the confirm page and unsubscribe. This needs an
  owner-controlled inbox; see `docs/testing/waitlist-live-acceptance.md`. No real address was used.
- **The production Turnstile key on the production hostname.** Only Cloudflare's test key was exercised.
- **Other engines:** Safari/WebKit and Firefox were not tested, and neither were real iOS or Android devices.
  Only Chromium was used. `color-mix()` has a fallback for older browsers.
- **Screen readers:** no NVDA or VoiceOver pass; semantics were checked automatically only.
- **The deployed Cloudflare Pages build.** At test time turnlineops.com was still serving V1.
