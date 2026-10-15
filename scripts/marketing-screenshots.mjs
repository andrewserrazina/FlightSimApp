// Captures section-by-section screenshots of the marketing site into docs/screenshots/marketing-v2/.
//   PLAYWRIGHT_MODULE=<playwright>/index.mjs node scripts/marketing-screenshots.mjs
// The signup endpoint is blocked. Turnstile renders with Cloudflare's public always-pass TEST key
// (the production key only works on turnlineops.com), so the widget shown is the real widget in test mode.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(repo, 'marketing');
const out = join(repo, 'docs/screenshots/marketing-v2');
await mkdir(out, { recursive: true });
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  try { const body = await readFile(join(root, path.endsWith('/') ? path + 'index.html' : path)); res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'text/html' }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const cfg = await readFile(join(root, 'config.js'), 'utf8');
const apiUrl = /apiUrl:\s*"([^"]*)"/.exec(cfg)[1];

const browser = await chromium.launch();
async function open(width, height, path = '/') {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
  await page.route(/supabase\.co/, (r) => r.abort());
  await page.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: `window.TURNLINE_CONFIG={apiUrl:${JSON.stringify(apiUrl)},turnstileSiteKey:"1x00000000000000000000AA"};` }));
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  return page;
}
const shots = [];
const shot = async (page, name, sel) => { const file = join(out, name + '.png'); sel ? await page.locator(sel).screenshot({ path: file }) : await page.screenshot({ path: file }); shots.push(name); };

let p = await open(1440, 900);
await shot(p, 'desktop-01-hero');
for (const [i, sel, n] of [[2, '#platform', 'what-is-turnline'], [3, '#how', 'how-it-works'], [4, '#features', 'feature-explorer'], [5, '#different', 'why-different'], [6, '#scenario', 'scenario'], [7, '#integrations', 'integrations'], [8, '#roadmap', 'roadmap']]) {
  await shot(p, `desktop-0${i}-${n}`, sel);
}
await p.locator('#tab-live').click();
await shot(p, 'desktop-04b-feature-explorer-live-ops', '#features .explorer');
await p.locator('.faq-list details').nth(8).locator('summary').click();
await shot(p, 'desktop-09-faq', '#faq');
await p.locator('#early-access').scrollIntoViewIfNeeded();
await p.waitForFunction(() => document.querySelector('#turnstile iframe'), null, { timeout: 20000 }).catch(() => {});
await p.waitForTimeout(2500);
await shot(p, 'desktop-10-early-access', '#early-access');
await shot(p, 'desktop-11-footer', 'footer');
await p.close();

p = await open(1440, 900, '/?waitlist=confirmed#early-access');
await shot(p, 'desktop-12-confirmed-message', '.join-form');
await p.close();

p = await open(390, 844);
await shot(p, 'mobile-01-hero');
await p.click('.menu-toggle');
await shot(p, 'mobile-02-menu-open');
await p.keyboard.press('Escape');
await shot(p, 'mobile-03-feature-explorer', '#features');
await shot(p, 'mobile-04-scenario', '#scenario');
await p.locator('#early-access').scrollIntoViewIfNeeded();
await p.waitForTimeout(2500);
await shot(p, 'mobile-05-early-access', '#early-access');
await p.close();

p = await open(1440, 900, '/privacy.html');
await p.screenshot({ path: join(out, 'privacy-desktop.png'), fullPage: true }); shots.push('privacy-desktop');
await p.close();
p = await open(390, 844, '/privacy.html');
await p.screenshot({ path: join(out, 'privacy-mobile.png'), fullPage: true }); shots.push('privacy-mobile');
await p.close();

await browser.close();
server.close();
console.log(`wrote ${shots.length} screenshots to docs/screenshots/marketing-v2/`);
