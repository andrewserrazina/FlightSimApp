/** Authentication state, kept free of tokens: the UI and diagnostics only ever see this. */
export type AuthStatus =
  | "unconfigured" // no cloud project configured: local-only app
  | "initializing"
  | "signed_out"
  | "verification_required" // account created, waiting for the emailed code
  | "recovery_code_sent" // password reset requested, waiting for the emailed code
  | "signed_in"
  | "session_expired";

export interface AuthUser {
  id: string;
  email: string;
}

export interface AuthView {
  status: AuthStatus;
  user: AuthUser | null;
  /** Email the pending verification/recovery code was sent to. */
  pendingEmail: string | null;
  /** Session persists in OS secure storage (false = memory only for this run). */
  persistent: boolean;
  /** Last cloud contact failed for network reasons; local features are unaffected. */
  offline: boolean;
  busy: boolean;
  message: string | null;
  error: string | null;
}

export const initialAuthView = (configured: boolean): AuthView => ({
  status: configured ? "initializing" : "unconfigured",
  user: null,
  pendingEmail: null,
  persistent: false,
  offline: false,
  busy: false,
  message: null,
  error: null,
});

export type AuthEvent =
  | { type: "initialized"; user: AuthUser | null; persistent: boolean; offline: boolean }
  | { type: "busy" }
  | { type: "signed_in"; user: AuthUser }
  | { type: "verification_required"; email: string; message: string }
  | { type: "recovery_code_sent"; email: string }
  | { type: "signed_out"; byUser: boolean }
  | { type: "offline"; offline: boolean }
  | { type: "failed"; error: string }
  | { type: "message"; message: string };

/** Pure transition function (unit-tested). */
export function authReducer(s: AuthView, e: AuthEvent): AuthView {
  if (s.status === "unconfigured") return s;
  switch (e.type) {
    case "initialized":
      return { ...s, status: e.user ? "signed_in" : "signed_out", user: e.user, persistent: e.persistent, offline: e.offline, busy: false };
    case "busy":
      return { ...s, busy: true, error: null, message: null };
    case "signed_in":
      return { ...s, status: "signed_in", user: e.user, pendingEmail: null, busy: false, error: null, offline: false, message: null };
    case "verification_required":
      return { ...s, status: "verification_required", user: null, pendingEmail: e.email, busy: false, error: null, message: e.message };
    case "recovery_code_sent":
      return { ...s, status: "recovery_code_sent", pendingEmail: e.email, busy: false, error: null, message: "If an account exists for that email, a reset code has been sent." };
    case "signed_out":
      // A sign-out the user did not ask for (refresh token revoked/expired) is shown as an expired session.
      return { ...s, status: e.byUser || s.status !== "signed_in" ? "signed_out" : "session_expired", user: null, pendingEmail: null, busy: false, message: e.byUser ? "Signed out. Local flights stay on this computer." : null };
    case "offline":
      return { ...s, offline: e.offline };
    case "failed":
      return { ...s, busy: false, error: e.error };
    case "message":
      return { ...s, busy: false, message: e.message, error: null };
  }
}

/** "a***@example.com" — enough to recognise an account without exposing the full address. */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}
