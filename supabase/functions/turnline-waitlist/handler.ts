// Request handling for the turnline-waitlist Edge Function, free of Deno and network imports so it can be
// unit-tested (handler.test.ts) with an in-memory store and a mocked email provider. index.ts wires it to
// Supabase, Resend and Cloudflare Turnstile.
//
// Browser-facing HTML lives on the website (turnlineops.com/confirm and /unsubscribe), not here: hosted
// Supabase Edge Functions rewrite GET text/html responses to text/plain. This function only returns JSON and
// redirects.
//
// Flows:
// - POST {email, consent, captcha, source, utm_*}      signup (unchanged contract)
// - POST {action:"confirm", id, token}                 confirm a pending address (website, explicit click)
// - POST {action:"unsubscribe", id, token}             unsubscribe (website, explicit click)
// - GET ?action=confirm|unsubscribe&id&token           links in emails sent before the website pages existed:
//                                                      redirect, without touching data, to the website page
//                                                      with the values in the URL fragment.
// Email scanners may prefetch any GET, so no GET ever changes data.

export interface WaitlistRow {
  id: string;
  created_at?: string;
  updated_at: string;
  verification_hash: string | null;
  verification_expires_at: string | null;
  confirmed_at: string | null;
  unsubscribed_at: string | null;
}

/** Storage operations; each returns null on a storage error (reported as temporarily unavailable). */
export interface WaitlistStore {
  checkLimit(bucket: string, limit: number): Promise<boolean>;
  findByEmail(email: string): Promise<{ row: WaitlistRow | null } | null>;
  findById(id: string): Promise<{ row: WaitlistRow | null } | null>;
  insert(patch: Record<string, unknown>): Promise<{ id: string } | null>;
  update(id: string, patch: Record<string, unknown>): Promise<boolean>;
  /** Sets confirmed_at only if the row still has this hash, is unconfirmed and not unsubscribed. */
  confirm(id: string, verificationHash: string, at: string): Promise<{ updated: boolean } | null>;
  /** Sets unsubscribed_at only if it is not already set. */
  unsubscribe(id: string, at: string): Promise<{ updated: boolean } | null>;
}

export interface WaitlistDeps {
  env: (key: string) => string;
  store: WaitlistStore;
  sendEmail: (to: string, subject: string, html: string) => Promise<void>;
  verifyCaptcha: (token: string) => Promise<{ ok: boolean; success?: boolean; hostname?: string }>;
  now?: () => number;
  randomToken?: () => string;
}

const encoder = new TextEncoder();
const toHex = (bytes: Uint8Array) => Array.from(bytes).map((x) => x.toString(16).padStart(2, "0")).join("");
export const sha = async (s: string) => toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(s))));
export const hmac = async (secret: string, s: string) => {
  const k = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", k, encoder.encode(s))));
};
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c);

const ID_RE = /^[0-9a-f-]{36}$/i;
const UNSUB_TOKEN_RE = /^[0-9a-f]{64}$/;
const confirmTokenOk = (t: string) => t.length >= 32 && t.length <= 200 && /^[A-Za-z0-9-]+$/.test(t);

const REQUIRED = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "WAITLIST_ALLOWED_ORIGIN", "WAITLIST_SITE_URL", "WAITLIST_FUNCTION_URL", "TURNSTILE_SECRET_KEY", "RESEND_API_KEY", "WAITLIST_FROM_EMAIL", "WAITLIST_SIGNING_SECRET"];

/** Website pages that receive email links. The id and token travel in the fragment, which browsers never send to a server. */
export const pageLink = (site: string, page: "confirm" | "unsubscribe", id: string, token: string) =>
  `${site}/${page}#id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`;

export function createHandler(deps: WaitlistDeps): (req: Request) => Promise<Response> {
  const { env, store } = deps;
  const now = deps.now ?? Date.now;
  const randomToken = deps.randomToken ?? (() => crypto.randomUUID() + crypto.randomUUID());

  return async (req: Request) => {
    const ORIGIN = env("WAITLIST_ALLOWED_ORIGIN");
    const SITE = env("WAITLIST_SITE_URL");
    const SECRET = env("WAITLIST_SIGNING_SECRET");
    const cors = { "Access-Control-Allow-Origin": ORIGIN, "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "content-type", "Vary": "Origin" };
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", ...cors } });
    const redirectTo = (location: string) =>
      new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });

    if (!REQUIRED.every((k) => env(k))) return json({ error: "service_unconfigured" }, 503);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);

    // ---- Links from emails sent before the website pages: hand over to the website without reading or changing data.
    const legacy = url.searchParams.get("action");
    if (req.method === "GET" && (legacy === "confirm" || legacy === "unsubscribe")) {
      const id = url.searchParams.get("id") || "";
      const token = url.searchParams.get("token") || "";
      const wellFormed = ID_RE.test(id) && (legacy === "confirm" ? confirmTokenOk(token) : UNSUB_TOKEN_RE.test(token));
      return redirectTo(wellFormed ? pageLink(SITE, legacy, id, token) : `${SITE}/${legacy}`);
    }

    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    if (req.headers.get("origin") !== ORIGIN) return json({ error: "invalid_origin" }, 403);
    let input: Record<string, unknown>;
    try {
      const raw = await req.text();
      if (raw.length > 5000) return json({ error: "invalid_request" }, 413);
      input = JSON.parse(raw);
      if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("invalid");
    } catch {
      return json({ error: "invalid_request" }, 400);
    }

    const digest = async (v: string) => sha(SECRET + ":" + v);
    const rate = async (label: string, identity: string, limit: number) => store.checkLimit(label + ":" + (await digest(identity)), limit);
    const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for")?.split(",").slice(-1)[0]?.trim() || "unknown";

    // ---- Confirm / unsubscribe from the website (explicit user action). One generic error for anything invalid,
    // so the response never says whether an id exists or which part was wrong.
    if (input.action === "confirm" || input.action === "unsubscribe") {
      const id = typeof input.id === "string" ? input.id : "";
      const token = typeof input.token === "string" ? input.token : "";
      if (!(await rate("verify-ip", ip, 60))) return json({ error: "rate_limited" }, 429);
      const at = new Date(now()).toISOString();

      if (input.action === "unsubscribe") {
        if (!ID_RE.test(id) || !UNSUB_TOKEN_RE.test(token) || (await hmac(SECRET, "unsubscribe:" + id)) !== token) return json({ error: "invalid_or_expired" }, 400);
        // Idempotent: repeating it, or a record already removed by retention, still reads as unsubscribed.
        const r = await store.unsubscribe(id, at);
        if (!r) return json({ error: "temporarily_unavailable" }, 503);
        return json({ status: "unsubscribed" });
      }

      if (!ID_RE.test(id) || !confirmTokenOk(token)) return json({ error: "invalid_or_expired" }, 400);
      const found = await store.findById(id);
      if (!found) return json({ error: "temporarily_unavailable" }, 503);
      const row = found.row;
      if (!row || row.unsubscribed_at || !row.verification_hash) return json({ error: "invalid_or_expired" }, 400);
      const tokenMatches = (await sha(token)) === row.verification_hash;
      // Repeat clicks on a valid link after confirmation are fine; a wrong token never learns the state.
      if (row.confirmed_at) return tokenMatches ? json({ status: "already_confirmed" }) : json({ error: "invalid_or_expired" }, 400);
      if (!tokenMatches || !row.verification_expires_at || Date.parse(row.verification_expires_at) < now()) return json({ error: "invalid_or_expired" }, 400);
      const r = await store.confirm(id, row.verification_hash, at);
      if (!r) return json({ error: "temporarily_unavailable" }, 503);
      // Lost a race with a parallel click: re-read and report the real state.
      if (!r.updated) {
        const again = await store.findById(id);
        return again?.row?.confirmed_at && !again.row.unsubscribed_at ? json({ status: "already_confirmed" }) : json({ error: "invalid_or_expired" }, 400);
      }
      return json({ status: "confirmed" });
    }
    if (input.action !== undefined) return json({ error: "invalid_request" }, 400);

    // ---- Signup (unchanged contract).
    const email = String(input.email || "").trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || input.consent !== true || typeof input.captcha !== "string" || input.captcha.length > 4096) return json({ error: "invalid_request" }, 400);
    // Database-backed atomic limits; global and email limits still apply if proxy IP headers are absent.
    if (!(await rate("global", "waitlist", 300)) || !(await rate("ip", ip, 20)) || !(await rate("email", email, 4))) return json({ error: "rate_limited" }, 429);
    const check = await deps.verifyCaptcha(input.captcha);
    if (!check.ok) return json({ error: "temporarily_unavailable" }, 503);
    if (!check.success || check.hostname !== new URL(ORIGIN).hostname) return json({ error: "verification_failed" }, 400);
    const found = await store.findByEmail(email);
    if (!found) return json({ error: "temporarily_unavailable" }, 503);
    const existing = found.row;
    // Avoid revealing whether an email already belongs to the list.
    if (existing?.confirmed_at && !existing.unsubscribed_at) return json({ ok: true });
    if (existing && now() - Date.parse(existing.updated_at) < 60_000) return json({ ok: true });
    const token = randomToken();
    const hash = await sha(token);
    const meta = (k: string) => (typeof input[k] === "string" ? String(input[k]).slice(0, 100) : null);
    const stamp = new Date(now()).toISOString();
    const patch = { email, consented_at: stamp, verification_hash: hash, verification_expires_at: new Date(now() + 48 * 3600_000).toISOString(), confirmed_at: null, unsubscribed_at: null, source: "turnline_waitlist", utm_source: meta("utm_source"), utm_medium: meta("utm_medium"), utm_campaign: meta("utm_campaign"), updated_at: stamp };
    let id: string;
    if (existing) {
      if (!(await store.update(existing.id, patch))) return json({ error: "temporarily_unavailable" }, 503);
      id = existing.id;
    } else {
      const inserted = await store.insert(patch);
      if (!inserted) return json({ error: "temporarily_unavailable" }, 503);
      id = inserted.id;
    }
    const confirm = pageLink(SITE, "confirm", id, token);
    const unsubscribe = pageLink(SITE, "unsubscribe", id, await hmac(SECRET, "unsubscribe:" + id));
    const body = '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0b1f3a"><h1>TURNLINE</h1><p>Confirm your email to receive development updates and beta invitations.</p><p><a style="background:#f4b400;color:#0b1f3a;padding:12px 18px;display:inline-block" href="' + escapeHtml(confirm) + '">Confirm my email</a></p><p>The link opens turnlineops.com, where you confirm with one more click. It expires in 48 hours. If you did not request this, ignore the message.</p><hr><p style="font-size:12px">You can <a href="' + escapeHtml(unsubscribe) + '">unsubscribe</a> at any time.</p></div>';
    try {
      await deps.sendEmail(email, "Confirm your Turnline updates", body);
    } catch {
      return json({ error: "temporarily_unavailable" }, 503);
    }
    return json({ ok: true });
  };
}
