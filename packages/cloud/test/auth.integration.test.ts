/** Auth flows against the REAL local GoTrue (email/password, OTP verification, recovery, sign-out). */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { client, createVerifiedUser, mailedCode, requireStack, uniqueEmail } from "./stack";

beforeAll(requireStack);

describe("registration and verification", () => {
  it("a new account has no session and cannot sign in until the email code is verified", async () => {
    const email = uniqueEmail("verify");
    const password = `pw-${randomUUID()}`;
    const c = client();
    const up = await c.auth.signUp({ email, password });
    expect(up.error).toBeNull();
    expect(up.data.session).toBeNull();
    const early = await c.auth.signInWithPassword({ email, password });
    expect(early.error?.code).toBe("email_not_confirmed");
    const wrong = await c.auth.verifyOtp({ email, token: "000000", type: "signup" });
    expect(wrong.error).not.toBeNull();
    const code = await mailedCode(email, "verification");
    const ok = await c.auth.verifyOtp({ email, token: code, type: "signup" });
    expect(ok.data.session?.access_token).toBeTruthy();
    expect(ok.data.user?.email_confirmed_at).toBeTruthy();
  });
});

describe("sign-in, refresh and sign-out", () => {
  it("rejects a wrong password and accepts the right one", async () => {
    const u = await createVerifiedUser("signin");
    const c = client();
    expect((await c.auth.signInWithPassword({ email: u.email, password: "wrong-password" })).error?.code).toBe("invalid_credentials");
    expect((await c.auth.signInWithPassword({ email: u.email, password: u.password })).data.session).toBeTruthy();
  });

  it("refreshes a session and revokes it on sign-out", async () => {
    const u = await createVerifiedUser("signout");
    const c = client();
    const { data } = await c.auth.signInWithPassword({ email: u.email, password: u.password });
    const refreshed = await c.auth.refreshSession({ refresh_token: data.session!.refresh_token });
    expect(refreshed.data.session?.access_token).toBeTruthy();
    const c2 = createSignedIn(refreshed.data.session!.access_token, refreshed.data.session!.refresh_token);
    await (await c2).auth.signOut({ scope: "global" });
    const after = await client().auth.refreshSession({ refresh_token: refreshed.data.session!.refresh_token });
    expect(after.error).not.toBeNull();
  });
});

async function createSignedIn(access: string, refresh: string) {
  const c = client();
  await c.auth.setSession({ access_token: access, refresh_token: refresh });
  return c;
}

describe("password recovery", () => {
  it("resets the password with an emailed code; the old password stops working", async () => {
    const u = await createVerifiedUser("recover");
    const c = client();
    expect((await c.auth.resetPasswordForEmail(u.email)).error).toBeNull();
    const code = await mailedCode(u.email, "reset");
    const v = await c.auth.verifyOtp({ email: u.email, token: code, type: "recovery" });
    expect(v.error).toBeNull();
    const newPassword = `new-${randomUUID()}`;
    expect((await c.auth.updateUser({ password: newPassword })).error).toBeNull();
    expect((await client().auth.signInWithPassword({ email: u.email, password: u.password })).error).not.toBeNull();
    expect((await client().auth.signInWithPassword({ email: u.email, password: newPassword })).data.session).toBeTruthy();
  });

  it("does not reveal whether an email is registered", async () => {
    const r = await client().auth.resetPasswordForEmail(uniqueEmail("nobody"));
    expect(r.error).toBeNull();
  });
});
