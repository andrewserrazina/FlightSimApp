# Turnline acquisition and launch analytics — v0.1

**Status:** Measurement schema and manual dashboard template, not a live analytics deployment.

## North-star metric
**Confirmed qualified waitlist signups per week**, not raw unverified emails, impressions or low-intent follows.

## Event taxonomy
| Event | Definition | Trigger | PII allowed? |
|---|---|---|---|
| `landing_view` | page presented | privacy-appropriate first-party counting | No |
| `waitlist_submit_attempt` | visitor clicks Join | client-side aggregate only, only when approved | No |
| `waitlist_confirmed` | email confirmation verified | authoritative server-side transition | Subscriber row has email; analytics event must not |
| `waitlist_unsubscribed` | opt-out completed | server-side transition | No raw email in analytics |
| `beta_invited` | invited user | future operational campaign | No email in analytics export |
| `beta_installed` | install attributed, where consent permits | future desktop event | No persistent fingerprint |
| `first_flight_completed` | real flight record completed | future privacy-reviewed aggregate | No flight route linked to email |
| `trial_started` / `subscription_paid` | authoritative billing state | future billing backend | No revenue claim before verification |

### Definitions
- **Visitor-to-verified rate** = newly verified subscribers / unique consent-compliant landing visitors within attribution window.
- **Email verification rate** = confirmed / submitted eligible requests over same reporting cohort.
- **Cost per confirmed lead** = campaign cash spend / confirmed leads credited to campaign.
- **Beta activation** = users who completed first supported flight / users who installed and opened the beta.
- **Trial-to-paid** = paid accounts / ended or mature trial cohort, excluding still-running trials.
- **MRR** = actual recurring monthly subscription value, adjusting annual plans to monthly equivalence; exclude one-time charges/refunds per chosen accounting policy.
- **Churn** = subscription cancellations / customers at start of period; separately track revenue churn.

## UTMs
- `utm_source`: `tiktok`, `instagram`, `youtube`, `creator_name`, `discord`, `reddit` or `direct`.
- `utm_medium`: `organic_social`, `creator`, `community`, `email`, `paid_social`.
- `utm_campaign`: `prelaunch_2026_w01`, `closed_beta_2027`, `public_beta_2027`, `launch_2027`.
- `utm_content`: `p01` … `p12` (page doesn't currently capture this field; add schema and function support before using it for attribution).
Never place emails, tokens or names in UTMs.

## Weekly reporting
See `weekly-scorecard.csv`. One row per calendar week, Monday 00:00 UTC through next Monday 00:00 UTC. Enter **observed counts**, not targets, in actual columns. Mark zero only when measured; blank means not available. Count subscribers on server; use aggregate sources for social reach.

Metrics to review: confirmed adds, verification rate, new site visitors, visits by source, creator replies, trial activations, active beta pilots, paid conversions, gross MRR, defect gate, spend and CPL.

## Queries for an authorized server-side analyst
Execute only through a privileged server-side SQL client, never expose service-role access to the website.

```sql
-- Current verified, subscribed waitlist size
select count(*) as confirmed_active
from public.turnline_waitlist
where confirmed_at is not null and unsubscribed_at is null;

-- Weekly confirmed additions, UTC week
select date_trunc('week', confirmed_at at time zone 'UTC') as week_utc,
       count(*) as newly_confirmed
from public.turnline_waitlist
where confirmed_at is not null
group by 1 order by 1 desc;

-- Acquisition mix (last-touch stored on lead at time of sign-up)
select coalesce(nullif(utm_source,''), 'unknown') as source,
       count(*) filter(where confirmed_at is not null) as confirmed,
       count(*) as total_records
from public.turnline_waitlist
group by 1 order by confirmed desc;
```

**Caveat:** The current database holds only the latest consent state for an email. This is not a historical event log; these queries cannot reconstruct all repeat submissions or cancellations over time. Attribution is currently only source/medium/campaign and is not robust to repeat signups. Add a non-PII append-only analytics event ledger when compliant instrumentation is ready.

## Targets (planning assumptions)
- Oct 31: 50 confirmed qualified leads
- Dec 31: 300
- Feb 23 closed beta: 600
- Apr 13 public beta: 1,000
- May 18 paid target: 1,200

These are aspirational, subject to legal clearance, working signup infrastructure and product readiness.

## Weekly decision rule
If visitors are low: improve channel distribution and creator partnerships.
If visitors are healthy but verification low: test email delivery and form friction.
If verified leads rise but beta activation falls: fix onboarding/product instead of increasing marketing spend.
If paid conversion is low: validate experience, pricing and promised value before escalating ad spend.
