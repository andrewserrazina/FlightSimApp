# Waitlist: first-party confirmation and unsubscribe pages

## Root cause (production, first live acceptance)

The confirmation email linked to the Edge Function
(`…/functions/v1/turnline-waitlist?action=confirm&id=…&token=…`), and the function answered the GET with an HTML
form. **Hosted Supabase Edge Functions rewrite `text/html` GET responses to `text/plain`**, so browsers showed raw
markup or downloaded `turnline-waitlist.txt`. The unsubscribe link (`?action=unsubscribe…`) had the same defect.
Signup itself (JSON POST) was not affected.

## New flow

1. The signup POST from the homepage is unchanged.
2. The email links point to the website, with the values in the **URL fragment**:
   - `https://turnlineops.com/confirm#id=<uuid>&token=<token>`
   - `https://turnlineops.com/unsubscribe#id=<uuid>&token=<hmac>`

   Browsers never send a fragment to a server, so the token is not in Cloudflare or Supabase request logs, not in
   any `Referer`, and not in analytics (the site has none).
3. The page (`marketing/confirm.html` or `unsubscribe.html` with `assets/verify.js`):
   - reads the values and removes them from the address bar (`history.replaceState`);
   - explains the action and shows **Confirm my email** or **Unsubscribe me**.

   Opening the page changes nothing.
4. Clicking sends one JSON POST to the function: `{"action":"confirm"|"unsubscribe","id":…,"token":…}`.
   - The function accepts it only with `Origin: https://turnlineops.com` (CORS is restricted to the same origin).
   - Requests are rate limited at 60 per IP per hour, using the existing `turnline_waitlist_check_limit`.
5. The function responds with JSON, and the page shows the result.

| Request | Response |
|---|---|
| Valid confirm | `200 {"status":"confirmed"}` |
| Repeat confirm with the same valid link | `200 {"status":"already_confirmed"}` |
| Wrong, expired or malformed token, unknown id, or unsubscribed record | `400 {"error":"invalid_or_expired"}`. The same response in every case, so nothing reveals whether an address or id exists. |
| Valid unsubscribe, including repeats | `200 {"status":"unsubscribed"}`. The first unsubscribe time is kept. |
| Bad unsubscribe signature | `400 {"error":"invalid_or_expired"}` |
| Rate limit | `429` |
| Storage error | `503` (nothing changed) |
| Other origin | `403` |

**Unchanged:**
- the 48-hour expiry and SHA-256 token hash;
- the HMAC unsubscribe signature;
- the conditional confirm update (same hash, not confirmed, not unsubscribed);
- consent records, the signup rate limits, Turnstile and Resend;
- suppression: signing up again after unsubscribing needs a new opt-in and confirmation;
- the database schema (no migration).

## Backward compatibility (emails already sent)

- Old links still point to the function.
- After the new function is deployed, a GET to `?action=confirm|unsubscribe&id&token` returns `303` to the matching
  website page with the values in the fragment. It does not read or change the database.
- Malformed old links redirect to the page without values, and the page explains the problem.
- Old confirmation tokens stay valid until their original 48-hour expiry.

## Deployment order (each step needs owner approval)

1. **Website first:** merge the PR to `main`; Cloudflare Pages deploys `/confirm` and `/unsubscribe`.
   - Nothing links to these pages yet.
   - If someone opened one, its POST would reach the old function, which answers `400`. The page would say "invalid
     or expired" and change nothing.
2. **Function second:** deploy `supabase/functions/turnline-waitlist` (both `index.ts` and `handler.ts`).
   - Settings stay as today: `verify_jwt=false` and the same secrets.
   - `WAITLIST_SITE_URL` must be exactly `https://turnlineops.com`, with no trailing slash.
   - From then on:
     - new emails link to the website;
     - old links redirect there;
     - the pages' POSTs work.
3. Run the manual acceptance below once, with an address you control.

**Rollback:**
- Re-deploy the previous function version. Old-style links then return the broken text page again, so prefer pausing
  signups instead.
- To pause signups without a function change, set `apiUrl: ""` in `marketing/config.js`. The pages then say the
  service is temporarily unavailable.

## Security notes

- **Tokens:**
  - never in a request URL to Cloudflare (fragment), only in the POST body to Supabase;
  - removed from the address bar on load;
  - never logged (the function has no logging; the page doesn't log either).
  - Both pages have no third-party scripts, so tokens don't reach analytics.
- **Indexing, referrers and caching:**
  - `noindex,nofollow` meta tag plus the site-wide `X-Robots-Tag`;
  - `<meta name="referrer" content="no-referrer">`, `Referrer-Policy: no-referrer`, and the fetch uses
    `referrerPolicy:'no-referrer'`;
  - `Cache-Control: no-store`.
  - Cloudflare joins duplicate headers with a comma; browsers use the last valid referrer policy (`no-referrer`).
- **Enforced CSP on both pages:** `default-src 'none'`, scripts and styles from self only, `connect-src` only the
  Supabase project, `form-action 'none'`, `frame-ancestors 'none'`. There is no inline code on these pages. The
  site-wide Report-Only policy still applies elsewhere.
- **No GET writes:** scanner prefetches of the email link, the redirect or the page cannot confirm or unsubscribe
  anyone. The POST requires the Turnline origin, and browsers won't send a cross-site JSON POST without CORS approval.
- **No enumeration:** confirm errors are identical for unknown ids, wrong tokens and expired links. A wrong token on a
  confirmed record also gets `invalid_or_expired`; the old code redirected to "confirmed" regardless of the token.
- **No secrets in the browser:** `config.js` still holds only the public endpoint and Turnstile site key. The secret
  scan covers the new files.
- **Email click tracking:** keep Resend click tracking **off** for the sending domain. A tracking redirect would see
  the full link, including the fragment.

## Automated tests

- `node --test supabase/functions/turnline-waitlist/handler.test.ts` (also run in CI). It uses an in-memory store
  and mocked email and Turnstile, and covers:
  - links in the fragment, with no query strings;
  - GET never writes, and legacy links redirect;
  - confirm, already confirmed, expired, wrong, malformed and unknown links;
  - no state leak on a confirmed record;
  - unsubscribe, its idempotence and a forged signature;
  - suppression and re-opt-in;
  - origin, CORS preflight, rate limit and storage failures;
  - the unchanged signup contract.
- `scripts/marketing-site-test.mjs` (Chromium; signup endpoint intercepted, reserved test domains only). It covers:
  - opening a page sends nothing and strips the token;
  - clicking sends one POST with the exact body and no `Referer`;
  - success, already-confirmed, invalid and retry-after-error states;
  - malformed and missing links;
  - the rollback config and no-JS recovery text;
  - 320 and 768 px layouts;
  - `_headers` rules, and the page working under the enforced CSP;
  - clean URLs.

## Manual production acceptance (once, after both deployments)

Use one address you control, and don't paste tokenised links anywhere.

1. Sign up on https://turnlineops.com, then check the email arrives from the Turnline sender.
2. Hover or long-press **Confirm my email**: the link starts `https://turnlineops.com/confirm#`.
3. Open it on a phone (Safari) or a desktop browser:
   - the branded page appears;
   - the address bar shows just `/confirm`;
   - no file downloads;
   - in the Supabase table, `confirmed_at` is still empty.
4. Press **Confirm my email**. Check you see "Your email is confirmed" and that `confirmed_at` is now set.
5. Press reload on the confirm page and check that it says the link is incomplete (the token was removed). Then
   reopen the email link and press the button: "already confirmed".
6. Open **unsubscribe** from the email:
   - the page appears;
   - `unsubscribed_at` is still empty;
   - press **Unsubscribe me** → "You are unsubscribed" and `unsubscribed_at` is set;
   - repeating it says the same.
7. **Optional (old links):** if an email sent before this change is still within 48 hours, open its link. Check it
   lands on `turnlineops.com/confirm` and works the same way.
8. Check the Supabase function logs show no tokens or full email addresses.

On failure, pause signups (`apiUrl: ""`) and report the step.
