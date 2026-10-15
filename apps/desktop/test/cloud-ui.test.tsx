// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { FlightSummary } from "@flightsim/flight-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type { AuthService } from "../src/auth/AuthService";
import { flightCloudBadge } from "../src/cloud/presentation";
import type { FlightHistoryRepository } from "../src/data/flightHistory";
import { SyncEngine } from "../src/sync/SyncEngine";
import { ACCT_A, ACCT_B, completedFlight, FakeAuth, FakeCloud, FakeLocalSync } from "./cloudFakes";
import { FakeTransport, flush, MemoryStorage } from "./support";

afterEach(cleanup);

const T0 = Date.parse("2026-10-11T12:00:00.000Z");

class UiAuth extends FakeAuth {
  override signIn = vi.fn((id: string, email = "pilot@example.test") => this.set({ status: "signed_in", user: { id, email } })) as unknown as FakeAuth["signIn"];
  signInWithPassword = vi.fn(async () => {});
  signUp = vi.fn(async () => {});
  verifyEmail = vi.fn(async () => {});
  resendVerification = vi.fn(async () => {});
  requestPasswordReset = vi.fn(async () => {});
  completePasswordReset = vi.fn(async () => {});
  cancelPending = vi.fn(() => this.set({ status: "signed_out", pendingEmail: null }));
  signOut = vi.fn(async () => this.set({ status: "signed_out", user: null }));
}

async function setup(opts: { signedIn?: string; history?: FlightHistoryRepository; page?: "settings" | "history" } = {}) {
  const clock = { now: T0 };
  const local = new FakeLocalSync(clock);
  const auth = new UiAuth();
  auth.view = { ...auth.view, persistent: true };
  if (opts.signedIn) auth.view = { ...auth.view, status: "signed_in", user: { id: opts.signedIn, email: "pilot@example.test" } };
  const cloudApi = new FakeCloud(() => auth.view.user?.id ?? null);
  const sync = new SyncEngine({ local, cloud: cloudApi, auth, now: () => clock.now, random: () => 0.5, intervalMs: 3_600_000 });
  const stop = await sync.start();
  await sync.idle();
  // The panels call the AuthService UI surface; signIn on the real service takes (email, password).
  const authForUi = Object.assign(auth, { signIn: auth.signInWithPassword }) as unknown as AuthService;
  render(<App transport={new FakeTransport()} storage={new MemoryStorage()} initialPage={opts.page ?? "settings"} cloud={{ auth: authForUi, sync }} {...(opts.history ? { history: opts.history } : {})} />);
  await act(flush);
  await act(flush);
  return { clock, local, auth, cloudApi, sync, stop };
}

const accountPanel = () => screen.getByRole("region", { name: "Account" });
const syncPanel = () => screen.getByRole("region", { name: "Cloud sync" });

describe("Settings — no cloud configured", () => {
  it("explains that everything works locally", async () => {
    render(<App transport={new FakeTransport()} storage={new MemoryStorage()} initialPage="settings" />);
    await act(flush);
    expect(within(accountPanel()).getByText(/not configured in this build/)).toBeInTheDocument();
    expect(within(syncPanel()).getByText(/stored on this computer only/)).toBeInTheDocument();
  });
});

describe("Settings — account", () => {
  it("signs in with email and password", async () => {
    const { auth, stop } = await setup();
    const panel = accountPanel();
    expect(within(panel).getByText("Signed out")).toBeInTheDocument();
    fireEvent.change(within(panel).getByLabelText("Email"), { target: { value: " pilot@example.test " } });
    fireEvent.change(within(panel).getByLabelText("Password"), { target: { value: "correct horse" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Sign in" }));
    expect(auth.signInWithPassword).toHaveBeenCalledWith("pilot@example.test", "correct horse");
    stop();
  });

  it("validates password length before contacting the service", async () => {
    const { auth, stop } = await setup();
    const panel = accountPanel();
    fireEvent.click(within(panel).getByRole("button", { name: "Create an account" }));
    fireEvent.change(within(panel).getByLabelText("Email"), { target: { value: "new@example.test" } });
    fireEvent.change(within(panel).getByLabelText("Password"), { target: { value: "short" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Create account" }));
    expect(within(panel).getByRole("alert")).toHaveTextContent(/at least 8/);
    expect(auth.signUp).not.toHaveBeenCalled();
    stop();
  });

  it("asks for the emailed verification code", async () => {
    const { auth, stop } = await setup();
    act(() => auth.set({ status: "verification_required", pendingEmail: "new@example.test", message: "Check your email for a 6-digit verification code." }));
    const panel = accountPanel();
    expect(within(panel).getByText("n***@example.test")).toBeInTheDocument();
    fireEvent.change(within(panel).getByLabelText("Verification code"), { target: { value: "123456" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Verify email" }));
    expect(auth.verifyEmail).toHaveBeenCalledWith("123456");
    stop();
  });

  it("offers password recovery with a code", async () => {
    const { auth, stop } = await setup();
    fireEvent.click(within(accountPanel()).getByRole("button", { name: "Forgot password?" }));
    fireEvent.change(within(accountPanel()).getByLabelText("Email"), { target: { value: "pilot@example.test" } });
    fireEvent.click(within(accountPanel()).getByRole("button", { name: "Send reset code" }));
    expect(auth.requestPasswordReset).toHaveBeenCalledWith("pilot@example.test");
    act(() => auth.set({ status: "recovery_code_sent", pendingEmail: "pilot@example.test" }));
    fireEvent.change(within(accountPanel()).getByLabelText("Reset code"), { target: { value: "654321" } });
    fireEvent.change(within(accountPanel()).getByLabelText("New password"), { target: { value: "a-new-password" } });
    fireEvent.click(within(accountPanel()).getByRole("button", { name: "Set new password" }));
    expect(auth.completePasswordReset).toHaveBeenCalledWith("654321", "a-new-password");
    stop();
  });

  it("shows the signed-in account masked, where the session is kept, and signs out", async () => {
    const { auth, stop } = await setup({ signedIn: ACCT_A });
    const panel = accountPanel();
    expect(within(panel).getByText("p***@example.test")).toBeInTheDocument();
    expect(within(panel).getByText(/secure credential store/)).toBeInTheDocument();
    expect(panel).not.toHaveTextContent("pilot@example.test");
    fireEvent.click(within(panel).getByRole("button", { name: "Sign out" }));
    expect(auth.signOut).toHaveBeenCalled();
    stop();
  });

  it("explains an expired session", async () => {
    const { auth, stop } = await setup({ signedIn: ACCT_A });
    act(() => auth.set({ status: "session_expired", user: null }));
    expect(within(accountPanel()).getByText("Session expired")).toBeInTheDocument();
    expect(within(accountPanel()).getByText(/Sign in again to resume cloud sync/)).toBeInTheDocument();
    stop();
  });
});

describe("Settings — cloud sync", () => {
  it("is off by default and cannot be enabled while signed out", async () => {
    const { stop } = await setup();
    const box = within(syncPanel()).getByRole("checkbox", { name: /Synchronise completed flights/ });
    expect(box).not.toBeChecked();
    expect(box).toBeDisabled();
    expect(within(syncPanel()).getByText(/Never uploaded: track points, raw telemetry/)).toBeInTheDocument();
    stop();
  });

  it("opts in explicitly and binds the signed-in account", async () => {
    const { local, stop } = await setup({ signedIn: ACCT_A });
    const box = within(syncPanel()).getByRole("checkbox", { name: /Synchronise completed flights/ });
    await act(async () => {
      fireEvent.click(box);
      await flush();
    });
    expect(local.s).toMatchObject({ enabled: true, boundAccountId: ACCT_A, boundAccountLabel: "p***@example.test" });
    expect(box).toBeChecked();
    expect(within(syncPanel()).getByText("Never")).toBeInTheDocument(); // last success
    stop();
  });

  it("asks for consent before uploading earlier flights", async () => {
    const { local, sync, stop } = await setup({ signedIn: ACCT_A });
    local.addFlight(completedFlight("old", "2026-10-01T00:00:00.000Z"));
    await act(async () => {
      await sync.enable();
      await sync.idle();
    });
    fireEvent.click(within(syncPanel()).getByRole("button", { name: "Upload earlier flights…" }));
    const dialog = screen.getByRole("dialog", { name: "Upload earlier flights?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep them local" }));
    expect(local.state("old")).toBe("local_only");
    fireEvent.click(within(syncPanel()).getByRole("button", { name: "Upload earlier flights…" }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Upload 1 flight" }));
      await flush();
      await sync.idle();
    });
    expect(local.state("old")).toBe("synced");
    expect(within(syncPanel()).getByText(/1 earlier flight queued/)).toBeInTheDocument();
    stop();
  });

  it("reports failures honestly and retries on request", async () => {
    const { local, sync, cloudApi, clock, stop } = await setup({ signedIn: ACCT_A });
    await act(async () => {
      await sync.enable();
    });
    clock.now += 1000;
    local.addFlight(completedFlight("f1", new Date(clock.now).toISOString()));
    cloudApi.truncateNext = 0;
    await act(async () => {
      sync.kick();
      await sync.idle();
    });
    expect(within(syncPanel()).getByText(/1 flight could not be uploaded/)).toBeInTheDocument();
    expect(within(syncPanel()).queryByText(/Up to date/)).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(syncPanel()).getByRole("button", { name: "Retry failed uploads" }));
      await flush();
      await sync.idle();
    });
    expect(local.state("f1")).toBe("synced");
    expect(within(syncPanel()).getByText(/Up to date/)).toBeInTheDocument();
    stop();
  });

  it("warns when signed in to a different account than sync is set up for", async () => {
    const { sync, auth, stop } = await setup({ signedIn: ACCT_A });
    await act(async () => {
      await sync.enable();
    });
    act(() => auth.set({ user: { id: ACCT_B, email: "other@example.test" } }));
    await act(flush);
    expect(within(syncPanel()).getByText(/signed in to a different account/)).toBeInTheDocument();
    expect(within(syncPanel()).getByRole("checkbox", { name: /Synchronise/ })).not.toBeChecked();
    stop();
  });

  it("keeps tokens, emails and account ids out of the diagnostic report", async () => {
    const { sync, stop } = await setup({ signedIn: ACCT_A });
    await act(async () => {
      await sync.enable();
    });
    const report = (screen.getByLabelText("Report (JSON)") as HTMLTextAreaElement).value;
    const parsed = JSON.parse(report);
    expect(parsed.cloud).toMatchObject({ auth: "signed_in", sync_enabled: true, session_storage: "secure_store" });
    expect(report).not.toContain(ACCT_A);
    expect(report).not.toContain("example.test");
    expect(report).not.toMatch(/eyJ|refresh_token|access_token/);
    stop();
  });
});

describe("History — cloud status", () => {
  const summary = (id: string, sync: NonNullable<FlightSummary["sync"]> | null, status: FlightSummary["status"] = "completed"): FlightSummary => ({ ...completedFlight(id, "2026-10-10T21:00:00.000Z").summary, status, sync });

  it("shows subtle per-flight cloud badges", async () => {
    const flights = [
      summary("a", null),
      summary("b", { state: "synced", accountId: ACCT_A, syncedAtUtc: "2026-10-10T21:05:00.000Z", lastError: null, attempts: 1, nextAttemptAtUtc: null }),
      summary("c", { state: "failed", accountId: ACCT_A, syncedAtUtc: null, lastError: "permission denied", attempts: 1, nextAttemptAtUtc: null }),
      summary("d", { state: "pending", accountId: ACCT_B, syncedAtUtc: null, lastError: null, attempts: 0, nextAttemptAtUtc: null }),
    ];
    const history: FlightHistoryRepository = { availability: { available: true }, listFlights: async () => flights, getFlight: async () => null };
    const { local, sync, stop } = await setup({ signedIn: ACCT_A, history, page: "history" });
    await act(async () => {
      await local.enable(ACCT_A, "a");
      await sync.refresh();
    });
    const table = screen.getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Cloud" })).toBeInTheDocument();
    expect(within(table).getByText("Local only")).toBeInTheDocument();
    expect(within(table).getByText("Synced")).toHaveAttribute("title", expect.stringContaining("verified"));
    expect(within(table).getByText("Upload failed")).toHaveAttribute("title", expect.stringContaining("permission denied"));
    expect(within(table).getByText("Other account")).toBeInTheDocument();
    stop();
  });

  it("has no cloud column when cloud is not configured", async () => {
    render(<App transport={new FakeTransport()} storage={new MemoryStorage()} initialPage="history" history={{ availability: { available: true }, listFlights: async () => [summary("a", null)], getFlight: async () => null }} />);
    await act(flush);
    expect(screen.queryByRole("columnheader", { name: "Cloud" })).not.toBeInTheDocument();
  });

  it("never shows a success badge for anything but a verified upload", () => {
    for (const state of ["pending", "uploading", "retry_pending", "failed"] as const) {
      expect(flightCloudBadge({ status: "completed", sync: { state, accountId: ACCT_A, syncedAtUtc: null, lastError: null, attempts: 0, nextAttemptAtUtc: null } }, ACCT_A)!.tone).not.toBe("ok");
    }
    expect(flightCloudBadge({ status: "active", sync: null }, ACCT_A)).toBeNull();
  });
});
