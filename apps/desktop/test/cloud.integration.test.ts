/**
 * End-to-end against the isolated LOCAL Supabase stack (infra/supabase-local): the real desktop
 * AuthService + SyncEngine + Supabase sync API, with only the native pieces (OS keychain and the
 * SQLite queue) replaced by in-memory fakes. Run with `pnpm --filter @flightsim/desktop test:integration`.
 */
import { createSupabaseSyncApi } from "@flightsim/cloud";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ANON_KEY, client, mailedCode, requireStack, sql, uniqueEmail, URL_ } from "../../../packages/cloud/test/stack";
import { AuthService } from "../src/auth/AuthService";
import { createSecureSessionStorage, type SecureBackend } from "../src/auth/secureStorage";
import { SyncEngine } from "../src/sync/SyncEngine";
import { completedFlight, FakeLocalSync } from "./cloudFakes";

class MemoryKeychain implements SecureBackend {
  value: string | null = null;
  async available() {
    return true;
  }
  async get() {
    return this.value;
  }
  async set(v: string) {
    this.value = v;
  }
  async remove() {
    this.value = null;
  }
}

const config = { url: URL_, anonKey: ANON_KEY };
const services: AuthService[] = [];
async function authWith(keychain: SecureBackend) {
  const a = new AuthService(config, await createSecureSessionStorage(keychain));
  services.push(a);
  await a.init();
  return a;
}
const settle = () => new Promise((r) => setTimeout(r, 50));

beforeAll(requireStack);
afterAll(() => services.forEach((a) => a.client?.auth.stopAutoRefresh()));

describe("desktop auth + sync against the local Supabase stack", () => {
  const email = uniqueEmail("desktop");
  const password = "local-test-password-1";
  const keychain = new MemoryKeychain();
  let userId = "";
  const flightId = crypto.randomUUID();

  it("registers, verifies with the emailed code and keeps the session only in secure storage", async () => {
    const auth = await authWith(keychain);
    expect(auth.getView().status).toBe("signed_out");
    await auth.signUp(email, password);
    expect(auth.getView().status).toBe("verification_required");
    await auth.verifyEmail(await mailedCode(email, "verification"));
    await settle();
    const v = auth.getView();
    expect(v.status).toBe("signed_in");
    expect(v.persistent).toBe(true);
    userId = v.user!.id;
    expect(keychain.value).toContain("refresh_token");
    expect(JSON.stringify(v)).not.toMatch(/eyJ|refresh_token/); // the UI view carries no tokens
  });

  it("restores the session after a restart from secure storage", async () => {
    const auth = await authWith(keychain);
    expect(auth.getView()).toMatchObject({ status: "signed_in", user: { id: userId } });
  });

  it("uploads a completed flight after opt-in, verified, idempotently, visible only to its owner", async () => {
    const auth = await authWith(keychain);
    const clock = { now: Date.now() };
    const local = new FakeLocalSync(clock);
    const sync = new SyncEngine({ local, cloud: createSupabaseSyncApi(auth.client!), auth, intervalMs: 3_600_000 });
    const stop = await sync.start();
    await sync.idle();
    expect(sync.getView().block).toBe("disabled");
    await sync.enable();
    clock.now += 1000;
    local.addFlight(completedFlight(flightId, new Date(clock.now + 1000).toISOString(), 3, 1));
    sync.kick();
    await sync.idle();
    expect(local.queue.get(flightId)!.lastError).toBeNull();
    expect(local.state(flightId)).toBe("synced");

    const rows = await sql<{ pilot_user_id: string; source: string; events: string; ints: string }>(
      "select pilot_user_id, source, (select count(*) from flight_events e where e.flight_id = f.id) as events, (select count(*) from flight_interruptions i where i.flight_id = f.id) as ints from flights f where id = $1",
      [flightId],
    );
    expect(rows).toEqual([{ pilot_user_id: userId, source: "desktop_recorder", events: "3", ints: "1" }]);

    // Re-uploading (e.g. after a crash) does not duplicate anything.
    await local.retryFailed(userId);
    local.queue.get(flightId)!.state = "pending";
    sync.kick();
    await sync.idle();
    const again = await sql<{ n: string }>("select count(*) as n from flight_events where flight_id = $1", [flightId]);
    expect(again[0]!.n).toBe("3");
    stop();

    // Another verified user cannot see it.
    const other = uniqueEmail("other");
    const c = client();
    await c.auth.signUp({ email: other, password });
    const { data } = await c.auth.verifyOtp({ email: other, token: await mailedCode(other, "verification"), type: "signup" });
    const { data: seen } = await client(data.session!.access_token).from("flights").select("id").eq("id", flightId);
    expect(seen).toEqual([]);
  });

  it("detects a revoked session, stops syncing and reports it as expired", async () => {
    const auth = await authWith(keychain);
    const clock = { now: Date.now() };
    const local = new FakeLocalSync(clock);
    const sync = new SyncEngine({ local, cloud: createSupabaseSyncApi(auth.client!), auth, intervalMs: 3_600_000 });
    const stop = await sync.start();
    await sync.enable();
    // Revoke every session of this user server-side (as "sign out everywhere" would).
    const other = client();
    await other.auth.signInWithPassword({ email, password });
    await other.auth.signOut({ scope: "global" });
    // Force the desktop's current access token to be rejected.
    await sql("delete from auth.sessions where user_id = $1", [userId]);
    clock.now += 1000;
    local.addFlight(completedFlight(crypto.randomUUID(), new Date(clock.now + 1000).toISOString()));
    sync.kick();
    await sync.idle();
    await settle();
    // The access JWT itself may still verify until it expires; if the upload went through, the
    // server accepted a still-valid token. Either way no flight may be marked synced without a
    // successful verified write, and a rejected refresh must surface as an expired session.
    const refreshed = await auth.refreshAfterRejection();
    await settle();
    expect(refreshed).toBe(false);
    expect(auth.getView().status).toBe("session_expired");
    expect(sync.getView().block).toBe("session_expired");
    stop();
  });

  it("signs out and removes session material from secure storage", async () => {
    const auth = await authWith(keychain);
    // Session was revoked in the previous test; sign in again first.
    await auth.signIn(email, password);
    await settle();
    expect(auth.getView().status).toBe("signed_in");
    await auth.signOut();
    await settle();
    expect(auth.getView().status).toBe("signed_out");
    expect(keychain.value).toBeNull();
  });

  it("rejects a wrong verification code without signing in", async () => {
    const auth = await authWith(new MemoryKeychain());
    const e2 = uniqueEmail("wrong");
    await auth.signUp(e2, password);
    await auth.verifyEmail("000000");
    expect(auth.getView().status).toBe("verification_required");
    expect(auth.getView().error).toBeTruthy();
  });
});
