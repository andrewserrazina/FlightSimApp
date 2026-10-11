# Entitlements (interface only — S1-05)

**Nothing is implemented and nothing is enforced.** There are no subscriptions, no Stripe and no
paywall. The client never decides what a user has paid for.

## What exists

`packages/cloud/src/entitlements.ts`:

- `PlanCode = "free" | "pro"`; `Feature = "cloud_sync" | "advanced_debrief" | "airline_operations"`.
- `EntitlementStatus`: either `unknown` (with a reason: `signed_out`, `offline`,
  `not_implemented`) or `known` (plan, `source: "server"`, valid until).
- `EntitlementProvider.current()`: a read-only source. Implementations must read **server** data
  only.
- `notYetImplementedEntitlements` returns `unknown / not_implemented`. It does not invent a plan.
- `isFeatureEnabled()` returns `true` for everything: no paid restriction exists in S1-05. It is
  kept so call sites are ready later.

Database (migration 0002):
- `subscriptions`, `billing_customers` and `billing_webhook_receipts` have **no client write
  privileges**.
- `public.my_entitlements` (security_invoker) lets a signed-in user read their own
  `plan_code, status, current_period_end`. Nothing writes to it yet.

## Server-authoritative plan for later

1. **Checkout** runs on a server endpoint (Supabase Edge Function or similar) that creates a
   Stripe Checkout session for the authenticated user. The desktop app only opens the returned URL.
2. **Webhooks** (`checkout.session.completed`, `customer.subscription.*`, `invoice.*`) go to a
   server function.
   - It verifies the Stripe signature.
   - It records the event id in `billing_webhook_receipts`, so replays are idempotent.
   - It writes `billing_customers` / `subscriptions` with the **service role**, which only that
     server holds.
3. **The client reads `my_entitlements`** for display and caches it with a timestamp. Offline,
   it shows the cached value as *last known*. It never upgrades itself.
4. **Enforcement happens where the resource is.** For example:
   - Cloud features check the subscription in RLS or SECURITY INVOKER RPCs, joined to
     `subscriptions`.
   - Paid server work checks before doing anything.
   - A tampered client can only change what it *displays*, never what it *gets*.
5. **Local-only features stay usable** regardless of plan, and local data is never withheld. A
   product decision on which features are paid is still open.
