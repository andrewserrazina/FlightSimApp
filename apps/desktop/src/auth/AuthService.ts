import { createClient, isAuthRetryableFetchError, type AuthError, type Session, type SupabaseClient } from "@supabase/supabase-js";
import type { SessionStorageAdapter } from "./secureStorage";
import { authReducer, initialAuthView, type AuthEvent, type AuthView } from "./state";

export interface CloudConfig {
  url: string;
  anonKey: string;
}

/**
 * Public cloud configuration from the build environment. Only the project URL and the PUBLIC anon
 * key are ever bundled; service-role keys never belong in the desktop app.
 */
export function readCloudConfig(env: Record<string, string | undefined>): CloudConfig | null {
  const url = env.VITE_SUPABASE_URL?.trim();
  const anonKey = env.VITE_SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) return null;
  if (!/^https:\/\/|^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(url)) return null; // https only, except local dev
  return { url: url.replace(/\/+$/, ""), anonKey };
}

const SAFE: Record<string, string> = {
  invalid_credentials: "Email or password is incorrect.",
  email_not_confirmed: "Verify your email address first. Enter the code we sent you.",
  user_already_exists: "An account with this email already exists. Sign in instead.",
  weak_password: "Choose a stronger password (at least 8 characters).",
  otp_expired: "That code is invalid or has expired. Request a new one.",
  over_email_send_rate_limit: "Too many emails were requested. Wait a minute and try again.",
  over_request_rate_limit: "Too many attempts. Wait a minute and try again.",
  same_password: "Choose a password different from your current one.",
};

/** Map auth errors to messages that never contain tokens or server internals. */
export function authErrorMessage(e: unknown): string {
  if (isAuthRetryableFetchError(e)) return "The account service cannot be reached. Check your internet connection; local features keep working.";
  const err = e as Partial<AuthError> | undefined;
  if (err?.code && SAFE[err.code]) return SAFE[err.code]!;
  if (typeof err?.message === "string" && err.message.length < 160 && !/eyJ|token/i.test(err.message)) return err.message;
  return "The account request failed. Try again.";
}

const STORAGE_KEY = "flightsim-auth";
const INIT_TIMEOUT_MS = 6_000;

const toUser = (s: Session | null) => (s?.user ? { id: s.user.id, email: s.user.email ?? "" } : null);

/**
 * Supabase Auth for the desktop app: email/password, OTP email verification and password recovery
 * (6-digit codes typed into the app, so there are no redirect/callback URLs to hijack), sign-out,
 * persisted sessions in OS secure storage, and expiry handling. Exposes no tokens to the UI.
 */
export class AuthService {
  private view: AuthView;
  private listeners = new Set<() => void>();
  private signingOut = false;
  readonly client: SupabaseClient | null;

  constructor(config: CloudConfig | null, private readonly storage: SessionStorageAdapter | null) {
    this.view = initialAuthView(config !== null);
    this.client = config
      ? createClient(config.url, config.anonKey, {
          auth: {
            storage: storage ?? undefined,
            storageKey: STORAGE_KEY,
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: false,
            flowType: "pkce",
          },
        })
      : null;
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getView = () => this.view;

  private dispatch(e: AuthEvent) {
    this.view = authReducer(this.view, e);
    this.listeners.forEach((l) => l());
  }

  async init(): Promise<void> {
    if (!this.client) return;
    this.client.auth.onAuthStateChange((event, session) => {
      // Never block inside this callback (supabase-js holds a lock): defer.
      setTimeout(() => {
        if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED" || event === "USER_UPDATED") {
          const user = toUser(session);
          if (user && this.view.status !== "recovery_code_sent") this.dispatch({ type: "signed_in", user });
        } else if (event === "SIGNED_OUT") {
          this.dispatch({ type: "signed_out", byUser: this.signingOut });
          this.signingOut = false;
        }
      }, 0);
    });
    let user = null;
    let offline = false;
    try {
      // Reads the stored session; refreshes it if expired. Works offline with a still-valid token.
      // With an expired token and no network supabase-js keeps retrying for ~25 s; don't make the
      // UI wait for that: show the stored account as signed in (offline) and let the background
      // refresh settle it (a rejected refresh later surfaces as "Session expired").
      const result = await Promise.race([this.client.auth.getSession(), new Promise<"timeout">((r) => setTimeout(() => r("timeout"), INIT_TIMEOUT_MS))]);
      if (result === "timeout") {
        user = await this.storedUser();
        offline = true;
      } else {
        if (result.error && isAuthRetryableFetchError(result.error)) offline = true;
        user = toUser(result.data.session);
      }
    } catch (e) {
      offline = isAuthRetryableFetchError(e);
    }
    this.dispatch({ type: "initialized", user, persistent: this.storage?.persistent ?? false, offline });
    await this.pruneVerifiers(); // entries saved by S1-05 builds still carry them
  }

  /**
   * PKCE code verifiers are only needed to exchange an emailed *link* for a session. This app uses
   * typed codes, so once a session exists they are dead weight in the keychain: remove them.
   */
  private async pruneVerifiers() {
    if (this.view.status !== "signed_in") return;
    await this.storage?.prune((key) => key.endsWith("-code-verifier")).catch(() => {});
  }

  /** Account of the stored session (id + email only), for offline startup. Never exposes tokens. */
  private async storedUser(): Promise<{ id: string; email: string } | null> {
    try {
      const raw = await this.storage?.getItem(STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as { user?: { id?: unknown; email?: unknown } } | null) : null;
      const id = parsed?.user?.id;
      return typeof id === "string" && id.length > 0 ? { id, email: typeof parsed?.user?.email === "string" ? parsed.user.email : "" } : null;
    } catch {
      return null;
    }
  }

  private async run(fn: (c: SupabaseClient) => Promise<void>) {
    if (!this.client) return;
    this.dispatch({ type: "busy" });
    try {
      await fn(this.client);
      await this.pruneVerifiers();
    } catch (e) {
      if (isAuthRetryableFetchError(e)) this.dispatch({ type: "offline", offline: true });
      this.dispatch({ type: "failed", error: authErrorMessage(e) });
    }
  }

  signUp(email: string, password: string) {
    return this.run(async (c) => {
      const { error } = await c.auth.signUp({ email, password });
      if (error) throw error;
      this.dispatch({ type: "verification_required", email, message: "Check your email for a 6-digit verification code." });
    });
  }

  verifyEmail(code: string) {
    return this.run(async (c) => {
      const email = this.view.pendingEmail;
      if (!email) throw new Error("No verification is pending.");
      const { data, error } = await c.auth.verifyOtp({ email, token: code.trim(), type: "signup" });
      if (error) throw error;
      const user = toUser(data.session);
      if (user) this.dispatch({ type: "signed_in", user });
    });
  }

  resendVerification() {
    return this.run(async (c) => {
      const email = this.view.pendingEmail;
      if (!email) throw new Error("No verification is pending.");
      const { error } = await c.auth.resend({ type: "signup", email });
      if (error) throw error;
      this.dispatch({ type: "message", message: "A new code has been sent." });
    });
  }

  signIn(email: string, password: string) {
    return this.run(async (c) => {
      const { data, error } = await c.auth.signInWithPassword({ email, password });
      if (error?.code === "email_not_confirmed") {
        await c.auth.resend({ type: "signup", email }).catch(() => {});
        this.dispatch({ type: "verification_required", email, message: "Verify your email first. We sent a new code." });
        return;
      }
      if (error) throw error;
      const user = toUser(data.session);
      if (user) this.dispatch({ type: "signed_in", user });
    });
  }

  requestPasswordReset(email: string) {
    return this.run(async (c) => {
      const { error } = await c.auth.resetPasswordForEmail(email);
      if (error) throw error;
      this.dispatch({ type: "recovery_code_sent", email });
    });
  }

  completePasswordReset(code: string, newPassword: string) {
    return this.run(async (c) => {
      const email = this.view.pendingEmail;
      if (!email) throw new Error("No password reset is pending.");
      const { error } = await c.auth.verifyOtp({ email, token: code.trim(), type: "recovery" });
      if (error) throw error;
      const { data, error: upErr } = await c.auth.updateUser({ password: newPassword });
      if (upErr) throw upErr;
      this.dispatch({ type: "signed_in", user: { id: data.user.id, email: data.user.email ?? email } });
      this.dispatch({ type: "message", message: "Password changed. You are signed in." });
    });
  }

  cancelPending() {
    this.dispatch({ type: "signed_out", byUser: true });
  }

  /** Signs out everywhere for this account (revokes refresh tokens server-side when online) and clears secure storage. */
  signOut() {
    return this.run(async (c) => {
      this.signingOut = true;
      const { error } = await c.auth.signOut({ scope: "local" });
      if (error && !isAuthRetryableFetchError(error)) throw error;
      // Local sign-out clears stored session material even when the server could not be reached.
      if (this.view.status !== "signed_out") this.dispatch({ type: "signed_out", byUser: true });
    });
  }

  /**
   * The cloud rejected the access token. Try one refresh; if the refresh token itself is rejected
   * the session is over (expired/revoked) and the user must sign in again. Network failures keep
   * the session (offline is not expiry).
   */
  async refreshAfterRejection(): Promise<boolean> {
    if (!this.client || this.view.status !== "signed_in") return false;
    try {
      const { data, error } = await this.client.auth.refreshSession();
      if (!error && data.session) return true;
      if (error && isAuthRetryableFetchError(error)) {
        this.setOffline(true);
        return false;
      }
    } catch (e) {
      if (isAuthRetryableFetchError(e)) {
        this.setOffline(true);
        return false;
      }
    }
    this.sessionRejected();
    return false;
  }

  /** Called when the cloud rejects the session for good (expired/revoked). */
  sessionRejected() {
    if (this.view.status !== "signed_in") return;
    this.dispatch({ type: "signed_out", byUser: false });
    // Purge the dead session material from secure storage (local only; no network needed).
    void this.client?.auth.signOut({ scope: "local" }).catch(() => {});
  }

  setOffline(offline: boolean) {
    if (this.view.offline !== offline) this.dispatch({ type: "offline", offline });
  }
}
