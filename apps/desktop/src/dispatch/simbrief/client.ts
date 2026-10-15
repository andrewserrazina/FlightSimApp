/**
 * SimBrief latest-OFP fetcher (Navigraph "Fetching a user's latest OFP data").
 *
 * Integration rules from Navigraph's documentation, enforced here:
 * - Called only in response to a user action (the Dispatch page's import button). Never polled.
 * - The app identifies itself with `client=`.
 * - Username (Navigraph alias) is the preferred lookup; Pilot ID is supported for users who need it.
 * - `json=v2` (recommended for new implementations).
 * - No Navigraph password, login or token is ever requested: the endpoint is public per user alias.
 */
import type { SimbriefOfpV2 } from "./schema";

export const SIMBRIEF_ENDPOINT = "https://www.simbrief.com/api/xml.fetcher.php";
export const SIMBRIEF_CLIENT = "turnline";
export const SIMBRIEF_TIMEOUT_MS = 20_000;
/** A full OFP with navlog is a few hundred KB; anything far larger is not a SimBrief OFP. */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export type SimbriefIdentity = { kind: "username"; value: string } | { kind: "pilot_id"; value: string };

export type DispatchErrorKind =
  | "invalid_identity"
  | "user_not_found"
  | "no_flight_plan"
  | "network"
  | "timeout"
  | "simbrief_unavailable"
  | "invalid_response";

export interface DispatchError {
  kind: DispatchErrorKind;
  /** User-facing text. */
  message: string;
  /** SimBrief's own status text or HTTP status, for diagnostics. Never contains personal data. */
  detail?: string;
}

const USERNAME_RE = /^[A-Za-z0-9 _.\-]{1,64}$/;
const PILOT_ID_RE = /^\d{1,10}$/;

/** Trim and validate what the user typed; null when it cannot be a SimBrief alias / Pilot ID. */
export function normalizeIdentity(kind: SimbriefIdentity["kind"], raw: string): SimbriefIdentity | null {
  const value = raw.trim();
  if (kind === "username") return USERNAME_RE.test(value) ? { kind, value } : null;
  return PILOT_ID_RE.test(value) ? { kind, value } : null;
}

export function buildRequestUrl(identity: SimbriefIdentity): string {
  const q = new URLSearchParams();
  q.set(identity.kind === "username" ? "username" : "userid", identity.value);
  q.set("client", SIMBRIEF_CLIENT);
  q.set("json", "v2");
  return `${SIMBRIEF_ENDPOINT}?${q.toString()}`;
}

export const ERROR_TEXT: Record<DispatchErrorKind, string> = {
  invalid_identity: "Enter a SimBrief username (Navigraph alias) or a numeric Pilot ID.",
  user_not_found: "SimBrief does not know this username or Pilot ID. Check the spelling in your SimBrief account settings.",
  no_flight_plan: "SimBrief has no generated flight plan for this account. Generate an OFP on simbrief.com, then import again.",
  network: "SimBrief could not be reached. Check your internet connection. Your last imported plan is still available.",
  timeout: "SimBrief did not answer in time. Try again in a moment. Your last imported plan is still available.",
  simbrief_unavailable: "SimBrief is temporarily unavailable. Try again later. Your last imported plan is still available.",
  invalid_response: "SimBrief returned data Turnline could not read. Nothing was changed; your last imported plan is kept.",
};

export const dispatchError = (kind: DispatchErrorKind, detail?: string): DispatchError => ({ kind, message: ERROR_TEXT[kind], ...(detail ? { detail } : {}) });

/** Map SimBrief's `fetch.status` error text (HTTP 400) to a user-facing error kind. */
export function classifyFetchStatus(status: string): DispatchErrorKind {
  const s = status.toLowerCase();
  if (/(unknown|invalid|no such)\s+(user|userid|username|pilot)/.test(s) || /user(id|name)?\s+not\s+found/.test(s)) return "user_not_found";
  if (/(flight\s*plan|ofp|flight)/.test(s)) return "no_flight_plan";
  return "invalid_response";
}

export type FetchResult = { ok: true; data: SimbriefOfpV2 } | { ok: false; error: DispatchError };

export interface FetchDeps {
  fetch: typeof fetch;
  timeoutMs?: number;
}

/** One GET to SimBrief. All failures are returned as typed errors; this never throws. */
export async function fetchLatestOfp(identity: SimbriefIdentity, deps: FetchDeps): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? SIMBRIEF_TIMEOUT_MS);
  let response: Response;
  try {
    response = await deps.fetch(buildRequestUrl(identity), { method: "GET", headers: { Accept: "application/json" }, signal: controller.signal, credentials: "omit", cache: "no-store", redirect: "error" });
  } catch {
    clearTimeout(timer);
    return { ok: false, error: dispatchError(controller.signal.aborted ? "timeout" : "network") };
  }
  try {
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) return { ok: false, error: dispatchError("invalid_response", "response too large") };
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    const status = typeof body === "object" && body !== null ? (body as { fetch?: { status?: unknown } }).fetch?.status : undefined;
    if (response.status >= 500 || response.status === 429) return { ok: false, error: dispatchError("simbrief_unavailable", `HTTP ${response.status}`) };
    if (!response.ok) {
      // SimBrief answers 400 with {"fetch":{"status":"Error: …"}} for unknown users and similar errors.
      if (typeof status === "string") return { ok: false, error: dispatchError(classifyFetchStatus(status), status.slice(0, 120)) };
      return { ok: false, error: dispatchError(response.status === 404 ? "simbrief_unavailable" : "invalid_response", `HTTP ${response.status}`) };
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: dispatchError("invalid_response", "not a JSON object") };
    if (typeof status === "string" && status.toLowerCase() !== "success") return { ok: false, error: dispatchError(classifyFetchStatus(status), status.slice(0, 120)) };
    return { ok: true, data: body as SimbriefOfpV2 };
  } catch {
    return { ok: false, error: dispatchError(controller.signal.aborted ? "timeout" : "network") };
  } finally {
    clearTimeout(timer);
  }
}
