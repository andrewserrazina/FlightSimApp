#!/usr/bin/env node
// Sanitise a probe recording before it is shared or committed (fixtures/recordings/):
//   node packages/flight-core/bin/sanitize.mjs <in.jsonl[.gz]> <out.jsonl.gz>
// Keeps only known line kinds, redacts user paths, e-mail addresses and JWTs, and refuses to write
// the output if anything sensitive-looking remains.
import { sanitizeProbeJsonl } from "../dist/index.js";
import { readRecording, writeRecording } from "./io.mjs";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: sanitize.mjs <in.jsonl[.gz]> <out.jsonl[.gz]>");
  process.exit(2);
}
const r = sanitizeProbeJsonl(readRecording(input));
if (r.residual.length) {
  console.error(`refusing to write ${output}: still contains ${r.residual.join(", ")}`);
  process.exit(1);
}
writeRecording(output, r.text);
console.log(JSON.stringify({ input, output, lines: r.lines, kept: r.lines - r.dropped, dropped: r.dropped, redactions: r.redactions }));
