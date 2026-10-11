// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthService, authErrorMessage, readCloudConfig } from "../src/auth/AuthService";
import { createSecureSessionStorage, type SecureBackend } from "../src/auth/secureStorage";
import { authReducer, initialAuthView, maskEmail, type AuthView } from "../src/auth/state";

const USER = { id: "aaaaaaaa-0000-4000-8000-000000000001", email: "pilot@example.test" };
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";

describe("authReducer", () => {
  const base = (): AuthView => authReducer(initialAuthView(true), { type: "initialized", user: null, persistent: true, offline: false });

  it("never leaves the unconfigured state", () => {
    const s = initialAuthView(false);
    expect(authReducer(s, { type: "signed_in", user: USER })).toBe(s);
  });

  it("goes signed_out → verification_required → signed_in", () => {
    let s = base();
    expect(s.status).toBe("signed_out");
    s = authReducer(s, { type: "verification_required", email: USER.email, message: "check" });
    expect(s).toMatchObject({ status: "verification_required", pendingEmail: USER.email });
    s = authReducer(s, { type: "signed_in", user: USER });
    expect(s).toMatchObject({ status: "signed_in", user: USER, pendingEmail: null });
  });

  it("restores a persisted session at startup, also while offline", () => {
    const s = authReducer(initialAuthView(true), { type: "initialized", user: USER, persistent: true, offline: true });
    expect(s).toMatchObject({ status: "signed_in", offline: true, persistent: true });
  });

  it("distinguishes a user sign-out from an expired/revoked session", () => {
    const signedIn = authReducer(base(), { type: "signed_in", user: USER });
    expect(authReducer(signedIn, { type: "signed_out", byUser: true }).status).toBe("signed_out");
    const expired = authReducer(signedIn, { type: "signed_out", byUser: false });
    expect(expired).toMatchObject({ status: "session_expired", user: null });
    // A follow-up automatic SIGNED_OUT (stored session purged) keeps the expiry visible.
    expect(authReducer(expired, { type: "signed_out", byUser: false }).status).toBe("session_expired");
    expect(authReducer(expired, { type: "signed_in", user: USER }).status).toBe("signed_in");
  });

  it("does not report expiry for a sign-out while not signed in", () => {
    expect(authReducer(base(), { type: "signed_out", byUser: false }).status).toBe("signed_out");
  });

  it("tracks busy, failures and offline without changing the account", () => {
    let s = authReducer(base(), { type: "signed_in", user: USER });
    s = authReducer(s, { type: "busy" });
    expect(s.busy).toBe(true);
    s = authReducer(s, { type: "failed", error: "nope" });
    expect(s).toMatchObject({ busy: false, error: "nope", status: "signed_in" });
    s = authReducer(s, { type: "offline", offline: true });
    expect(s).toMatchObject({ offline: true, status: "signed_in" });
  });

  it("masks emails", () => {
    expect(maskEmail("pilot@example.test")).toBe("p***@example.test");
  });
});

describe("cloud configuration", () => {
  it("is optional", () => {
    expect(readCloudConfig({})).toBeNull();
    expect(readCloudConfig({ VITE_SUPABASE_URL: "https://x.supabase.co" })).toBeNull();
  });
  it("requires https except for local development", () => {
    expect(readCloudConfig({ VITE_SUPABASE_URL: "http://evil.example", VITE_SUPABASE_ANON_KEY: "k" })).toBeNull();
    expect(readCloudConfig({ VITE_SUPABASE_URL: "http://127.0.0.1.evil.example", VITE_SUPABASE_ANON_KEY: "k" })).toBeNull();
    expect(readCloudConfig({ VITE_SUPABASE_URL: "https://abc.supabase.co/", VITE_SUPABASE_ANON_KEY: "k" })).toEqual({ url: "https://abc.supabase.co", anonKey: "k" });
    expect(readCloudConfig({ VITE_SUPABASE_URL: "http://127.0.0.1:54321", VITE_SUPABASE_ANON_KEY: "k" })?.url).toBe("http://127.0.0.1:54321");
  });
  it("leaves the app local-only when unconfigured", () => {
    const a = new AuthService(null, null);
    expect(a.client).toBeNull();
    expect(a.getView().status).toBe("unconfigured");
  });
});

describe("authErrorMessage", () => {
  it("maps known errors to safe messages", () => {
    expect(authErrorMessage({ code: "invalid_credentials", message: "Invalid login credentials" })).toMatch(/incorrect/);
    expect(authErrorMessage({ code: "otp_expired", message: "x" })).toMatch(/expired/);
  });
  it("never echoes tokens", () => {
    expect(authErrorMessage({ message: `bad token ${JWT}` })).not.toContain("eyJ");
    expect(authErrorMessage({ message: "x".repeat(500) })).toBe("The account request failed. Try again.");
  });
});

class FakeBackend implements SecureBackend {
  value: string | null = null;
  ok = true;
  failWrites = false;
  writes = 0;
  async available() {
    return this.ok;
  }
  async get() {
    return this.value;
  }
  async set(v: string) {
    if (this.failWrites) throw new Error("keychain locked");
    this.writes++;
    this.value = v;
  }
  async remove() {
    this.value = null;
  }
}

describe("secure session storage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("keeps all session material in the secure backend and survives a restart", async () => {
    const b = new FakeBackend();
    const s1 = await createSecureSessionStorage(b);
    expect(s1.persistent).toBe(true);
    await s1.setItem("flightsim-auth", JSON.stringify({ access_token: JWT, refresh_token: "r-123" }));
    await s1.setItem("flightsim-auth-code-verifier", "v");
    const s2 = await createSecureSessionStorage(b);
    expect(JSON.parse((await s2.getItem("flightsim-auth"))!).refresh_token).toBe("r-123");
    await s2.removeItem("flightsim-auth");
    await s2.removeItem("flightsim-auth-code-verifier");
    expect(b.value).toBeNull();
  });

  it("never writes to localStorage or sessionStorage", async () => {
    const ls = vi.spyOn(Storage.prototype, "setItem");
    for (const backend of [new FakeBackend(), null, Object.assign(new FakeBackend(), { ok: false }), Object.assign(new FakeBackend(), { failWrites: true })]) {
      const s = await createSecureSessionStorage(backend);
      await s.setItem("flightsim-auth", JSON.stringify({ refresh_token: "r-secret" }));
    }
    expect(ls).not.toHaveBeenCalled();
    expect(JSON.stringify({ ...localStorage })).not.toContain("r-secret");
  });

  it("falls back to memory only when the secure store is unavailable", async () => {
    const b = Object.assign(new FakeBackend(), { ok: false });
    const s = await createSecureSessionStorage(b);
    expect(s.persistent).toBe(false);
    await s.setItem("k", "v");
    expect(await s.getItem("k")).toBe("v");
    expect(b.value).toBeNull();
    expect((await createSecureSessionStorage(null)).persistent).toBe(false);
  });

  it("ignores a corrupted secure entry instead of crashing", async () => {
    const b = new FakeBackend();
    b.value = "{not json";
    const s = await createSecureSessionStorage(b);
    expect(await s.getItem("flightsim-auth")).toBeNull();
  });

  it("keeps working from memory if a secure write fails mid-session", async () => {
    const b = Object.assign(new FakeBackend(), { failWrites: true });
    const s = await createSecureSessionStorage(b);
    await expect(s.setItem("k", "v")).resolves.toBeUndefined();
    expect(await s.getItem("k")).toBe("v");
  });
});

describe("secure session storage ordering", () => {
  it("never lets a slow earlier write overwrite a later one", async () => {
    let stored: string | null = null;
    let calls = 0;
    const b: SecureBackend = {
      available: async () => true,
      get: async () => null,
      set: async (v) => {
        // The first OS write is slow; later writes are fast.
        if (calls++ === 0) await new Promise((r) => setTimeout(r, 30));
        stored = v;
      },
      remove: async () => {
        calls++;
        stored = null;
      },
    };
    const s = await createSecureSessionStorage(b);
    const p1 = s.setItem("flightsim-auth", "old-session");
    await new Promise((r) => setTimeout(r, 0)); // first write is now in flight
    const p2 = s.setItem("flightsim-auth", "new-session");
    await Promise.all([p1, p2]);
    expect(JSON.parse(stored!)).toEqual({ "flightsim-auth": "new-session" });

    const p3 = s.setItem("flightsim-auth", "another");
    const p4 = s.removeItem("flightsim-auth");
    await Promise.all([p3, p4]);
    expect(stored).toBeNull();
  });
});

describe("secure session storage hardening (S1-06)", () => {
  afterEach(() => vi.restoreAllMocks());

  const backendWith = (value: string | null, over: Partial<SecureBackend> = {}): SecureBackend & { value: string | null } => {
    const b: SecureBackend & { value: string | null } = {
      value,
      available: async () => true,
      get: async (): Promise<string | null> => b.value,
      set: async (v: string) => void (b.value = v),
      remove: async () => void (b.value = null),
      ...over,
    };
    return b;
  };

  it.each([
    ["truncated JSON", '{"flightsim-auth":"{\\"access_tok'],
    ["the 25-byte null value", '{"flightsim-auth":"null"}'.slice(0, 24)],
    ["JSON null", "null"],
    ["array", '["flightsim-auth"]'],
    ["number", "25"],
    ["nested object", '{"flightsim-auth":{"access_token":"x"}}'],
    ["mixed value types", '{"flightsim-auth":"ok","n":1}'],
    ["empty string", ""],
  ])("ignores a malformed entry (%s) as 'no session' and never surfaces it", async (_label, raw) => {
    const s = await createSecureSessionStorage(backendWith(raw));
    expect(s.persistent).toBe(true);
    expect(await s.getItem("flightsim-auth")).toBeNull();
  });

  it("accepts a well-formed entry, including the literal string 'null' that supabase-js treats as no session", async () => {
    const s = await createSecureSessionStorage(backendWith('{"flightsim-auth":"null"}'));
    expect(await s.getItem("flightsim-auth")).toBe("null");
  });

  it("a malformed entry is replaced by the next write", async () => {
    const b = backendWith("{garbage");
    const s = await createSecureSessionStorage(b);
    await s.setItem("flightsim-auth", "fresh");
    expect(JSON.parse(b.value!)).toEqual({ "flightsim-auth": "fresh" });
  });

  it("a read failure at startup falls back to memory-only without throwing", async () => {
    const s = await createSecureSessionStorage(backendWith(null, { get: async () => Promise.reject(new Error("access denied")) }));
    expect(s.persistent).toBe(false);
    await s.setItem("k", "v");
    expect(await s.getItem("k")).toBe("v");
  });

  it("recovers on the next launch once secure storage is accessible again", async () => {
    const b = backendWith(null);
    let ok = false;
    b.available = async () => ok;
    const first = await createSecureSessionStorage(b);
    expect(first.persistent).toBe(false);
    await first.setItem("flightsim-auth", "memory-only");
    expect(b.value).toBeNull(); // nothing written while unavailable
    ok = true;
    const second = await createSecureSessionStorage(b);
    expect(second.persistent).toBe(true);
    await second.setItem("flightsim-auth", "persisted");
    expect(JSON.parse(b.value!)).toEqual({ "flightsim-auth": "persisted" });
  });

  it("replaces a stale session completely", async () => {
    const b = backendWith('{"flightsim-auth":"old-session","flightsim-auth-code-verifier":"v"}');
    const s = await createSecureSessionStorage(b);
    await s.setItem("flightsim-auth", "new-session");
    await s.prune((k) => k.endsWith("-code-verifier"));
    expect(JSON.parse(b.value!)).toEqual({ "flightsim-auth": "new-session" });
  });

  it("prune removes only matching keys in one write and is a no-op when nothing matches", async () => {
    let writes = 0;
    const b = backendWith('{"flightsim-auth":"s","a-code-verifier":"1","flightsim-auth-flows-code-verifier":"[]"}');
    const set = b.set;
    b.set = async (v) => {
      writes++;
      await set(v);
    };
    const s = await createSecureSessionStorage(b);
    await s.prune((k) => k.endsWith("-code-verifier"));
    expect(writes).toBe(1);
    expect(JSON.parse(b.value!)).toEqual({ "flightsim-auth": "s" });
    await s.prune((k) => k.endsWith("-code-verifier"));
    expect(writes).toBe(1);
  });
});
