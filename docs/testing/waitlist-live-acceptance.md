# Turnline live waitlist acceptance — 2026-10-14

This is a **live-test checklist**, not evidence of completion. Run only after the website deploys the updated `marketing/config.js`.

Environment:
- Public website: https://turnlineops.com
- Edge function: https://itapyrwjijnvzdsatttp.supabase.co/functions/v1/turnline-waitlist
- Mailing sender: updates@mail.turnlineops.com
- Support address: support@turnlineops.com
- Staging database project: itapyrwjijnvzdsatttp

## Manual acceptance
1. Visit https://turnlineops.com with a regular browser, reload fully, verify CAPTCHA is visible.
2. Submit a **test email address you own** with the consent checkbox ticked; confirm the UI says to check your inbox.
3. Confirm delivery from the verified Turnline sender and note the approximate delay. Do not paste tokenized email URLs into issues or chat.
4. Open the confirmation link; site must display `Your email is confirmed`.
5. Repeat using the same confirmed email; no duplicate database row, no account enumeration or unnecessary resend.
6. Open the email's unsubscribe link: it must first display an unsubscribe confirmation page; simply opening the link must NOT unsubscribe.
7. Press **Unsubscribe me** and verify the website's unsubscribed status. All future marketing exports must filter `confirmed_at IS NOT NULL AND unsubscribed_at IS NULL`.
8. Test invalid captcha / absent consent / malformed email, rejection of a foreign Origin, oversized JSON request and 429 rate-limiting; do not perform bulk load tests against production.
9. Check Supabase Edge Function logs for errors; ensure no secret keys, raw verification tokens, or complete email addresses appear.
10. Verify the privacy notice has the operator, business mailing address, monitored email, and retention/deletion rules.
11. Have the owner confirm proper Turnstile hostname and DNS, the Resend sender, and that signed links behave on macOS/iPhone as well.

## Backend changes
- 0005: hour-bucketed atomic rate counters: global 300/hour, IP 20/hour, email 4/hour; per-IP header handling is best-effort, not a replacement for perimeter WAF.
- 0006: daily 03:15 database cron cleanup of pending records after 30 days, unsubscribed records after 30 days and confirmed inactive records after 24 months.
- Unsubscribe GET shows confirmation form; POST executes unsubscribe to prevent email scanning prefetch.
- Signup method validates Origin and Cloudflare Turnstile response hostname and uses secrets server-side.

## Hold / rollback
If the live test fails, immediately change `marketing/config.js` `apiUrl` to an empty string and redeploy, and restore the Edge Function's `verify_jwt: true`. **Do not claim live end-to-end verified before manual confirmation and database verification.**

## Open issues
- Trademark clearance for Turnline before wide promotion.
- Owner/legal review of the notice for jurisdictional requirements.
- Confirm the intended business address is safe to publish.
- Add trusted edge gateway/WAF protection if traffic rises; client IP address forwarding isn't necessarily guaranteed.
