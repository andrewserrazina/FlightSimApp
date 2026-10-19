// Visual-review screenshots for the Live Flight Operations Center PRs.
//   pnpm -r --filter "./packages/**" build
//   PLAYWRIGHT_MODULE=<playwright>/index.mjs node scripts/ops-center-screens.mjs <stage> [--out dir]
//
// Renders the real desktop UI through apps/desktop/test/visual/ops.html (in-memory stores, scripted
// bridge) and replays the bridge's recorded mock demo flight. Output goes to
// docs/screenshots/ops-center/<stage>/ unless --out is given. These are review captures of test-fixture
// data, not product screenshots.
import { mkdir, readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(repo, "apps/desktop");
const stage = process.argv[2];
const outArg = process.argv.indexOf("--out");
const out = outArg > 0 ? process.argv[outArg + 1] : join(repo, "docs/screenshots/ops-center", stage ?? "");
const STAGES = { l3: stageL3 };
if (!STAGES[stage]) {
  console.error(`usage: node scripts/ops-center-screens.mjs <${Object.keys(STAGES).join("|")}> [--out dir]`);
  process.exit(2);
}
await mkdir(out, { recursive: true });

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const require = createRequire(join(desktop, "package.json"));
const { createServer } = await import(require.resolve("vite"));
const server = await createServer({ root: desktop, configFile: join(desktop, "vite.config.ts"), server: { port: 0, strictPort: false, host: "127.0.0.1" }, logLevel: "error" });
await server.listen();
const BASE = server.resolvedUrls.local[0].replace(/\/$/, "");

const lines = gunzipSync(await readFile(join(repo, "fixtures/recordings/simulated/mock-nominal-markers.jsonl.gz"))).toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
const frames = lines.filter((l) => l.type === "telemetry.frame");
const env = (type, data) => ({ protocol: "flightsim.bridge", protocol_version: 1, type, data });

const browser = await chromium.launch();
const errors = [];
const written = [];

/** Open the harness at a width, connected to the recorded mock flight's first frames. */
async function open(width, { page = "live", height = 1000 } = {}) {
  const p = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce" });
  p.on("pageerror", (e) => errors.push(e.message));
  await p.clock.setFixedTime(new Date(frames[0].data.observed_at));
  await p.goto(`${BASE}/test/visual/ops.html?page=${page}`, { waitUntil: "networkidle" });
  const session = frames[0].data.session_id;
  await emit(p, [env("hello.ok", { bridge_version: "0.1.0", session_id: session, adapter: "mock" }), ...lines.filter((l) => l.type === "connection.state").slice(0, 2), ...frames.slice(0, 3)]);
  return p;
}
const emit = (p, payloads) => p.evaluate((ps) => ps.forEach((x) => window.__harness.transport.emit(x)), payloads);

/** Replay recorded frames up to and including index `to`, advancing the fixed clock with them. */
async function replay(p, from, to) {
  for (let i = from; i <= to; i += 20) {
    const batch = frames.slice(i, Math.min(i + 20, to + 1));
    await p.clock.setFixedTime(new Date(batch.at(-1).data.observed_at));
    await emit(p, batch);
  }
}

/** Full-height capture of the scrolling content area. */
async function shot(p, name) {
  await p.waitForTimeout(300);
  const vp = p.viewportSize();
  const h = await p.evaluate(() => document.getElementById("main-content").scrollHeight);
  await p.setViewportSize({ width: vp.width, height: Math.max(vp.height, h + 60) });
  await p.waitForTimeout(250);
  const file = join(out, `${name}.png`);
  await p.screenshot({ path: file });
  await p.setViewportSize(vp);
  written.push(file);
}

async function stageL3() {
  const p = await open(1280, { page: "settings" });
  await replay(p, 3, 300);
  await shot(p, "settings-collapsed-1280");
  await p.getByRole("button", { name: "Show advanced diagnostics" }).click();
  await shot(p, "settings-advanced-diagnostics-1280");
  await p.close();
}

try {
  await STAGES[stage]();
} finally {
  await browser.close();
  await server.close();
}
if (errors.length) {
  console.error("page errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log(written.map((f) => f.replace(repo + "/", "")).join("\n"));
