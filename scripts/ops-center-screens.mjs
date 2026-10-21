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
const STAGES = { l3: stageL3, l4: stageL4 };
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
async function open(width, { page = "live", height = 1000, prefs = null } = {}) {
  const p = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce" });
  p.on("pageerror", (e) => errors.push(e.message));
  await p.clock.setFixedTime(new Date(frames[0].data.observed_at));
  const q = new URLSearchParams({ page, ...(prefs ? { prefs: JSON.stringify(prefs) } : {}) });
  await p.goto(`${BASE}/test/visual/ops.html?${q}`, { waitUntil: "networkidle" });
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

/** Capture of the window as a monitor shows it, or (full) the whole scrolling content area. */
async function shot(p, name, { full = true } = {}) {
  await p.waitForTimeout(300);
  const vp = p.viewportSize();
  if (!full) {
    const file = join(out, `${name}.jpg`);
    await p.screenshot({ path: file, type: "jpeg", quality: 85 });
    written.push(file);
    return;
  }
  const h = await p.evaluate(() => document.getElementById("main-content").scrollHeight);
  await p.setViewportSize({ width: vp.width, height: Math.max(vp.height, h + 60) });
  await p.waitForTimeout(250);
  // JPEG keeps full-height review captures small; L3's two captures predate this and stay PNG.
  const jpeg = stage !== "l3";
  const file = join(out, `${name}.${jpeg ? "jpg" : "png"}`);
  await p.screenshot(jpeg ? { path: file, type: "jpeg", quality: 82 } : { path: file });
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

const OPS = { schemaVersion: 1, opsCenterLayout: true };
/** Index of the first recorded frame whose detected phase is reached, from the recording's markers. */
const firstFrameAtOrAfter = (iso) => frames.findIndex((f) => f.data.observed_at >= iso);
const cruiseAt = firstFrameAtOrAfter(new Date(Date.parse(frames[0].data.observed_at) + 7 * 60_000).toISOString());

/**
 * L4: the operations-center header (identity, one primary action, More, health, attention) above the
 * current panels, at the review widths 1100, 1280 and 1920 px.
 */
async function stageL4() {
  for (const [width, height] of [[1100, 900], [1280, 1024], [1920, 1080]]) {
    const screen = { full: false };
    // At the gate with a released plan, flight started: Record OUT is the primary action.
    let p = await open(width, { prefs: OPS, height });
    await p.evaluate(async () => {
      const d = window.__harness.dispatch;
      await d.importLatest("username", "test_pilot");
      await d.release({ warnings: [], unavailableInformational: [] });
    });
    await p.getByRole("button", { name: "Start flight" }).click();
    await shot(p, `predeparture-${width}`, screen);
    // Cruise: no action needed; altitude, speed and fuel are still in the current panels until L5.
    await replay(p, 3, cruiseAt);
    await shot(p, `cruise-${width}`, screen);
    if (width === 1280) await shot(p, "cruise-1280-full-page");
    // Data stops for 48 s: a plain-language problem appears; nothing is extrapolated.
    await p.clock.setFixedTime(new Date(Date.parse(frames[cruiseAt].data.observed_at) + 48_000));
    await p.waitForTimeout(1300);
    await shot(p, `problem-stale-${width}`, screen);
    // Landed and parked: Record IN is primary, Confirm completion stays available under More.
    await replay(p, cruiseAt + 1, frames.length - 1);
    await shot(p, `arrival-${width}`, screen);
    await p.getByRole("button", { name: "More ▾" }).click();
    await shot(p, `arrival-more-menu-${width}`, screen);
    await p.close();
  }
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
