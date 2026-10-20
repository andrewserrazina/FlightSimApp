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
const STAGES = { l3: stageL3, l4: stageL4, l5: stageL5 };
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

/**
 * Schedule for the L5 captures. The synthetic SimBrief fixture is a 2 h 43 min KBOS-KORD block dated
 * the day after the recorded demo flight, which made every time read as "18 h" off. For these review
 * captures only, a copy of the OFP gets a schedule on the demo flight's own timeline (OUT at the next
 * whole minute after the first frame, OFF 2 min later, ON 2 min after the recorded landing, IN 8 min
 * after it), so OUT/OFF/ON/IN keep their order and read as minutes, not hours. The demo aircraft takes
 * off about a minute after it starts, so its OFF reads slightly early. The fixture file, the tests and
 * every date/time calculation are unchanged.
 */
async function screenshotOfp() {
  const ofp = JSON.parse(await readFile(join(repo, "fixtures/simbrief/ofp-v2-navlog.json"), "utf8"));
  const onGround = (f) => f.data.readings.on_ground?.value;
  const takeoff = frames.find((f) => onGround(f) === false);
  const landing = frames.find((f) => Date.parse(f.data.observed_at) > Date.parse(takeoff.data.observed_at) && onGround(f) === true);
  const minute = (iso, plusMin) => new Date(Math.round((Date.parse(iso) + plusMin * 60_000) / 60_000) * 60_000);
  const nextMinute = (iso) => new Date(Math.ceil(Date.parse(iso) / 60_000) * 60_000);
  const z = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  const hms = (ms) => [Math.floor(ms / 3_600_000), Math.floor(ms / 60_000) % 60, Math.floor(ms / 1000) % 60].map((n) => String(n).padStart(2, "0")).join(":");
  const out = nextMinute(frames[0].data.observed_at), off = new Date(+out + 2 * 60_000), on = minute(landing.data.observed_at, 2), inn = minute(landing.data.observed_at, 8);
  Object.assign(ofp.times, {
    sched_out: z(out), sched_off: z(off), sched_on: z(on), sched_in: z(inn), sched_block: hms(inn - out), sched_time_enroute: hms(on - off),
    est_out: z(out), est_off: z(off), est_on: z(new Date(+on + 60_000)), est_in: z(new Date(+inn + 60_000)), est_block: hms(inn - out), est_time_enroute: hms(on - off + 60_000),
  });
  return ofp;
}

/** Fails the run when any tile or header text is cut off (ellipsis or overflow) at the captured width. */
async function assertNothingCutOff(p, name) {
  const cut = await p.evaluate(() =>
    [...document.querySelectorAll(".ops-tile__value, .ops-tile__secondary, .ops-tile .ops-label, .ops-id__flight, .ops-id__route, .ops-id__sub, .ops-id__status, .ops-chip, .ops-primary, .ops-idle, .ops-strip__label, .ops-strip__time")]
      .filter((e) => e.scrollWidth > e.clientWidth + 1)
      .map((e) => `${e.className}: "${e.textContent.trim()}"`),
  );
  if (cut.length) errors.push(`${name}: text cut off: ${cut.join(" | ")}`);
}

async function stageL5() {
  const conn = (state, at) => env("connection.state", { state, simulator: "mock", since: at, attempt: 0, next_retry_at: null, reason: state === "CONNECTED" ? null : { code: "simulator_closed", message: "The simulator connection was lost." }, schema_version: 1 });
  const ofp = await screenshotOfp();
  const capture = async (p, name, opts) => {
    await assertNothingCutOff(p, name);
    await shot(p, name, opts);
  };
  const startFlight = async (p) => {
    await p.evaluate(async (o) => {
      window.__ofpOverride = o;
      const d = window.__harness.dispatch;
      await d.importLatest("username", "test_pilot");
      await d.release({ warnings: [], unavailableInformational: [] });
    }, ofp);
    await p.getByRole("button", { name: "Start flight" }).click();
  };
  for (const [width, height] of [[1100, 900], [1280, 1024], [1920, 1080]]) {
    const screen = { full: false };

    // Session 1: the recorded demo flight exactly as recorded. It is not flown along the plan's
    // route, so route progress stays honestly unavailable (the route-mismatch negative case).
    let p = await open(width, { prefs: OPS, height });
    await startFlight(p);
    await capture(p, `predeparture-${width}`, screen);
    await p.locator(".ops-toast").waitFor({ state: "detached", timeout: 10_000 }); // "Flight started." is transient
    await replay(p, 3, cruiseAt);
    await capture(p, `cruise-${width}`, screen);
    if (width === 1280) await shot(p, "cruise-1280-full-page");
    // Data stops for 20 s: stale values are dimmed and aged; recording continues (not yet interrupted).
    const cruiseMs = Date.parse(frames[cruiseAt].data.observed_at);
    await p.clock.setFixedTime(new Date(cruiseMs + 20_000));
    await p.waitForTimeout(1300);
    await capture(p, `problem-stale-${width}`, screen);
    // The connection is lost for over 30 s: the recorder marks the flight interrupted (a pause).
    await emit(p, [conn("DISCONNECTED", new Date(cruiseMs + 22_000).toISOString())]);
    await p.clock.setFixedTime(new Date(cruiseMs + 60_000));
    await p.getByText("‖ Recording paused").waitFor({ timeout: 10_000 });
    await capture(p, `interrupted-${width}`, screen);
    // Data returns for the same aircraft, near where it was: the recorder resumes on its own.
    await emit(p, [conn("CONNECTED", new Date(cruiseMs + 65_000).toISOString())]);
    const back = firstFrameAtOrAfter(new Date(cruiseMs + 65_000).toISOString());
    await replay(p, back, back + 6);
    await p.getByText("● Recording").first().waitFor({ timeout: 10_000 }); // resumed by the recorder, no click
    await capture(p, `resumed-automatically-${width}`, screen);
    // Landed and parked: Record IN is primary, Confirm completion stays available under More.
    await replay(p, back + 7, frames.length - 1);
    await capture(p, `arrival-${width}`, screen);
    await p.close();

    // Session 2 (separate, for review): recorded cruise frames moved onto one planned leg at 300 kt,
    // so the route card can be seen tracking with an ETA. Not mixed into session 1.
    p = await open(width, { prefs: OPS, height });
    await startFlight(p);
    await p.locator(".ops-toast").waitFor({ state: "detached", timeout: 10_000 });
    await replay(p, 3, cruiseAt);
    const base = frames[cruiseAt];
    for (let i = 0; i < 12; i++) {
      const at = new Date(Date.parse(base.data.observed_at) + (i + 1) * 5000);
      await p.clock.setFixedTime(at);
      await p.evaluate(({ base, i, at }) => {
        const fixes = window.__harness.dispatch.currentPlan.navlog.fixes.filter((f) => f.lat !== null && f.lon !== null);
        const a = fixes[Math.floor(fixes.length / 2)], b = fixes[Math.floor(fixes.length / 2) + 1];
        const legNm = Math.hypot((b.lat - a.lat) * 60, (b.lon - a.lon) * 60 * Math.cos((a.lat * Math.PI) / 180));
        const t = 0.3 + (i * 300 * (5 / 3600)) / legNm;
        const f = structuredClone(base);
        f.data.seq = base.data.seq + 1 + i;
        f.data.observed_at = at;
        f.data.readings.lat_deg.value = a.lat + (b.lat - a.lat) * t;
        f.data.readings.lon_deg.value = a.lon + (b.lon - a.lon) * t;
        window.__harness.transport.emit(f);
      }, { base, i, at: at.toISOString() });
    }
    await p.waitForTimeout(1300);
    await capture(p, `route-tracking-review-${width}`, screen);
    // A genuine manual-resume case: the connection drops for over 30 s and data then returns from the
    // recorded flight's real position, far from the leg above. The recorder sees a position jump
    // beyond what the aircraft could have flown and waits for Resume.
    const trackMs = Date.parse(base.data.observed_at) + 12 * 5000;
    await emit(p, [conn("DISCONNECTED", new Date(trackMs + 2_000).toISOString())]);
    await p.clock.setFixedTime(new Date(trackMs + 40_000));
    await p.getByText("‖ Recording paused").waitFor({ timeout: 10_000 }); // the recorder's tick has marked it interrupted
    await emit(p, [conn("CONNECTED", new Date(trackMs + 45_000).toISOString())]);
    const real = firstFrameAtOrAfter(new Date(trackMs + 45_000).toISOString());
    await replay(p, real, real + 4);
    await p.getByText("! Resume needed").waitFor({ timeout: 10_000 });
    await capture(p, `resume-needed-${width}`, screen);
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
