// Captures the S2-05 marketing screens (Receipts & Expenses, Debrief expenses) from the real desktop UI.
//   PLAYWRIGHT_MODULE=<playwright>/index.mjs node scripts/app-screens.mjs [--out dir]
//
// Provenance (keep the site captions in sync with this):
// - The UI is the desktop app's React code from this checkout, rendered in Chromium through
//   apps/desktop/screens/ with in-memory stores. No Tauri shell, no SQLite.
// - The flight is the bridge's recorded MOCK demo flight (fixtures/recordings/simulated/
//   mock-nominal-markers.jsonl.gz) replayed through the real FlightRecorder. The adapter is reported as
//   "mock", so the app shows its own demo-data notices. Nothing claims to be MSFS or GSX.
// - The receipt is the sanitized GSX Fuel fixture (fixtures/gsx/receipts/fuel-kbos-sanitized.html) as the
//   native parser reads it. Currency confirmation, "Count as expense" and the flight association are done by
//   clicking through the real UI, exactly as a user would.
// - Output: <name>-1000.webp / -600.webp, one whole panel each at its own aspect ratio. Nothing is retouched.
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(repo, "apps/desktop");
const outArg = process.argv.indexOf("--out");
const out = outArg > 0 ? process.argv[outArg + 1] : join(repo, "marketing/assets/screens");
await mkdir(out, { recursive: true });
// Full-resolution PNGs stay outside the site directory and are deleted afterwards.
const tmp = await mkdtemp(join(tmpdir(), "turnline-screens-"));

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const require = createRequire(join(desktop, "package.json"));
const { createServer } = await import(require.resolve("vite"));
const server = await createServer({ root: desktop, configFile: join(desktop, "vite.config.ts"), server: { port: 0, strictPort: false, host: "127.0.0.1" }, logLevel: "error" });
await server.listen();
const BASE = server.resolvedUrls.local[0].replace(/\/$/, "");

const lines = gunzipSync(await readFile(join(repo, "fixtures/recordings/simulated/mock-nominal-markers.jsonl.gz"))).toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
const frames = lines.filter((l) => l.type === "telemetry.frame");
const session = frames[0].data.session_id;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2, reducedMotion: "reduce" });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.clock.setFixedTime(new Date(frames[0].data.observed_at));
await page.goto(`${BASE}/screens/index.html?page=live`, { waitUntil: "networkidle" });
const emit = (payloads) => page.evaluate((ps) => ps.forEach((p) => window.__harness.transport.emit(p)), payloads);
const env = (type, data) => ({ protocol: "flightsim.bridge", protocol_version: 1, type, data });

await emit([env("hello.ok", { bridge_version: "0.1.0", session_id: session, adapter: "mock" }), ...lines.filter((l) => l.type === "connection.state").slice(0, 2)]); // the third is the end-of-recording disconnect
await emit(frames.slice(0, 3));
await page.getByRole("button", { name: "Start flight" }).click();
for (let i = 3; i < frames.length; i += 20) {
  const batch = frames.slice(i, i + 20);
  await page.clock.setFixedTime(new Date(batch.at(-1).data.observed_at));
  await emit(batch);
}
await page.waitForTimeout(500);
await page.getByRole("button", { name: "Confirm completion" }).click();
await page.getByText("Flight completed and saved.").waitFor();

// Receipts & Expenses: scan → confirm currency → count → associate, all through the UI.
await page.getByRole("link", { name: "Receipts & Expenses" }).or(page.getByRole("button", { name: "Receipts & Expenses" })).first().click();
await page.getByRole("button", { name: "Scan GSX receipts" }).click();
const card = page.getByRole("article", { name: /Fuel receipt GSX-20261017T164423Z-KBOS/ });
await card.getByRole("button", { name: "Confirm currency…" }).click();
const dialog = page.getByRole("dialog", { name: "Confirm the receipt's currency" });
await dialog.getByRole("radio", { name: "USD" }).check();
const shoot = async (name, locator) => {
  const png = join(tmp, name + ".png");
  await locator.screenshot({ path: png });
  for (const w of [1000, 600]) {
    process.stdout.write(execFileSync("python3", ["-I", "-c", CROP, png, join(out, `${name}-${w}.webp`), String(w)]));
  }
};
// The whole panel, resized to the target width with its aspect ratio kept. Pure geometry; no retouching.
const CROP = `
import sys
from PIL import Image
src, dst, w = sys.argv[1], sys.argv[2], int(sys.argv[3])
im = Image.open(src).convert("RGB")
W, H = im.size
im = im.resize((w, round(H * w / W)), Image.LANCZOS)
im.save(dst, "WEBP", quality=85, method=6)
print(f"{dst} {w}x{round(H * w / W)}")
`;
await shoot("receipt-confirm", dialog);
await dialog.getByRole("button", { name: "Confirm USD" }).click();
await page.getByRole("article", { name: /Fuel receipt/ }).getByRole("button", { name: "Count as expense" }).click();
const ledger = page.getByRole("table", { name: "Expenses" });
await ledger.getByRole("button", { name: /Associate Fuel/ }).click();
const assoc = page.getByRole("dialog", { name: "Associate expense" });
const flightId = (await page.evaluate(() => [...window.__harness.store.flights.keys()]))[0];
await assoc.getByRole("combobox", { name: "Flight" }).selectOption(flightId);
await assoc.getByRole("button", { name: "Save association" }).click();
await page.waitForTimeout(300);

// Debrief of the recorded flight.
await page.getByRole("link", { name: "Flight History" }).or(page.getByRole("button", { name: "Flight History" })).first().click();
await page.getByRole("button", { name: "Debrief" }).or(page.getByRole("link", { name: "Debrief" })).last().click();
const section = page.getByRole("region", { name: "Turnarounds & simulated expenses" });
await section.waitFor();
// A narrow window, so the panel's text stays legible in the site's flow cards and on phones.
await page.setViewportSize({ width: 820, height: 1000 });
await page.waitForTimeout(300);
await shoot("debrief-expenses", section);

await browser.close();
await server.close();
await rm(tmp, { recursive: true, force: true });
if (errors.length) {
  console.error("page errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log(`wrote receipt-confirm and debrief-expenses captures to ${out}`);
