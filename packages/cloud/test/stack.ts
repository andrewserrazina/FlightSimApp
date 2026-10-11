import { createHmac, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

/** Local test stack (infra/supabase-local). These are local-only, disposable values. */
export const URL_ = process.env.SUPABASE_TEST_URL ?? "http://127.0.0.1:54321";
export const MAILPIT = process.env.SUPABASE_TEST_MAILPIT ?? "http://127.0.0.1:54327";
const SECRET = process.env.SB_LOCAL_JWT_SECRET ?? "local-only-flightsimapp-test-jwt-secret-0123456789abcdef";
export const DB_URL = process.env.SUPABASE_TEST_DB_URL ?? "postgres://postgres:local-only-postgres-password@127.0.0.1:54322/postgres";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
export function signJwt(payload: Record<string, unknown>, secret = SECRET): string {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64(payload);
  return `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
}
export const ANON_KEY = signJwt({ iss: "supabase-local", role: "anon", iat: 1_700_000_000, exp: 2_000_000_000 });

/** Fail loudly (never silently skip) if the stack is not running. */
export async function requireStack(): Promise<void> {
  try {
    const r = await fetch(`${URL_}/auth/v1/health`, { headers: { apikey: ANON_KEY } });
    if (!r.ok) throw new Error(`health ${r.status}`);
  } catch (e) {
    throw new Error(`Local Supabase test stack is not reachable at ${URL_} (${String(e)}). Start it with infra/supabase-local/up.sh.`);
  }
}

export function client(accessToken?: string): SupabaseClient {
  return createClient(URL_, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {}),
  });
}

export const uniqueEmail = (tag: string) => `${tag}-${Date.now()}-${randomUUID().slice(0, 6)}@example.test`;

/** Latest 6-digit code mailed to `email` (Mailpit API). */
export async function mailedCode(email: string, subjectIncludes: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
    const d = (await r.json()) as { messages: Array<{ ID: string; Subject: string; Snippet: string }> };
    const m = d.messages.find((x) => x.Subject.includes(subjectIncludes));
    if (m) {
      const code = /\b(\d{6})\b/.exec(m.Snippet)?.[1];
      if (code) return code;
    }
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(`No "${subjectIncludes}" email with a code for ${email}`);
}

export async function deleteMail(email: string) {
  await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`, { method: "DELETE" });
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
  db: SupabaseClient;
}

/** Register through GoTrue, verify with the emailed OTP, and return a signed-in client. */
export async function createVerifiedUser(tag: string): Promise<TestUser> {
  const email = uniqueEmail(tag);
  const password = `pw-${randomUUID()}`;
  const c = client();
  const { error } = await c.auth.signUp({ email, password });
  if (error) throw error;
  const code = await mailedCode(email, "verification");
  const { data, error: vErr } = await c.auth.verifyOtp({ email, token: code, type: "signup" });
  if (vErr || !data.session || !data.user) throw vErr ?? new Error("no session after verification");
  return { id: data.user.id, email, password, accessToken: data.session.access_token, refreshToken: data.session.refresh_token, db: client(data.session.access_token) };
}

export async function sql<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  try {
    return (await c.query<T>(text, params)).rows;
  } finally {
    await c.end();
  }
}

/** A plausible completed-flight payload owned by nobody in particular (the RPC assigns the owner). */
export function samplePayload(overrides: { id?: string; eventIds?: string[] } = {}) {
  const id = overrides.id ?? randomUUID();
  const ids = overrides.eventIds ?? [randomUUID(), randomUUID(), randomUUID()];
  return {
    flight: {
      id,
      status: "completed",
      completion: "arrival_confirmed",
      simulator: "mock",
      simulator_version: "mock-1",
      aircraft_title: "Mock Twinjet (demo data)",
      aircraft_icao: "A20N",
      origin_icao: null,
      destination_icao: null,
      started_at_utc: "2026-10-11T18:25:46.928Z",
      ended_at_utc: "2026-10-11T18:41:09.433Z",
      takeoff_at_utc: "2026-10-11T18:27:20.573Z",
      landing_at_utc: "2026-10-11T18:38:38.793Z",
      airborne_seconds: 629,
      started_airborne: false,
      client_schema_version: 1,
    },
    events: ids.map((eventId, i) => ({
      event_id: eventId,
      seq: i + 1,
      kind: i === 0 ? "flight.started" : i === ids.length - 1 ? "flight.completed" : "phase.changed",
      occurred_at_utc: new Date(Date.parse("2026-10-11T18:25:46.928Z") + i * 60_000).toISOString(),
      source: i === 1 ? "detected" : "user",
      from_phase: null,
      to_phase: "PREPARING",
      details: {},
    })),
    interruptions: [{ started_at_utc: "2026-10-11T18:32:35.961Z", ended_at_utc: "2026-10-11T18:33:24.959Z", cause: "app_closed", resolution: "user_resumed" }],
  };
}

export async function rpcSync(db: SupabaseClient, payload: ReturnType<typeof samplePayload>) {
  return db.rpc("sync_completed_flight", { p_flight: payload.flight, p_events: payload.events, p_interruptions: payload.interruptions });
}
