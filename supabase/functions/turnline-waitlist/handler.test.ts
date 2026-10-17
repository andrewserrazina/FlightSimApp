// Unit tests for the waitlist handler: in-memory store, mocked email and Turnstile. No network, no real email.
//   node --test supabase/functions/turnline-waitlist/handler.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHandler, hmac, pageLink, sha, type WaitlistRow, type WaitlistStore } from "./handler.ts";

const ORIGIN = "https://turnlineops.com";
const FN = "https://example.supabase.co/functions/v1/turnline-waitlist";
const SECRET = "test-signing-secret-0123456789abcdef0123456789";
const ENV: Record<string, string> = {
  SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "test-service", WAITLIST_ALLOWED_ORIGIN: ORIGIN, WAITLIST_SITE_URL: ORIGIN,
  WAITLIST_FUNCTION_URL: FN, TURNSTILE_SECRET_KEY: "test-turnstile", RESEND_API_KEY: "test-resend", WAITLIST_FROM_EMAIL: "updates@example.com", WAITLIST_SIGNING_SECRET: SECRET,
};
const ID = "6b1f0c2e-4d5a-4e8b-9f3c-2a7d1e5b8c40";

type Row = WaitlistRow & { email: string };
function setup(opts: { failStore?: boolean; limitOk?: boolean } = {}) {
  let clock = Date.parse("2026-10-17T12:00:00Z");
  const rows = new Map<string, Row>();
  const sent: Array<{ to: string; subject: string; html: string }> = [];
  const writes: string[] = [];
  let nextId = 0;
  const store: WaitlistStore = {
    async checkLimit() { return opts.limitOk ?? true; },
    async findByEmail(email) { if (opts.failStore) return null; return { row: [...rows.values()].find((r) => r.email === email) ?? null }; },
    async findById(id) { if (opts.failStore) return null; return { row: rows.get(id) ?? null }; },
    async insert(patch) {
      const id = nextId++ === 0 ? ID : `00000000-0000-4000-8000-00000000000${nextId}`;
      rows.set(id, { id, ...(patch as object) } as Row); writes.push("insert"); return { id };
    },
    async update(id, patch) { Object.assign(rows.get(id)!, patch); writes.push("update"); return true; },
    async confirm(id, hash, at) {
      if (opts.failStore) return null;
      const r = rows.get(id);
      if (!r || r.verification_hash !== hash || r.unsubscribed_at || r.confirmed_at) return { updated: false };
      r.confirmed_at = at; r.updated_at = at; writes.push("confirm"); return { updated: true };
    },
    async unsubscribe(id, at) {
      if (opts.failStore) return null;
      const r = rows.get(id);
      if (!r || r.unsubscribed_at) return { updated: false };
      r.unsubscribed_at = at; r.updated_at = at; writes.push("unsubscribe"); return { updated: true };
    },
  };
  const handle = createHandler({
    env: (k) => ENV[k] ?? "", store,
    sendEmail: async (to, subject, html) => { sent.push({ to, subject, html }); },
    verifyCaptcha: async () => ({ ok: true, success: true, hostname: "turnlineops.com" }),
    now: () => clock, randomToken: () => "a".repeat(36) + "b".repeat(36),
  });
  const post = (body: unknown, origin = ORIGIN) => handle(new Request(FN, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) }));
  const get = (qs: string) => handle(new Request(FN + qs, { method: "GET" }));
  return { rows, sent, writes, handle, post, get, advance: (ms: number) => (clock += ms) };
}
const signup = { email: "Pilot@Example.com", consent: true, captcha: "stub", source: "turnline_waitlist", utm_source: "x", utm_medium: "", utm_campaign: "" };
const TOKEN = "a".repeat(36) + "b".repeat(36);

test("signup sends links to the website pages with id and token only in the fragment", async () => {
  const t = setup();
  const r = await t.post(signup);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.equal(t.sent.length, 1);
  const unsub = await hmac(SECRET, "unsubscribe:" + ID);
  assert.ok(t.sent[0]!.html.includes(`href="${ORIGIN}/confirm#id=${ID}&amp;token=${TOKEN}"`));
  assert.ok(t.sent[0]!.html.includes(`href="${ORIGIN}/unsubscribe#id=${ID}&amp;token=${unsub}"`));
  assert.ok(!t.sent[0]!.html.includes("functions/v1"), "no links to the function domain");
  assert.ok(!t.sent[0]!.html.includes("?"), "no query strings (tokens never in a request URL)");
  const row = t.rows.get(ID)!;
  assert.equal(row.verification_hash, await sha(TOKEN));
  assert.equal(row.confirmed_at, null);
  assert.equal(row.verification_expires_at, "2026-10-19T12:00:00.000Z"); // 48 h, unchanged
});

test("GET never changes data: legacy email links redirect to the website with the values in the fragment", async () => {
  const t = setup();
  await t.post(signup);
  const unsub = await hmac(SECRET, "unsubscribe:" + ID);
  const c = await t.get(`?action=confirm&id=${ID}&token=${TOKEN}`);
  assert.equal(c.status, 303);
  assert.equal(c.headers.get("location"), pageLink(ORIGIN, "confirm", ID, TOKEN));
  assert.equal(c.headers.get("referrer-policy"), "no-referrer");
  const u = await t.get(`?action=unsubscribe&id=${ID}&token=${unsub}`);
  assert.equal(u.headers.get("location"), `${ORIGIN}/unsubscribe#id=${ID}&token=${unsub}`);
  assert.deepEqual(t.writes, ["insert"], "a GET (e.g. a mail scanner prefetch) wrote nothing");
  assert.equal(t.rows.get(ID)!.confirmed_at, null);
  assert.equal(t.rows.get(ID)!.unsubscribed_at, null);
  // Malformed legacy links land on the page without values, which explains the problem.
  assert.equal((await t.get(`?action=confirm&id=nope&token=${TOKEN}`)).headers.get("location"), `${ORIGIN}/confirm`);
  assert.equal((await t.get(`?action=unsubscribe&id=${ID}&token=zz`)).headers.get("location"), `${ORIGIN}/unsubscribe`);
  // Never HTML from the function.
  for (const r of [c, u]) assert.ok(!(r.headers.get("content-type") ?? "").includes("html"));
  assert.equal((await t.get("")).status, 405);
});

test("explicit POST confirms; repeating it is reported as already confirmed", async () => {
  const t = setup();
  await t.post(signup);
  const r = await t.post({ action: "confirm", id: ID, token: TOKEN });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { status: "confirmed" });
  assert.equal(r.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.ok(t.rows.get(ID)!.confirmed_at);
  const again = await t.post({ action: "confirm", id: ID, token: TOKEN });
  assert.deepEqual([again.status, await again.json()], [200, { status: "already_confirmed" }]);
  assert.equal(t.writes.filter((w) => w === "confirm").length, 1);
});

test("expired, wrong, malformed and unsubscribed confirmations get one generic error and change nothing", async () => {
  const t = setup();
  await t.post(signup);
  const bad = async (body: unknown) => {
    const r = await t.post(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.deepEqual(await r.json(), { error: "invalid_or_expired" });
  };
  await bad({ action: "confirm", id: ID, token: "c".repeat(72) }); // wrong token
  await bad({ action: "confirm", id: ID, token: "short" });
  await bad({ action: "confirm", id: ID, token: "<script>".repeat(10) });
  await bad({ action: "confirm", id: "not-an-id", token: TOKEN });
  await bad({ action: "confirm", id: "11111111-1111-4111-8111-111111111111", token: TOKEN }); // unknown id: same error
  await bad({ action: "confirm", id: ID });
  t.advance(49 * 3600_000);
  await bad({ action: "confirm", id: ID, token: TOKEN }); // expired
  assert.equal(t.rows.get(ID)!.confirmed_at, null);
});

test("a wrong token on a confirmed record does not reveal that it is confirmed", async () => {
  const t = setup();
  await t.post(signup);
  await t.post({ action: "confirm", id: ID, token: TOKEN });
  const r = await t.post({ action: "confirm", id: ID, token: "d".repeat(72) });
  assert.deepEqual([r.status, await r.json()], [400, { error: "invalid_or_expired" }]);
});

test("explicit POST unsubscribes; repeating it is idempotent; a bad signature is rejected", async () => {
  const t = setup();
  await t.post(signup);
  await t.post({ action: "confirm", id: ID, token: TOKEN });
  const token = await hmac(SECRET, "unsubscribe:" + ID);
  const r = await t.post({ action: "unsubscribe", id: ID, token });
  assert.deepEqual([r.status, await r.json()], [200, { status: "unsubscribed" }]);
  const first = t.rows.get(ID)!.unsubscribed_at;
  assert.ok(first);
  t.advance(60_000);
  const again = await t.post({ action: "unsubscribe", id: ID, token });
  assert.deepEqual([again.status, await again.json()], [200, { status: "unsubscribed" }]);
  assert.equal(t.rows.get(ID)!.unsubscribed_at, first, "the original unsubscribe time is kept");
  const forged = await t.post({ action: "unsubscribe", id: ID, token: "0".repeat(64) });
  assert.deepEqual([forged.status, await forged.json()], [400, { error: "invalid_or_expired" }]);
  // An unsubscribed address cannot be confirmed with its old link.
  const c = await t.post({ action: "confirm", id: ID, token: TOKEN });
  assert.equal(c.status, 400);
  // Suppression: signing up again needs a new opt-in and a new confirmation.
  t.advance(120_000);
  await t.post(signup);
  assert.equal(t.rows.get(ID)!.confirmed_at, null);
  assert.equal(t.sent.length, 2);
});

test("confirm and unsubscribe POSTs require the Turnline origin, valid JSON and a known action", async () => {
  const t = setup();
  await t.post(signup);
  const foreign = await t.post({ action: "confirm", id: ID, token: TOKEN }, "https://evil.example");
  assert.equal(foreign.status, 403);
  assert.equal(t.rows.get(ID)!.confirmed_at, null);
  assert.equal((await t.post({ action: "delete", id: ID, token: TOKEN })).status, 400);
  const opt = await t.handle(new Request(FN, { method: "OPTIONS", headers: { origin: ORIGIN } }));
  assert.equal(opt.status, 204);
  assert.equal(opt.headers.get("access-control-allow-origin"), ORIGIN);
  assert.match(opt.headers.get("access-control-allow-methods") ?? "", /POST/);
  const raw = await t.handle(new Request(FN, { method: "POST", headers: { origin: ORIGIN }, body: "{not json" }));
  assert.equal(raw.status, 400);
});

test("verification is rate limited and storage failures are reported, not hidden", async () => {
  const limited = setup({ limitOk: false });
  assert.equal((await limited.post({ action: "confirm", id: ID, token: TOKEN })).status, 429);
  const broken = setup({ failStore: true });
  const r = await broken.post({ action: "confirm", id: ID, token: TOKEN });
  assert.deepEqual([r.status, await r.json()], [503, { error: "temporarily_unavailable" }]);
  const u = await broken.post({ action: "unsubscribe", id: ID, token: await hmac(SECRET, "unsubscribe:" + ID) });
  assert.equal(u.status, 503);
});

test("signup contract unchanged: validation, origin, captcha hostname, no enumeration of confirmed addresses", async () => {
  const t = setup();
  assert.equal((await t.post({ ...signup, consent: false })).status, 400);
  assert.equal((await t.post({ ...signup, email: "nope" })).status, 400);
  assert.equal((await t.post(signup, "https://evil.example")).status, 403);
  await t.post(signup);
  await t.post({ action: "confirm", id: ID, token: TOKEN });
  t.advance(120_000);
  const again = await t.post(signup);
  assert.deepEqual([again.status, await again.json()], [200, { ok: true }]);
  assert.equal(t.sent.length, 1, "a confirmed address is not re-mailed, and the response is identical");
});

test("unconfigured function refuses everything", async () => {
  const handle = createHandler({ env: () => "", store: {} as WaitlistStore, sendEmail: async () => {}, verifyCaptcha: async () => ({ ok: true }) });
  assert.equal((await handle(new Request(FN + `?action=confirm&id=${ID}&token=${TOKEN}`))).status, 503);
});
