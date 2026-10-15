#!/usr/bin/env node
// Telemetry acceptance report for one probe recording:
//   node packages/flight-core/bin/acceptance.mjs <probe.jsonl[.gz]> [--scenario <name>] [--md report.md] [--json report.json]
// Scenarios: nominal | go-around | touch-and-go | rto | pause | disconnect | restart
// Exit code: 0 = no failures; 1 = a scenario, marker, cockpit check or consistency check failed; 2 = usage error.
// A recording only counts as real-simulator evidence when it came from an MSFS adapter with
// SimConnect.dll loaded and a SimConnect-reported simulator version; mock recordings verify nothing.
import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { SCENARIO_NAMES, evaluateRecording, parseProbeJsonl, renderMarkdown } from "../dist/index.js";
import { readRecording } from "./io.mjs";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const file = args.find((a, i) => !a.startsWith("--") && !["--scenario", "--md", "--json"].includes(args[i - 1]));
const scenario = opt("--scenario");
if (!file || (scenario && !SCENARIO_NAMES.includes(scenario))) {
  console.error(`usage: acceptance.mjs <probe.jsonl[.gz]> [--scenario ${SCENARIO_NAMES.join("|")}] [--md out.md] [--json out.json]`);
  process.exit(2);
}
const report = evaluateRecording(parseProbeJsonl(readRecording(file)), { scenario });
const md = renderMarkdown(report, basename(file));
if (opt("--md")) writeFileSync(opt("--md"), md);
if (opt("--json")) writeFileSync(opt("--json"), JSON.stringify(report, null, 2));
console.log(md);
const failed =
  report.scenario?.verdict === "fail" ||
  report.missingEvents.length > 0 ||
  report.checks.some((c) => c.verdict === "fail") ||
  report.checkErrors.length > 0 ||
  report.fields.some((f) => f.status === "failed" || f.consistency.some((c) => c.verdict === "fail"));
process.exit(failed ? 1 : 0);
