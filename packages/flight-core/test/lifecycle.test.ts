import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DETECTOR_PHASES,
  FLIGHT_PHASES,
  IllegalTransitionError,
  allowedNextPhases,
  canTransition,
  isFlightPhase,
  isTerminal,
  toDbStatus,
  transition,
} from "../src/index.js";

describe("flight lifecycle", () => {
  it("allows the nominal detector path", () => {
    const path = ["READY", "TAXI_OUT", "AIRBORNE", "LANDED", "TAXI_IN", "COMPLETED"] as const;
    for (let i = 1; i < path.length; i++) {
      expect(canTransition(path[i - 1]!, path[i]!, "detector")).toBe(true);
    }
  });

  it("rejects skipping straight from taxi to landed", () => {
    expect(canTransition("TAXI_OUT", "LANDED", "detector")).toBe(false);
    expect(() => transition("TAXI_OUT", "LANDED", "detector")).toThrow(IllegalTransitionError);
  });

  it("rejects self transitions and leaving terminal phases", () => {
    for (const p of FLIGHT_PHASES) expect(canTransition(p, p, "user")).toBe(false);
    for (const p of ["COMPLETED", "CANCELLED", "ABORTED"] as const) {
      expect(isTerminal(p)).toBe(true);
      expect(allowedNextPhases(p)).toEqual([]);
      for (const q of FLIGHT_PHASES) expect(canTransition(p, q, "user")).toBe(false);
    }
  });

  it("lets a user end any active flight but not the detector", () => {
    expect(canTransition("AIRBORNE", "COMPLETED", "detector")).toBe(false);
    expect(transition("AIRBORNE", "COMPLETED", "user")).toEqual({
      from: "AIRBORNE",
      to: "COMPLETED",
      source: "user",
      confidence: "high",
    });
  });

  it("supports go-around and touch-and-go", () => {
    expect(canTransition("APPROACH", "AIRBORNE", "detector")).toBe(true);
    expect(canTransition("LANDED", "AIRBORNE", "detector")).toBe(true);
  });

  it("every phase is reachable from PLANNED", () => {
    const seen = new Set<string>(["PLANNED"]);
    const queue = ["PLANNED"] as (typeof FLIGHT_PHASES)[number][];
    while (queue.length) for (const n of allowedNextPhases(queue.shift()!)) if (!seen.has(n)) (seen.add(n), queue.push(n));
    expect([...seen].sort()).toEqual([...FLIGHT_PHASES].sort());
  });

  it("detector phases are a subset of lifecycle phases", () => {
    for (const p of DETECTOR_PHASES) expect(isFlightPhase(p)).toBe(true);
    expect(isFlightPhase("FLYING")).toBe(false);
  });

  it("matches the flights.status check constraint in the baseline migration", () => {
    const sql = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations/0001_baseline_schema.sql"),
      "utf8",
    );
    const match = /status text not null default 'planned' check \(status in \(([^)]*)\)\)/.exec(sql);
    expect(match).not.toBeNull();
    const dbValues = match![1]!.split(",").map((s) => s.trim().replace(/'/g, ""));
    expect(dbValues.sort()).toEqual(FLIGHT_PHASES.map(toDbStatus).sort());
  });
});
