/**
 * How a failed cloud call should be handled:
 * - transient: retry with backoff (network, timeout, 5xx, 429)
 * - auth: pause until the user's session is valid again (401, expired/invalid JWT)
 * - permanent: stop retrying this item; needs user attention (validation, RLS/permission denial)
 */
export type CloudErrorKind = "transient" | "auth" | "permanent";

export interface ClassifiedError {
  kind: CloudErrorKind;
  /** Safe to show and to store: never contains tokens or request bodies. */
  message: string;
  /** True when the service could not be reached at all (likely offline). */
  network?: boolean;
}

const SAFE_MAX = 200;

function clean(text: string): string {
  // Strip anything that looks like a bearer token / JWT before it can reach logs or the database.
  return text.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "<token>").replace(/Bearer\s+\S+/gi, "Bearer <token>").slice(0, SAFE_MAX);
}

export function classifyCloudError(e: unknown): ClassifiedError {
  if (e instanceof DOMException && (e.name === "AbortError" || e.name === "TimeoutError")) return { kind: "transient", message: "The cloud request timed out." };
  const o = (e && typeof e === "object" ? e : {}) as { status?: number; code?: string; message?: string; name?: string };
  const status = typeof o.status === "number" ? o.status : undefined;
  const code = typeof o.code === "string" ? o.code : undefined;
  const msg = clean(typeof o.message === "string" ? o.message : String(e));
  if (o.name === "TypeError" || /fetch failed|network|ECONN|ETIMEDOUT|Failed to fetch|Load failed/i.test(msg)) return { kind: "transient", message: "The cloud service could not be reached.", network: true };
  if (status === 401 || code === "PGRST301" || code === "PGRST302" || code === "28000" || /JWT expired|invalid JWT|session/i.test(msg)) return { kind: "auth", message: "Your session has expired. Sign in again to continue synchronising." };
  if (status === 429 || status === 408 || (status !== undefined && status >= 500) || code === "57014" || code === "53300") return { kind: "transient", message: `The cloud service is temporarily unavailable (${status ?? code}).` };
  if (code === "42501" || status === 403) return { kind: "permanent", message: "The cloud refused this record (permission denied)." };
  return { kind: "permanent", message: msg || "The cloud rejected this record." };
}

/** Bounded exponential backoff with jitter: 10 s, 20 s, 40 s … capped at 30 min. */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(10_000 * 2 ** Math.max(0, attempt - 1), 30 * 60_000);
  return Math.round(base * (0.8 + random() * 0.4));
}

export const MAX_SYNC_ATTEMPTS = 8;
