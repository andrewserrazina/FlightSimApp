// Investigation harness (not part of the normal suites): record every secure-storage write the real
// AuthService makes across all auth flows, against the local stack. Prints key names + sizes only.
import { afterAll, it } from "vitest";
import { ANON_KEY, mailedCode, requireStack, uniqueEmail, URL_ } from "../../../../packages/cloud/test/stack";
import { AuthService } from "../../src/auth/AuthService";
import { createSecureSessionStorage, type SecureBackend } from "../../src/auth/secureStorage";

const log: string[] = [];
let phase = "";
class Rec implements SecureBackend {
  value: string | null = null;
  async available() { return true; }
  async get() { return this.value; }
  async set(v: string) {
    this.value = v;
    const shape = Object.fromEntries(Object.entries(JSON.parse(v) as Record<string, string>).map(([k, x]) => [k, x.length < 40 ? JSON.stringify(x) : `<${x.length} chars>`]));
    log.push(`${phase}: set ${v.length}B ${JSON.stringify(shape)}`);
  }
  async remove() { this.value = null; log.push(`${phase}: remove`); }
}
const settle = () => new Promise((r) => setTimeout(r, 300));
const services: AuthService[] = [];
afterAll(() => { services.forEach((a) => a.client?.auth.stopAutoRefresh()); console.log("\n" + log.join("\n")); });

it("records keychain writes for every auth flow", { timeout: 120_000 }, async () => {
  await requireStack();
  const kc = new Rec();
  const mk = async () => { const a = new AuthService({ url: URL_, anonKey: ANON_KEY }, await createSecureSessionStorage(kc)); services.push(a); await a.init(); return a; };
  const email = uniqueEmail("inv"); const pw = "investigation-pass-1";
  phase = "init(empty)"; const a = await mk();
  phase = "signUp"; await a.signUp(email, pw); await settle();
  phase = "verifyEmail"; await a.verifyEmail(await mailedCode(email, "verification")); await settle();
  phase = "restart"; const b = await mk(); await settle();
  phase = "refreshSession"; await b.client!.auth.refreshSession(); await settle();
  phase = "refreshAfterRejection"; await b.refreshAfterRejection(); await settle();
  phase = "resendWhileSignedIn(signIn)"; await b.signIn(email, pw); await settle();
  phase = "requestPasswordReset"; await b.requestPasswordReset(email); await settle();
  phase = "completePasswordReset"; await b.completePasswordReset(await mailedCode(email, "reset"), "investigation-pass-2"); await settle();
  phase = "signOut"; await b.signOut(); await settle();
  phase = "signIn-wrong"; await b.signIn(email, "wrong-password-xx"); await settle();
  phase = "signIn"; await b.signIn(email, "investigation-pass-2"); await settle();
  phase = "offline-init"; const c = new AuthService({ url: "http://127.0.0.1:59999", anonKey: ANON_KEY }, await createSecureSessionStorage(kc)); services.push(c); await c.init(); await settle();
  phase = "offline-refresh"; await c.client!.auth.refreshSession().catch(() => {}); await settle();
});
