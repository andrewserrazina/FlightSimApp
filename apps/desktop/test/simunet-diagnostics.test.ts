// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { classifySimuNetError, recordSimuNetAttempt, recordSimuNetFailure, useSimuNetDiagnostics } from "../src/integrations/simunet/diagnostics";

const current = () => renderHook(() => useSimuNetDiagnostics()).result.current;

describe("SimuNet delivery diagnostics", () => {
  it("maps every native sender code to an honest category", () => {
    expect(classifySimuNetError("not_configured")).toBe("not-configured");
    for (const code of ["disabled", "credential_unavailable", "unauthorized"]) expect(classifySimuNetError(code)).toBe("not-authorized");
    for (const code of ["rate_limited", "invalid_frame", "unsupported_source", "stale_frame", "too_large"]) expect(classifySimuNetError(code)).toBe("skipped");
    expect(classifySimuNetError("cancelled")).toBe("cancelled");
    for (const code of ["network", "server_rate_limited", "redirected", "rejected", "invalid_response"]) expect(classifySimuNetError(code)).toBe("delivery-failed");
  });

  it("treats anything unrecognised as a failed delivery and never uses error text", () => {
    for (const error of ["x-api-key: secret", "toString", "__proto__", new Error("boom"), undefined, 42]) {
      expect(classifySimuNetError(error)).toBe("delivery-failed");
    }
  });

  it("counts real delivery failures, but not local refusals or cancellations", () => {
    const before = current().failedRequests;
    recordSimuNetAttempt();
    recordSimuNetFailure("skipped");
    expect(current()).toMatchObject({ state: "idle", failedRequests: before });
    recordSimuNetAttempt();
    recordSimuNetFailure("cancelled");
    expect(current()).toMatchObject({ state: "unavailable", failedRequests: before });
    expect(current().message).toMatch(/stopped and not counted/);
    recordSimuNetFailure("delivery-failed");
    expect(current().failedRequests).toBe(before + 1);
    recordSimuNetFailure("not-authorized");
    expect(current()).toMatchObject({ failedRequests: before + 2, message: "Telemetry sharing is disabled or the operator credential was refused." });
  });
});
