import { useState, type FormEvent } from "react";
import { maskEmail } from "../auth/state";
import { Button } from "../ui/Button";
import { TextField } from "../ui/Fields";
import { KeyValueList } from "../ui/KeyValueList";
import { Panel } from "../ui/Panel";
import { Tag } from "../ui/Tag";
import { useAuthView, useCloud } from "./CloudContext";

type Mode = "sign_in" | "register" | "forgot";

const MIN_PASSWORD = 8;

/** Account sign-in / registration / verification / recovery. Never displays tokens. */
export function AccountPanel() {
  const cloud = useCloud();
  const v = useAuthView();
  const [mode, setMode] = useState<Mode>("sign_in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  if (!cloud || v.status === "unconfigured") {
    return (
      <Panel title="Account">
        <p className="muted">Cloud accounts are not configured in this build. Everything works locally without an account.</p>
      </Panel>
    );
  }
  const auth = cloud.auth;
  const busy = v.busy;
  const error = localError ?? v.error;

  const submit = (fn: () => unknown) => (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    void fn();
  };
  const needPassword = (p: string) => {
    if (p.length < MIN_PASSWORD) {
      setLocalError(`Use at least ${MIN_PASSWORD} characters for the password.`);
      return false;
    }
    return true;
  };
  const codeOk = (c: string) => {
    if (!/^\d{6,10}$/.test(c.trim())) {
      setLocalError("Enter the numeric code from the email.");
      return false;
    }
    return true;
  };

  const status =
    v.status === "signed_in" ? <Tag tone="ok">Signed in</Tag> : v.status === "session_expired" ? <Tag tone="warn">Session expired</Tag> : v.status === "initializing" ? <Tag tone="neutral">Checking…</Tag> : <Tag tone="neutral">Signed out</Tag>;

  const feedback = (
    <>
      {v.offline && (
        <p className="muted" role="status">
          The account service cannot be reached right now. Local recording, history and debriefs keep working.
        </p>
      )}
      {v.message && (
        <p className="muted" role="status">
          {v.message}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </>
  );

  let body;
  if (v.status === "initializing") {
    body = <p className="muted">Checking for a saved session…</p>;
  } else if (v.status === "signed_in" && v.user) {
    body = (
      <>
        <KeyValueList
          columns={1}
          items={[
            ["Account", maskEmail(v.user.email)],
            ["Session storage", v.persistent ? "Saved in this computer's secure credential store" : "Memory only — you will need to sign in again next time (secure storage unavailable)"],
          ]}
        />
        <div className="button-row">
          <Button onClick={() => void auth.signOut()} disabled={busy}>
            Sign out
          </Button>
        </div>
        <p className="muted">Signing out removes the saved session from this computer. Local flights are never deleted.</p>
      </>
    );
  } else if (v.status === "verification_required") {
    body = (
      <form onSubmit={submit(() => codeOk(code) && auth.verifyEmail(code))} noValidate>
        <p>
          Enter the verification code sent to <strong>{v.pendingEmail ? maskEmail(v.pendingEmail) : "your email"}</strong>.
        </p>
        <TextField label="Verification code" value={code} onChange={setCode} inputMode="numeric" autoComplete="one-time-code" maxLength={10} required />
        <div className="button-row">
          <Button type="submit" variant="primary" disabled={busy}>
            Verify email
          </Button>
          <Button onClick={() => void auth.resendVerification()} disabled={busy}>
            Send a new code
          </Button>
          <Button variant="quiet" onClick={() => auth.cancelPending()} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    );
  } else if (v.status === "recovery_code_sent") {
    body = (
      <form onSubmit={submit(() => codeOk(code) && needPassword(password) && auth.completePasswordReset(code, password))} noValidate>
        <p>Enter the reset code from the email and choose a new password.</p>
        <TextField label="Reset code" value={code} onChange={setCode} inputMode="numeric" autoComplete="one-time-code" maxLength={10} required />
        <TextField label="New password" type="password" value={password} onChange={setPassword} autoComplete="new-password" required description={`At least ${MIN_PASSWORD} characters.`} />
        <div className="button-row">
          <Button type="submit" variant="primary" disabled={busy}>
            Set new password
          </Button>
          <Button variant="quiet" onClick={() => auth.cancelPending()} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    );
  } else if (mode === "forgot") {
    body = (
      <form onSubmit={submit(() => auth.requestPasswordReset(email.trim()))} noValidate>
        <TextField label="Email" type="email" inputMode="email" value={email} onChange={setEmail} autoComplete="email" required />
        <div className="button-row">
          <Button type="submit" variant="primary" disabled={busy || !email.trim()}>
            Send reset code
          </Button>
          <Button variant="quiet" onClick={() => setMode("sign_in")}>
            Back to sign in
          </Button>
        </div>
      </form>
    );
  } else {
    const register = mode === "register";
    body = (
      <form onSubmit={submit(() => needPassword(password) && (register ? auth.signUp(email.trim(), password) : auth.signIn(email.trim(), password)))} noValidate>
        {v.status === "session_expired" && <p role="status">Your session expired or was signed out elsewhere. Sign in again to resume cloud sync. Local flights are unaffected.</p>}
        <TextField label="Email" type="email" inputMode="email" value={email} onChange={setEmail} autoComplete="email" required />
        <TextField label="Password" type="password" value={password} onChange={setPassword} autoComplete={register ? "new-password" : "current-password"} required {...(register ? { description: `At least ${MIN_PASSWORD} characters.` } : {})} />
        <div className="button-row">
          <Button type="submit" variant="primary" disabled={busy || !email.trim()}>
            {register ? "Create account" : "Sign in"}
          </Button>
          <Button variant="quiet" onClick={() => setMode(register ? "sign_in" : "register")}>
            {register ? "I already have an account" : "Create an account"}
          </Button>
          {!register && (
            <Button variant="quiet" onClick={() => setMode("forgot")}>
              Forgot password?
            </Button>
          )}
        </div>
        <p className="muted">An account is optional. It is only needed for cloud sync; recording and history work without one.</p>
      </form>
    );
  }

  return (
    <Panel title="Account" actions={status}>
      {body}
      {feedback}
    </Panel>
  );
}
