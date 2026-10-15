import { MAX_SYNC_ATTEMPTS } from "@flightsim/cloud";
import { afterEach, describe, expect, it } from "vitest";
import { SyncEngine } from "../src/sync/SyncEngine";
import { ACCT_A, ACCT_B, completedFlight, FakeAuth, FakeCloud, FakeLocalSync } from "./cloudFakes";

const T0 = Date.parse("2026-10-11T12:00:00.000Z");
const later = (min: number) => new Date(T0 + min * 60_000).toISOString();
const earlier = (min: number) => new Date(T0 - min * 60_000).toISOString();

let stops: Array<() => void> = [];
afterEach(() => {
  stops.forEach((s) => s());
  stops = [];
});

function setup() {
  const clock = { now: T0 };
  const local = new FakeLocalSync(clock);
  const auth = new FakeAuth();
  const cloud = new FakeCloud(() => auth.view.user?.id ?? null);
  const make = () => new SyncEngine({ local, cloud, auth, now: () => clock.now, random: () => 0.5, intervalMs: 3_600_000 });
  const engine = make();
  const start = async (e = engine) => {
    stops.push(await e.start());
    await e.idle();
    return e;
  };
  return { clock, local, auth, cloud, engine, make, start };
}

describe("SyncEngine — consent and opt-in", () => {
  it("is disabled by default: nothing is uploaded even when signed in", async () => {
    const { local, auth, cloud, engine, start } = setup();
    local.addFlight(completedFlight("f1", later(1)));
    auth.signIn(ACCT_A);
    await start();
    expect(engine.getView().block).toBe("disabled");
    expect(cloud.calls).toBe(0);
    expect(local.state("f1")).toBe("local_only");
  });

  it("requires sign-in to opt in", async () => {
    const { engine, start } = setup();
    await start();
    await expect(engine.enable()).rejects.toThrow(/Sign in/);
  });

  it("uploads only flights completed after opt-in; earlier flights need explicit backfill", async () => {
    const { clock, local, auth, cloud, engine, start } = setup();
    local.addFlight(completedFlight("old", earlier(30)));
    auth.signIn(ACCT_A);
    await start();
    await engine.enable();
    clock.now += 60_000;
    local.addFlight(completedFlight("new", later(1), 3, 1));
    engine.notifyFlightClosed();
    await new Promise((r) => setTimeout(r, 0));
    await engine.idle();
    expect(local.state("new")).toBe("synced");
    expect(local.state("old")).toBe("local_only");
    expect([...cloud.rows.keys()]).toEqual(["new"]);
    expect(cloud.rows.get("new")!.owner).toBe(ACCT_A);
    expect(engine.getView().overview).toMatchObject({ synced: 1, localOnlyCompleted: 1 });

    expect(await engine.backfillEarlierFlights()).toBe(1);
    await engine.idle();
    expect(local.state("old")).toBe("synced");
    expect(local.queue.get("old")!.consent).toBe("explicit_backfill");
  });

  it("does not upload open, aborted or discarded flights", async () => {
    const { clock, local, auth, cloud, engine, start } = setup();
    auth.signIn(ACCT_A);
    await start();
    await engine.enable();
    clock.now += 1000;
    local.addFlight(completedFlight("ab", later(1), 1, 0, "aborted"));
    local.addFlight(completedFlight("op", later(1), 1, 0, "active"));
    engine.kick();
    await engine.idle();
    expect(cloud.calls).toBe(0);
  });

  it("re-enabling after a pause does not upload flights completed while sync was off", async () => {
    const { clock, local, auth, cloud, engine, start } = setup();
    auth.signIn(ACCT_A);
    await start();
    await engine.enable();
    await engine.disable();
    clock.now += 60_000;
    local.addFlight(completedFlight("while-off", new Date(clock.now).toISOString()));
    clock.now += 60_000;
    await engine.enable();
    await engine.idle();
    expect(cloud.calls).toBe(0);
    expect(local.state("while-off")).toBe("local_only");
  });
});

describe("SyncEngine — accounts", () => {
  it("waits while signed out and resumes on sign-in, keeping local data", async () => {
    const { clock, local, auth, cloud, engine, start } = setup();
    auth.signIn(ACCT_A);
    await start();
    await engine.enable();
    auth.set({ status: "signed_out", user: null });
    clock.now += 1000;
    local.addFlight(completedFlight("f1", later(1)));
    engine.kick();
    await engine.idle();
    expect(engine.getView().block).toBe("signed_out");
    expect(local.state("f1")).toBe("pending");
    expect(cloud.calls).toBe(0);
    auth.signIn(ACCT_A);
    await engine.idle();
    expect(local.state("f1")).toBe("synced");
  });

  it("never transfers flights to another account that signs in on the same computer", async () => {
    const { clock, local, auth, cloud, engine, start } = setup();
    auth.signIn(ACCT_A);
    await start();
    await engine.enable();
    auth.set({ status: "signed_out", user: null });
    clock.now += 1000;
    local.addFlight(completedFlight("fa", later(1)));
    engine.kick();
    await engine.idle();
    expect(local.queue.get("fa")!.accountId).toBe(ACCT_A);

    auth.signIn(ACCT_B);
    await engine.idle();
    expect(engine.getView().block).toBe("other_account");
    expect(cloud.calls).toBe(0);

    // B explicitly enables sync for B: A's queued flight stays A's and is not uploaded to B.
    await engine.enable();
    await engine.idle();
    expect(cloud.calls).toBe(0);
    expect(local.queue.get("fa")!.accountId).toBe(ACCT_A);
    expect(engine.getView().overview!.otherAccount).toBe(1);
    expect(await engine.backfillEarlierFlights()).toBe(0);

    clock.now += 1000;
    local.addFlight(completedFlight("fb", later(2)));
    engine.notifyFlightClosed();
    await new Promise((r) => setTimeout(r, 0));
    await engine.idle();
    expect(cloud.rows.get("fb")!.owner).toBe(ACCT_B);
    expect(cloud.rows.has("fa")).toBe(false);
  });
});

describe("SyncEngine — failures and recovery", () => {
  async function queued() {
    const ctx = setup();
    ctx.auth.signIn(ACCT_A);
    await ctx.start();
    await ctx.engine.enable();
    ctx.clock.now += 1000;
    ctx.local.addFlight(completedFlight("f1", later(1), 2, 1));
    return ctx;
  }

  it("backs off on transient errors and succeeds later", async () => {
    const { clock, local, cloud, engine } = await queued();
    cloud.failures.push({ status: 503, message: "unavailable" });
    engine.kick();
    await engine.idle();
    const q = local.queue.get("f1")!;
    expect(q.state).toBe("retry_pending");
    expect(q.attempts).toBe(1);
    expect(Date.parse(q.nextAttemptAtUtc!) - clock.now).toBe(10_000);
    engine.kick();
    await engine.idle();
    expect(cloud.calls).toBe(1); // backoff respected
    clock.now += 10_001;
    engine.kick();
    await engine.idle();
    expect(local.state("f1")).toBe("synced");
  });

  it("gives up after the attempt limit and lets the user retry", async () => {
    const { clock, local, cloud, engine } = await queued();
    for (let i = 0; i < MAX_SYNC_ATTEMPTS; i++) {
      cloud.failures.push({ status: 500, message: "boom" });
      engine.kick();
      await engine.idle();
      clock.now += 3_600_000;
    }
    expect(local.state("f1")).toBe("failed");
    expect(cloud.calls).toBe(MAX_SYNC_ATTEMPTS);
    await engine.retryFailed();
    await engine.idle();
    expect(local.state("f1")).toBe("synced");
  });

  it("goes offline on network errors without touching local data", async () => {
    const { local, cloud, engine, auth } = await queued();
    cloud.failures.push(new TypeError("Failed to fetch"));
    engine.kick();
    await engine.idle();
    expect(engine.getView().offline).toBe(true);
    expect(auth.view.offline).toBe(true);
    expect(local.state("f1")).toBe("retry_pending");
    expect(local.flights.size).toBe(1);
  });

  it("treats a timeout as transient", async () => {
    const { local, cloud, engine } = await queued();
    cloud.failures.push(new DOMException("timeout", "TimeoutError"));
    engine.kick();
    await engine.idle();
    expect(local.state("f1")).toBe("retry_pending");
  });

  it("an upload that already reached the cloud (crash before marking) is not duplicated", async () => {
    const { local, cloud, engine, make, start } = await queued();
    await local.enqueueAfterOptIn(ACCT_A);
    // Simulate: the upload landed, then the app crashed while the row still said "uploading".
    const { buildSyncPayload } = await import("@flightsim/cloud");
    await cloud.uploadFlight(buildSyncPayload(local.flights.get("f1")!));
    await local.mark({ flightId: "f1", accountId: ACCT_A, state: "uploading" });
    stops.forEach((s) => s());
    stops = [];
    void engine;
    const restarted = make();
    await start(restarted);
    expect(local.state("f1")).toBe("synced");
    expect(cloud.rows.size).toBe(1);
    expect(cloud.rows.get("f1")!.events.size).toBe(2);
  });

  it("does not claim success when the cloud copy is incomplete (partial upload)", async () => {
    const { local, cloud, engine } = await queued();
    cloud.truncateNext = 1;
    engine.kick();
    await engine.idle();
    expect(local.state("f1")).toBe("failed");
    expect(local.queue.get("f1")!.lastError).toMatch(/verification/);
    // Retrying is idempotent and completes the missing events.
    await engine.retryFailed();
    await engine.idle();
    expect(local.state("f1")).toBe("synced");
    expect(cloud.rows.get("f1")!.events.size).toBe(2);
  });

  it("pauses on an expired session without spending attempts, then resumes after sign-in", async () => {
    const { local, cloud, engine, auth } = await queued();
    cloud.sessionValid = false;
    engine.kick();
    await engine.idle();
    expect(auth.refreshCalls).toBe(1);
    expect(engine.getView().block).toBe("session_expired");
    expect(local.queue.get("f1")).toMatchObject({ state: "retry_pending", attempts: 0 });
    cloud.sessionValid = true;
    auth.signIn(ACCT_A);
    await engine.idle();
    expect(local.state("f1")).toBe("synced");
  });

  it("continues after a successful token refresh", async () => {
    const { local, cloud, engine, auth } = await queued();
    cloud.failures.push({ status: 401, code: "PGRST301", message: "JWT expired" });
    auth.refreshResult = true;
    engine.kick();
    await engine.idle();
    expect(local.state("f1")).toBe("synced");
  });

  it("marks permission denials as failed (no endless retries)", async () => {
    const { local, cloud, engine } = await queued();
    cloud.rows.set("f1", { owner: ACCT_B, events: new Set(), interruptions: new Set() });
    engine.kick();
    await engine.idle();
    expect(local.state("f1")).toBe("failed");
    expect(cloud.rows.get("f1")!.owner).toBe(ACCT_B);
  });

  it("uploads one request at a time and in bounded batches", async () => {
    const { clock, local, cloud, engine } = await queued();
    for (let i = 2; i <= 7; i++) local.addFlight(completedFlight(`f${i}`, later(i)));
    let inFlight = 0;
    let maxInFlight = 0;
    const orig = cloud.uploadFlight.bind(cloud);
    cloud.uploadFlight = async (p) => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise((r) => setTimeout(r, 1));
      try {
        return await orig(p);
      } finally {
        inFlight--;
      }
    };
    engine.kick();
    engine.kick();
    engine.kick();
    await engine.idle();
    expect(maxInFlight).toBe(1);
    void clock;
    expect([...local.queue.values()].every((q) => q.state === "synced")).toBe(true);
  });
});
