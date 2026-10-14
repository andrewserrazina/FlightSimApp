#!/usr/bin/env node
// Replay a bridge probe recording through the lifecycle engine, as the desktop recorder would
// (connection states and 1 s ticks included):
//   node packages/flight-core/bin/replay.mjs probe-msfs2024.jsonl[.gz]
// Prints the detected phase timeline, arrival status and reading availability (no thresholds changed).
import { parseProbeJsonl, replayRecording } from "../dist/index.js";
import { readRecording } from "./io.mjs";

const file = process.argv[2];
if (!file) {
  console.error("usage: replay.mjs <probe.jsonl[.gz]>");
  process.exit(2);
}
const rec = parseProbeJsonl(readRecording(file));
const r = replayRecording(rec);
const availability = {};
for (const f of rec.frames) for (const [k, v] of Object.entries(f.readings)) if (v && v.quality !== "unavailable") availability[k] = (availability[k] ?? 0) + 1;
console.log(JSON.stringify({ frames: r.frames, phases: r.phases, arrived: r.arrived, finalPhase: r.finalPhase, interruptions: r.interruptions, completed: r.completed, availability }, null, 2));
