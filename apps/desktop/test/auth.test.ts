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
