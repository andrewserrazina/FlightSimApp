/**
 * Subscription entitlements — interface only (S1-05). Billing is separate from authentication:
 * an authenticated user is not automatically entitled to anything, and the client never decides.
 *
 * Future flow (see docs/architecture/entitlements.md): Stripe webhooks → server (service role)
 * writes `subscriptions` → `public.my_entitlements` (read-only, RLS) → the client displays it.
 * Paid-feature checks that matter are enforced server-side; the client value is informational.
 */
export type PlanCode = "free" | "pro";

export type EntitlementStatus =
  | { kind: "unknown"; reason: "signed_out" | "offline" | "not_implemented" }
  | { kind: "known"; plan: PlanCode; source: "server"; validUntilUtc: string | null };

export type Feature = "cloud_sync" | "advanced_debrief" | "airline_operations";

/** Read-only source of entitlement facts. Implementations must read server data only. */
export interface EntitlementProvider {
  current(): Promise<EntitlementStatus>;
}

/** S1-05: no billing yet. Reports "unknown" rather than inventing a plan; nothing is gated. */
export const notYetImplementedEntitlements: EntitlementProvider = {
  current: async () => ({ kind: "unknown", reason: "not_implemented" }),
};

/** No paid restrictions are enforced in S1-05; kept explicit so call sites are ready later. */
export function isFeatureEnabled(_feature: Feature, _status: EntitlementStatus): boolean {
  return true;
}
