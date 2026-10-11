/**
 * Security integration tests against the REAL local Supabase stack (GoTrue-issued JWTs, PostgREST,
 * Postgres RLS policies from db/migrations). No access-control logic is mocked here.
 * Requires infra/supabase-local/up.sh. Fails (does not skip) when the stack is unavailable.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { ANON_KEY, client, createVerifiedUser, requireStack, rpcSync, samplePayload, signJwt, sql, URL_, type TestUser } from "./stack";

let A: TestUser;
let B: TestUser;
let flightA: ReturnType<typeof samplePayload>;

beforeAll(async () => {
  await requireStack();
  [A, B] = await Promise.all([createVerifiedUser("pilot-a"), createVerifiedUser("pilot-b")]);
  flightA = samplePayload();
  const { data, error } = await rpcSync(A.db, flightA);
  expect(error).toBeNull();
  expect(data).toMatchObject({ flight_id: flightA.flight.id, created: true, event_count: 3, interruption_count: 1 });
}, 60_000);

describe("isolation between users", () => {
  it("user B cannot read user A's flights, events or interruptions", async () => {
    const own = await A.db.from("flights").select("id").eq("id", flightA.flight.id);
    expect(own.data).toHaveLength(1);
    const flights = await B.db.from("flights").select("id");
    expect(flights.error).toBeNull();
    expect(flights.data).toEqual([]);
    const byId = await B.db.from("flights").select("*").eq("id", flightA.flight.id);
    expect(byId.data).toEqual([]);
    const events = await B.db.from("flight_events").select("id").eq("flight_id", flightA.flight.id);
    expect(events.data).toEqual([]);
    const intr = await B.db.from("flight_interruptions").select("flight_id").eq("flight_id", flightA.flight.id);
    expect(intr.data).toEqual([]);
    const status = await B.db.from("flight_sync_status").select("*").eq("flight_id", flightA.flight.id);
    expect(status.data).toEqual([]);
  });

  it("user B cannot modify or delete user A's flight", async () => {
    const upd = await B.db.from("flights").update({ status: "aborted" }).eq("id", flightA.flight.id).select();
    expect(upd.data ?? []).toEqual([]);
    const del = await B.db.from("flights").delete().eq("id", flightA.flight.id).select();
    expect(del.data ?? []).toEqual([]);
    const still = await A.db.from("flights").select("status").eq("id", flightA.flight.id).single();
    expect(still.data?.status).toBe("completed");
  });

  it("user B cannot create records owned by user A (owner spoofing)", async () => {
    const direct = await B.db.from("flights").insert({ id: randomUUID(), pilot_user_id: A.id, status: "planned" });
    expect(direct.error?.code).toBe("42501");
    // Through the RPC the owner is always the caller, whatever the payload says.
    const p = samplePayload();
    (p.flight as Record<string, unknown>).pilot_user_id = A.id;
    const { error } = await rpcSync(B.db, p);
    expect(error).toBeNull();
    const rows = await sql<{ pilot_user_id: string }>("select pilot_user_id from public.flights where id = $1", [p.flight.id]);
    expect(rows[0]?.pilot_user_id).toBe(B.id);
  });

  it("event insertion requires owning the parent flight (no FK path into another user's flight)", async () => {
    const ev = await B.db.from("flight_events").insert({
      id: randomUUID(), flight_id: flightA.flight.id, event_type: "phase.changed", schema_version: 1,
      occurred_at: new Date().toISOString(), source: "attacker", source_kind: "user",
    });
    expect(ev.error?.code).toBe("42501");
    const intr = await B.db.from("flight_interruptions").insert({ flight_id: flightA.flight.id, started_at: new Date().toISOString(), cause: "app_closed" });
    expect(intr.error?.code).toBe("42501");
    const count = await sql<{ n: string }>("select count(*) as n from public.flight_events where flight_id = $1", [flightA.flight.id]);
    expect(Number(count[0]!.n)).toBe(3);
  });

  it("re-using another user's flight id through the sync RPC is refused without leaking it", async () => {
    const hijack = samplePayload({ id: flightA.flight.id });
    const { error } = await rpcSync(B.db, hijack);
    expect(error?.code).toBe("42501");
    expect(error?.message).toBe("flight id is not available");
    const count = await sql<{ n: string }>("select count(*) as n from public.flight_events where flight_id = $1", [flightA.flight.id]);
    expect(Number(count[0]!.n)).toBe(3);
  });

  it("re-using another user's event ids cannot attach or alter their events", async () => {
    const own = samplePayload({ eventIds: flightA.events.map((e) => e.event_id) });
    const { data } = await rpcSync(B.db, own);
    expect(data).toMatchObject({ event_count: 0 }); // conflicts ignored → verification would fail on the client
    const rows = await sql<{ flight_id: string }>("select distinct flight_id from public.flight_events where id = any($1::uuid[])", [flightA.events.map((e) => e.event_id)]);
    expect(rows.map((r) => r.flight_id)).toEqual([flightA.flight.id]);
  });

  it("profiles are created server-side and private to their owner", async () => {
    const own = await A.db.from("profiles").select("user_id");
    expect(own.data).toEqual([{ user_id: A.id }]);
    const other = await B.db.from("profiles").select("user_id").eq("user_id", A.id);
    expect(other.data).toEqual([]);
    const spoof = await B.db.from("profiles").insert({ user_id: A.id });
    expect(spoof.error).not.toBeNull();
  });

  it("billing records cannot be written by clients and entitlements are read-only", async () => {
    const ins = await A.db.from("subscriptions").insert({ user_id: A.id, provider_subscription_id: "fake", plan_code: "pro", status: "active" });
    expect(ins.error?.code).toBe("42501");
    const ent = await A.db.from("my_entitlements").select("*");
    expect(ent.data).toEqual([]);
  });
});

describe("anonymous and invalid credentials", () => {
  it("anonymous clients cannot access private records or call the sync RPC", async () => {
    const anon = client();
    for (const table of ["flights", "flight_events", "flight_interruptions", "profiles", "subscriptions", "flight_sync_status"]) {
      const r = await anon.from(table).select("*").limit(1);
      expect(r.data ?? [], table).toEqual([]);
      expect(r.error?.code, table).toBe("42501");
    }
    const { error } = await rpcSync(anon, samplePayload());
    expect(error?.code).toBe("42501");
  });

  it("rejects a token signed with the wrong secret", async () => {
    const forged = signJwt({ sub: A.id, role: "authenticated", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 }, "not-the-real-secret-not-the-real-secret!!");
    const r = await fetch(`${URL_}/rest/v1/flights?select=id`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${forged}` } });
    expect(r.status).toBe(401);
  });

  it("rejects garbage tokens", async () => {
    const r = await fetch(`${URL_}/rest/v1/flights?select=id`, { headers: { apikey: ANON_KEY, Authorization: "Bearer not-a-jwt" } });
    expect(r.status).toBe(401);
  });

  it("rejects an expired session token", async () => {
    const expired = signJwt({ sub: A.id, role: "authenticated", aud: "authenticated", exp: Math.floor(Date.now() / 1000) - 60 });
    const r = await fetch(`${URL_}/rest/v1/flights?select=id`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${expired}` } });
    expect(r.status).toBe(401);
    expect(((await r.json()) as { code: string }).code).toBe("PGRST301");
    const rpc = await rpcSync(client(expired), samplePayload());
    expect(rpc.error?.code).toBe("PGRST301");
  });
});

describe("sync semantics", () => {
  it("duplicate sync requests do not duplicate records", async () => {
    const p = samplePayload();
    const first = await rpcSync(A.db, p);
    const second = await rpcSync(A.db, p);
    expect(first.data).toMatchObject({ created: true, event_count: 3 });
    expect(second.data).toMatchObject({ created: false, event_count: 3, interruption_count: 1 });
    const n = await sql<{ f: string; e: string }>("select (select count(*) from public.flights where id = $1) as f, (select count(*) from public.flight_events where flight_id = $1) as e", [p.flight.id]);
    expect(n[0]).toEqual({ f: "1", e: "3" });
  });

  it("recovers a partial upload: re-sending the full payload completes it without duplicates", async () => {
    const p = samplePayload({ eventIds: [randomUUID(), randomUUID(), randomUUID(), randomUUID()] });
    const partial = { ...p, events: p.events.slice(0, 2), interruptions: [] };
    expect((await rpcSync(A.db, partial)).data).toMatchObject({ event_count: 2, interruption_count: 0 });
    expect((await rpcSync(A.db, p)).data).toMatchObject({ event_count: 4, interruption_count: 1 });
  });

  it("preserves UUIDs and UTC timestamps exactly", async () => {
    const p = samplePayload();
    await rpcSync(A.db, p);
    const f = await A.db.from("flights").select("id,started_at_utc,ended_at_utc,source,pilot_user_id").eq("id", p.flight.id).single();
    expect(f.data).toMatchObject({ id: p.flight.id, source: "desktop_recorder", pilot_user_id: A.id });
    expect(new Date(f.data!.started_at_utc).toISOString()).toBe(p.flight.started_at_utc);
    const e = await A.db.from("flight_events").select("id,flight_seq,occurred_at,lifecycle_source").eq("flight_id", p.flight.id).order("flight_seq");
    expect(e.data!.map((x) => x.id)).toEqual(p.events.map((x) => x.event_id));
    expect(new Date(e.data![1]!.occurred_at).toISOString()).toBe(p.events[1]!.occurred_at_utc);
    expect(e.data![1]!.lifecycle_source).toBe("detected");
  });

  it("completed flights are immutable for their owner too", async () => {
    const upd = await A.db.from("flights").update({ status: "aborted" }).eq("id", flightA.flight.id).select();
    expect(upd.data ?? []).toEqual([]);
    const evUpd = await A.db.from("flight_events").update({ event_type: "tampered" }).eq("flight_id", flightA.flight.id).select();
    expect(evUpd.error?.code).toBe("42501");
    const evDel = await A.db.from("flight_events").delete().eq("flight_id", flightA.flight.id).select();
    expect(evDel.error?.code).toBe("42501");
  });

  it("ownership cannot be transferred even on an open flight", async () => {
    const id = randomUUID();
    expect((await A.db.from("flights").insert({ id, pilot_user_id: A.id, status: "planned" })).error).toBeNull();
    const move = await A.db.from("flights").update({ pilot_user_id: B.id }).eq("id", id);
    expect(move.error?.code).toBe("42501"); // column not updatable by clients
    const ok = await A.db.from("flights").update({ status: "preparing" }).eq("id", id).select("status");
    expect(ok.data).toEqual([{ status: "preparing" }]);
  });

  it("invalid payloads fail atomically: nothing is partially written", async () => {
    const notCompleted = samplePayload();
    notCompleted.flight.status = "active";
    expect((await rpcSync(A.db, notCompleted)).error?.code).toBe("22023");
    const badEvent = samplePayload();
    badEvent.events[2]!.occurred_at_utc = "not a time";
    expect((await rpcSync(A.db, badEvent)).error).not.toBeNull();
    const rows = await sql("select 1 from public.flights where id = any($1::uuid[])", [[notCompleted.flight.id, badEvent.flight.id]]);
    expect(rows).toEqual([]);
  });

  it("owners can delete their own flight (data deletion), cascading to events", async () => {
    const p = samplePayload();
    await rpcSync(A.db, p);
    const del = await A.db.from("flights").delete().eq("id", p.flight.id).select("id");
    expect(del.data).toEqual([{ id: p.flight.id }]);
    const left = await sql("select 1 from public.flight_events where flight_id = $1", [p.flight.id]);
    expect(left).toEqual([]);
  });
});

describe("catalog-level guarantees", () => {
  it("every table in the public schema has row-level security enabled", async () => {
    const rows = await sql<{ relname: string }>("select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity");
    expect(rows).toEqual([]);
  });

  it("every RLS-protected user table has explicit policies; private tables grant nothing to anon", async () => {
    const policies = await sql<{ tablename: string; cmd: string }>("select tablename, cmd from pg_policies where schemaname = 'public'");
    const by = (t: string) => policies.filter((p) => p.tablename === t).map((p) => p.cmd).sort();
    expect(by("flights")).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
    expect(by("flight_events")).toEqual(["INSERT", "SELECT"]);
    expect(by("flight_interruptions")).toEqual(["INSERT", "SELECT"]);
    const anonGrants = await sql("select table_name, privilege_type from information_schema.role_table_grants where grantee = 'anon' and table_schema = 'public' and table_name in ('flights','flight_events','flight_interruptions','profiles','subscriptions','billing_customers')");
    expect(anonGrants).toEqual([]);
  });

  it("no SECURITY DEFINER function in public is executable by clients", async () => {
    const rows = await sql<{ proname: string }>(
      "select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))",
    );
    expect(rows).toEqual([]);
  });
});
