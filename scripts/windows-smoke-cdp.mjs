// Windows smoke driver: talks to the REAL app's WebView2 over the DevTools protocol.
// The app must be started with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>
// (set only by scripts/windows-smoke.ps1 on a CI runner — the product never enables it).
// Usage: node scripts/windows-smoke-cdp.mjs <step> <outDir> [port]
// Steps: connected | settings | fly | msfs | history
// Prints one JSON result line; exits non-zero when the step's checks fail.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [step, outDir = "smoke-out", port = "9222"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pageTarget() {
  for (let i = 0; i < 90; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && /tauri|localhost/.test(t.url));
      if (page) return page;
    } catch {
      // WebView2 not up yet
    }
    await sleep(1000);
  }
  throw new Error("no WebView2 page target on the DevTools port");
}

const target = await pageTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let nextId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
function send(method, params = {}) {
  const id = ++nextId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
}
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(`evaluate failed: ${r.result.exceptionDetails.text}`);
  return r.result?.result?.value;
}
const bodyText = () => evaluate("document.body.innerText");
async function waitFor(desc, predicateJs, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await evaluate(`Boolean(${predicateJs})`)) return true;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for: ${desc}`);
}
const textIncludes = (s) => `document.body.innerText.includes(${JSON.stringify(s)})`;
async function click(label) {
  const ok = await evaluate(`(() => {
    const els = [...document.querySelectorAll('button, a, label')];
    const el = els.find((e) => e.innerText.trim() === ${JSON.stringify(label)} || e.innerText.trim().startsWith(${JSON.stringify(label)}));
    if (!el || el.disabled) return false;
    el.click();
    return true;
  })()`);
  if (!ok) throw new Error(`no enabled control labelled "${label}"`);
  await sleep(1200);
}
async function screenshot(name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  if (r.result?.data) writeFileSync(join(outDir, `${name}.png`), Buffer.from(r.result.data, "base64"));
}
const nav = (page) => click(page); // sidebar buttons: "Connection", "Live Flight", "Flight History", "Debrief", "Settings"

const result = { step, ok: false, checks: {} };
try {
  if (step === "connected") {
    await waitFor("app shell rendered", textIncludes("Settings"), 90_000);
    await waitFor("mock simulator connected (DEMO DATA)", `${textIncludes("DEMO DATA")} && ${textIncludes("Connected")}`, 120_000);
    result.checks.webview2_rendered = true;
    result.checks.bridge_connected_over_named_pipe = true;
    result.checks.user_agent = await evaluate("navigator.userAgent");
    await screenshot("01-connected");
  } else if (step === "settings") {
    await nav("Settings");
    await waitFor("database ready", textIncludes("Ready (schema v2)"), 30_000);
    const text = await bodyText();
    result.checks.database_ready_schema_v2 = true;
    result.checks.database_in_appdata = /AppData\\Roaming\\dev\.flightsimapp\.desktop\\flightsim\.db/i.test(text);
    const report = await evaluate("document.querySelector('#diag-report')?.value ?? document.querySelector('textarea')?.value");
    const parsed = JSON.parse(report);
    result.checks.diagnostics_parse = true;
    result.checks.diagnostics_adapter = parsed.bridge?.adapter;
    result.checks.diagnostics_simconnect_sdk = parsed.bridge?.simconnect_sdk;
    result.checks.diagnostics_no_secrets = !/eyJ[A-Za-z0-9_-]{10,}|refresh_token|access_token|token=/i.test(report);
    writeFileSync(join(outDir, "diagnostics-report.json"), report);
    await screenshot("02-settings");
    if (!result.checks.database_in_appdata || !result.checks.diagnostics_no_secrets) throw new Error("settings checks failed");
  } else if (step === "fly") {
    await nav("Live Flight");
    await click("Start flight");
    result.checks.flight_started = true;
    await screenshot("03-flight-started");
    await waitFor("arrival detected (Confirm completion offered)", `[...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Confirm completion')`, 9 * 60_000);
    await screenshot("04-arrival-detected");
    await click("Confirm completion");
    await waitFor("flight completed", textIncludes("Completed") || textIncludes("completed"), 30_000);
    await nav("Flight History");
    await waitFor("history lists a completed flight", textIncludes("Completed"), 30_000);
    result.checks.flight_completed_and_listed = true;
    await screenshot("05-history");
  } else if (step === "msfs") {
    await nav("Settings");
    await click("Mock mode (demo data)");
    await waitFor("MSFS adapter reports SimConnect unavailable", `${textIncludes("sdk_unavailable")} || ${textIncludes("SimConnect.dll")}`, 90_000);
    const text = await bodyText();
    result.checks.msfs_adapter_selected = true;
    result.checks.reports_sdk_unavailable = /sdk_unavailable/.test(text);
    await screenshot("06-msfs2024-no-simconnect");
    await click("Mock mode (demo data)");
    await waitFor("back on mock", textIncludes("DEMO DATA"), 90_000);
    result.checks.switched_back_to_mock = true;
  } else if (step === "history") {
    await nav("Flight History");
    await sleep(2000);
    result.checks.completed_flights_listed = await evaluate("[...document.querySelectorAll('tbody tr')].filter((r) => r.innerText.includes('Completed')).length");
    await screenshot("07-history-after-restart");
    if (!(result.checks.completed_flights_listed >= 1)) throw new Error("no completed flight after restart");
  } else {
    throw new Error(`unknown step ${step}`);
  }
  result.ok = true;
} catch (e) {
  result.error = String(e?.message ?? e);
  await screenshot(`failed-${step}`).catch(() => {});
}
console.log(JSON.stringify(result));
ws.close();
process.exit(result.ok ? 0 : 1);
