// Full-page and first-screen captures of the marketing site at desktop and mobile widths, for
// before/after comparisons in a PR:
//   PLAYWRIGHT_MODULE=<playwright>/index.mjs node scripts/marketing-compare-screenshots.mjs <out-dir>
// The signup endpoint is blocked and Turnstile uses Cloudflare's public always-pass test key.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(repo, 'marketing');
const out = resolve(process.argv[2] || join(repo, 'docs/screenshots/marketing-compare'));
await mkdir(out, { recursive: true });
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  try { const body = await readFile(join(root, path.endsWith('/') ? path + 'index.html' : path)); res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'text/html' }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
for (const [name, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
  await page.route(/supabase\.co/, (r) => r.abort());
  await page.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.TURNLINE_CONFIG={apiUrl:"https://example.invalid/fn",turnstileSiteKey:"1x00000000000000000000AA"};' }));
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(out, `${name}-first-screen.png`) });
  // Scroll through once so lazy-loaded images are in the full-page capture.
  await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); } window.scrollTo(0, 0); });
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(out, `${name}-full.png`), fullPage: true });
  await page.close();
}
await browser.close();
server.close();
console.log(`wrote 4 screenshots to ${out}`);
