// Turnline marketing site checks (browser automation with Playwright + Chromium).
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/marketing-site-test.mjs [--live-turnstile] [--out dir]
// Serves marketing/ on 127.0.0.1. Every request to the real signup endpoint or to Cloudflare is
// intercepted: nothing reaches production and no real email address is ever used
// (test addresses use the reserved example.com / example.invalid domains).
// --live-turnstile additionally loads Cloudflare's real Turnstile script with Cloudflare's public
// always-pass TEST site key (1x00000000000000000000AA) to prove the widget initialises and fills the form.
import { createServer } from 'node:http';
import { readFile, readdir, stat, mkdir } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'marketing');
const args = process.argv.slice(2);
const liveTurnstile = args.includes('--live-turnstile');
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
if (outDir) await mkdir(outDir, { recursive: true });

// ---------- static server ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' };
const served = new Map();
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(root, path.endsWith('/') ? path + 'index.html' : path);
  // Cloudflare Pages clean URLs: /confirm serves confirm.html.
  if (!extname(file)) file += '.html';
  try {
    const body = await readFile(file);
    served.set(path, 200);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    served.set(path, 404);
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ---------- harness ----------
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const cfgText = await readFile(join(root, 'config.js'), 'utf8');
const API_URL = /apiUrl:\s*"([^"]*)"/.exec(cfgText)?.[1] ?? '';
const SITE_KEY = /turnstileSiteKey:\s*"([^"]*)"/.exec(cfgText)?.[1] ?? '';
const browser = await chromium.launch();

/** A page with the real config, a stub Turnstile, and a mocked signup endpoint. */
async function openPage({ width = 1280, height = 900, query = '', api = () => ({ status: 200, body: '{"ok":true}' }), js = true, reducedMotion = 'reduce', configOverride = null, realTurnstile = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, javaScriptEnabled: js, reducedMotion });
  const page = await ctx.newPage();
  const log = { errors: [], apiCalls: [], turnstileRenders: [], external: [] };
  page.on('console', (m) => { if (m.type() === 'error') log.errors.push(m.text()); });
  page.on('pageerror', (e) => log.errors.push(String(e)));
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(BASE)) {
      if (configOverride && url.endsWith('/config.js')) return route.fulfill({ contentType: 'text/javascript', body: configOverride });
      return route.continue();
    }
    if (API_URL && url.startsWith(API_URL.split('?')[0])) {
      const req = route.request();
      log.apiCalls.push({ method: req.method(), url, headers: req.headers(), body: req.postData() });
      const r = await api(req);
      if (r.abort) return route.abort('failed');
      if (r.delay) await new Promise((x) => setTimeout(x, r.delay));
      return route.fulfill({ status: r.status, contentType: 'application/json', body: r.body ?? '{}' });
    }
    if (url.startsWith('https://challenges.cloudflare.com/') && realTurnstile) return route.continue();
    if (url.startsWith('https://challenges.cloudflare.com/turnstile/v0/api.js')) {
      // Stub: behaves like Turnstile after a successful check (hidden response field inside the container).
      return route.fulfill({ contentType: 'text/javascript', body: `window.__renders=[];window.turnstile={render(sel,o){window.__renders.push(o);const el=document.querySelector(sel);const i=document.createElement('input');i.type='hidden';i.name='cf-turnstile-response';i.value='stub-token-'+Date.now();el.appendChild(i);return 'w1'},reset(){window.__resets=(window.__resets||0)+1}};` });
    }
    log.external.push(url);
    return route.abort();
  });
  await page.goto(`${BASE}/${query}`, { waitUntil: 'load' });
  return { page, ctx, log };
}

// ---------- 1. files, metadata, secrets ----------
{
  const files = [];
  const walk = async (d) => { for (const f of await readdir(d)) { const p = join(d, f); (await stat(p)).isDirectory() ? await walk(p) : files.push(p); } };
  await walk(root);
  const SECRET_PATTERNS = [/service[_-]?role/i, /SUPABASE_SERVICE/i, /TURNSTILE_SECRET/i, /RESEND_API_KEY\s*[:=]\s*["'][^"']+/, /\bre_[A-Za-z0-9]{20,}/, /\bsk_(live|test)_[A-Za-z0-9]+/, /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/];
  const browserFiles = files.filter((f) => /\.(html|js|css)$/.test(f));
  const hits = [];
  for (const f of browserFiles) {
    const text = await readFile(f, 'utf8');
    for (const re of SECRET_PATTERNS) {
      // config.js and README legitimately *mention* the secret names in "never put X here" comments.
      const scrubbed = text.replace(/^\s*\/\/.*$/gm, '');
      if (re.test(scrubbed)) hits.push(`${f.replace(root, 'marketing')}: ${re}`);
    }
  }
  check('no secrets in browser-delivered files', hits.length === 0, hits.join('; ') || `${browserFiles.length} files scanned`);
  check('config.js exposes only apiUrl and turnstileSiteKey', /^\s*window\.TURNLINE_CONFIG\s*=\s*\{\s*apiUrl:\s*"[^"]*",\s*turnstileSiteKey:\s*"[^"]*"\s*\};?\s*$/m.test(cfgText.replace(/^\s*\/\/.*$/gm, '').trim()), `apiUrl=${API_URL || '(empty)'} siteKey=${SITE_KEY ? SITE_KEY.slice(0, 8) + '…' : '(empty)'}`);
  const html = await readFile(join(root, 'index.html'), 'utf8');
  const privacy = await readFile(join(root, 'privacy.html'), 'utf8');
  check('noindex,nofollow kept on index.html and privacy.html', /<meta name="robots" content="noindex,nofollow">/.test(html) && /<meta name="robots" content="noindex,nofollow">/.test(privacy));
  check('title, description, Open Graph and Twitter metadata present', ['<title>', 'name="description"', 'property="og:title"', 'property="og:description"', 'property="og:image"', 'name="twitter:card"', 'rel="icon"'].every((s) => html.includes(s)));
  check('consent text unchanged from V1', html.includes('I agree to receive Turnline development news and beta invitations by email. I can unsubscribe at any time.'));
  // The lightbox's <img alt=""> has no src until a screenshot is opened.
  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]).filter((tag) => !/^<img alt=""/.test(tag));
  const badImgs = imgs.filter((tag) => !/\ssrc="assets\/screens\/[a-z]+(?:-[a-z]+)*-\d+\.webp"/.test(tag) || !/\salt="[^"]{40,}"/.test(tag) || !/\swidth="\d+"/.test(tag) || !/\sheight="\d+"/.test(tag));
  check('no third-party logos: the only images are Turnline screenshots, each with alt text and dimensions', imgs.length > 0 && badImgs.length === 0, `${imgs.length} images${badImgs.length ? '; bad: ' + badImgs.join(' ').slice(0, 200) : ''}`);
  // V3 status language (the page must never overstate the product).
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  check('hero keeps the core positioning and the in-development notice', text.includes('Your aircraft flies the route. Turnline brings the airline operation to life.') && text.includes('not publicly downloadable'));
  check('meta and social descriptions no longer promise MSFS 2024, passengers or ground handling', ![/name="description"[^>]*>/, /property="og:description"[^>]*>/, /name="twitter:description"[^>]*>/].some((re) => /2024|passenger|ground handling/i.test(re.exec(html)?.[0] ?? '')));
  check('no claim that MSFS 2024 is tested or verified', !/MSFS 2024 tested|2024 (?:is )?(?:tested|verified|supported)/i.test(text) && text.includes('Microsoft Flight Simulator 2024 compatibility has not been verified'));
  check('no "shipped", "launched" or "available now" claims', !/\b(?:now available|available now|shipped|launched)\b/i.test(text.replace(/Is Turnline available now\?/, '')));
  // S2-05: the GSX test session's evidence is stated exactly, and future economics is never offered.
  check('the MSFS 2020 + GSX test result is stated as recorded (USD 2,912.46 fuel expense, linked, shown in Debrief)', text.includes('a USD 2,912.46 simulated fuel expense was linked to the completed flight and shown in its Debrief'));
  check('no claim that receipt matching, flight economics or profitability work today', !/(?:automatic(?:ally)? (?:receipt )?match\w*|profitability|flight economics|revenue)[^.()]{0,80}\b(?:works|is available|tested|today)\b/i.test(text.replace(/Today every receipt is linked to a flight by you|today you link each receipt yourself/g, '')));
  check('expenses are called simulated, never real money', text.includes('simulated operating costs') && text.includes('not real money'));
}

// ---------- 2. layout, resources, console ----------
for (const width of [320, 390, 768, 1024, 1280, 1440]) {
  const { page, ctx, log } = await openPage({ width, height: 900 });
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  check(`no horizontal scroll at ${width}px`, sw <= iw, `scrollWidth ${sw}, viewport ${iw}`);
  if (outDir && [390, 1440].includes(width)) await page.screenshot({ path: join(outDir, `full-${width}.png`), fullPage: true });
  if (width === 390) {
    const srcs = await page.evaluate(async () => {
      const imgs = [...document.querySelectorAll('#product img')];
      for (const img of imgs) { img.loading = 'eager'; if (!img.complete) await new Promise((r) => { img.onload = img.onerror = r; }); }
      return imgs.map((img) => img.currentSrc.split('/').pop());
    });
    check('mobile (390px): the gallery shows the readable detail crops', srcs.length === 4 && srcs.every((s) => s.includes('-detail-')), srcs.join(', '));
  }
  if (width === 1280) {
    const bad = [...served.entries()].filter(([, s]) => s !== 200);
    check('every local resource loads (no 404)', bad.length === 0, bad.map(([p]) => p).join(', ') || [...served.keys()].join(', '));
    check('no console errors or page errors', log.errors.length === 0, log.errors.join(' | '));
    check('no unexpected external requests', log.external.length === 0, log.external.join(', '));
  }
  await ctx.close();
}

// ---------- 3. anchors, navigation ----------
{
  const { page, ctx } = await openPage({ width: 1280 });
  const broken = await page.evaluate(() => [...document.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute('href')).filter((h) => h !== '#' && !document.getElementById(h.slice(1))));
  check('every in-page anchor has a target', broken.length === 0, broken.join(', '));
  const ids = await page.evaluate(() => [...document.querySelectorAll('[id]')].map((e) => e.id));
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  check('no duplicate ids', dup.length === 0, dup.join(', '));
  check('exactly one h1', (await page.locator('h1').count()) === 1);
  for (const id of ['top', 'working', 'product', 'flow', 'platform', 'how', 'features', 'different', 'scenario', 'integrations', 'roadmap', 'faq', 'early-access']) {
    if (!(await page.locator('#' + id).count())) check(`section #${id} exists`, false);
  }
  check('all thirteen sections plus footer present', (await page.locator('#top, #working, #product, #flow, #platform, #how, #features, #different, #scenario, #integrations, #roadmap, #faq, #early-access, footer').count()) === 14);
  await page.click('.hero-actions a[href="#working"]');
  await page.waitForTimeout(300);
  check('"See What’s Working" scrolls to the Built and tested section', Math.abs(await page.evaluate(() => document.getElementById('working').getBoundingClientRect().top)) < 140);
  const built = await page.evaluate(() => [...document.querySelectorAll('#working .built')].map((li) => [li.querySelector('h3').textContent.trim(), li.querySelector('.status').textContent.trim()]));
  const wantBuilt = ['Windows desktop simulator connection', 'Flight recording and history', 'SimBrief OFP import', 'Scheduled flight times', 'Plan persistence and offline use', 'Flight-plan attachment', 'Planned-versus-actual debrief', 'Live GSX Pro turnaround monitoring', 'Flight-linked turnaround history', 'GSX fuel invoices as simulated expenses'];
  check('Built and tested: the ten validated capabilities (S2-01 plus S2-05), each "Implemented internally · MSFS 2020 tested"', built.length === 10 && wantBuilt.every((n, i) => built[i]?.[0] === n && built[i][1] === 'Implemented internally · MSFS 2020 tested'), built.map((b) => b[0]).join(', '));
  const limits = await page.textContent('#working .limits');
  check('Built and tested states its limits (one PC, supported scenarios, no public availability, MSFS 2024 unverified)', ['Windows PC with MSFS 2020', 'currently supports', 'Public availability', 'compatibility have not been established', '2024 compatibility has not been verified'].every((t) => limits.includes(t)));
  const dev = await page.evaluate(() => [...document.querySelectorAll('.next-list li, #roadmap .phase')].map((e) => e.textContent.replace(/\s+/g, ' ')));
  check('S2-02 (dispatch release) and S2-03 (route monitoring) are "In active development", never tested', ['Dispatch release', 'Route monitoring'].every((n) => dev.filter((d) => d.includes(n)).length >= 2 && dev.filter((d) => d.includes(n)).every((d) => d.includes('In active development') && !d.includes('MSFS 2020 tested'))));
  const features = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.feature-list li, .provider')].map((li) => [li.querySelector('strong, h3').textContent.trim(), li.querySelector('.status').textContent.trim()])));
  const neverBuilt = Object.entries(features).filter(([n]) => /passenger|boarding|cabin|SayIntentions|ACARS|delay|decision|turnaround timeline/i.test(n));
  check('passenger, cabin, ATC, ACARS, turnaround-timeline and delay/decision features stay Planned or Research', neverBuilt.length >= 11 && neverBuilt.every(([, st]) => st === 'Planned' || st === 'Research'), neverBuilt.map(([n, st]) => `${n}=${st}`).join('; '));
  const gsxTested = ['Live GSX Pro service monitoring', 'Departure & arrival turnarounds', 'Flight-linked turnaround history', 'Simulated expenses from GSX fuel invoices', 'GSX Pro'];
  check('S2-05 owner-accepted features are "MSFS 2020 tested"; catering/de-icing and manual entries are only "Implemented internally"', gsxTested.every((n) => features[n] === 'Implemented internally · MSFS 2020 tested') && ['Catering & de-icing states', 'Manual service entries & servicing readiness', 'Manual simulated expenses'].every((n) => features[n] === 'Implemented internally'), gsxTested.map((n) => `${n}=${features[n]}`).join('; '));
  const future = await page.evaluate(() => [...document.querySelectorAll('.feature-list li, .next-list li, #roadmap .phase')].filter((e) => /matching|economics|profitab/i.test(e.querySelector('strong, h3').textContent)).map((e) => [e.querySelector('strong, h3').textContent.trim(), e.querySelector('.status').textContent.trim()]));
  check('receipt matching, flight economics and profitability are only "In active development" or "Planned"', future.length >= 6 && future.every(([, st]) => st === 'In active development' || st === 'Planned'), future.map((f) => f.join('=')).join('; '));
  check('MSFS 2024 is "In active development"; MSFS 2020 and SimBrief are tested', features['Microsoft Flight Simulator 2024'] === 'In active development' && features['Microsoft Flight Simulator 2020'] === 'Implemented internally · MSFS 2020 tested' && features['SimBrief'] === 'Implemented internally · MSFS 2020 tested');
  const shots = await page.evaluate(async () => {
    const imgs = [...document.querySelectorAll('main section img')];
    const loading = imgs.map((img) => img.getAttribute('loading'));
    for (const img of imgs) { img.loading = 'eager'; if (!img.complete) await new Promise((r) => { img.onload = img.onerror = r; }); }
    return imgs.map((img, i) => [img.currentSrc.split('/').pop(), img.naturalWidth, loading[i] ?? 'eager', img.closest('section').id]);
  });
  check('screenshots load (hero eager, showcase lazy) and cover Dispatch, Live Flight, History and Debrief', shots.length === 8 && shots.every(([, w]) => w > 0) && shots[0][2] === 'eager' && shots[0][3] === 'top' && shots.slice(1).every(([, , l]) => l === 'lazy') && ['dispatch', 'live', 'history', 'debrief'].every((n) => shots.some(([src, , , sec]) => sec === 'product' && src.startsWith(n))), shots.map((s) => s.join(':')).join(', '));
  const flow = shots.filter(([, , , sec]) => sec === 'flow').map(([src]) => src.replace(/-\d+\.webp$/, ''));
  check('operational flow shows Dispatch → receipt confirmation → Debrief expenses, in order', flow.join(',') === 'dispatch-detail,receipt-confirm,debrief-expenses' && (await page.locator('#flow .flow-step h3').allTextContents()).join(',') === 'Dispatch,GSX turnaround,Debrief', flow.join(','));
  const flowNote = await page.textContent('#flow .flow-note');
  check('flow screens are disclosed as sample data (sanitized receipt, not the USD 2,912.46 session) and future features as not shown', ['Internal build', 'sample data', 'sanitized GSX Fuel receipt', 'USD 2,912.46', 'still in development and are not shown'].every((t) => flowNote.includes(t)), flowNote.trim().slice(0, 120));
  await page.locator('#product a[data-lightbox]').nth(3).click();
  await page.waitForFunction(() => document.getElementById('lightbox').open && document.querySelector('#lightbox img').complete);
  const box = await page.evaluate(() => { const i = document.querySelector('#lightbox img'); return [i.naturalWidth, i.alt === document.querySelectorAll('#product img')[3].alt, document.getElementById('lightbox-title').textContent, document.activeElement.className]; });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => [document.getElementById('lightbox').open, document.activeElement.getAttribute('href')]);
  check('screenshot lightbox: opens the full-size image with the same alt text, closes with Escape and restores focus', box[0] === 1600 && box[1] && box[2] === 'Operational Debrief' && box[3] === 'lightbox-close' && after[0] === false && after[1] === 'assets/screens/debrief-1600.webp', JSON.stringify([...box, ...after]));
  const captions = await page.evaluate(() => [document.querySelector('.hero-shot figcaption').textContent, document.querySelector('#product .section-head').textContent, document.querySelector('.gallery-note').textContent].join(' '));
  check('screenshots are labelled as internal builds with sample data', /Internal build/.test(captions) && /sample data/i.test(captions) && /not a real aircraft/.test(captions));
  await page.click('.nav-links a[href="#roadmap"]');
  await page.waitForTimeout(300);
  const roadmapTop = await page.evaluate(() => document.getElementById('roadmap').getBoundingClientRect().top);
  check('desktop nav link scrolls to its section (below the sticky header)', roadmapTop >= 0 && roadmapTop < 140, `top=${Math.round(roadmapTop)}px`);
  await page.click('.hero-actions a[href="#early-access"]');
  await page.waitForTimeout(200);
  check('"Join the Early Access List" moves focus to the email field', await page.evaluate(() => document.activeElement?.id === 'email'));
  await page.goto(`${BASE}/privacy.html`);
  check('privacy notice reachable and names the operator', (await page.content()).includes('Apex Aviation Training Group LLC'));
  await ctx.close();
}
{
  const { page, ctx } = await openPage({ width: 390, height: 844 });
  const toggle = page.locator('.menu-toggle');
  check('mobile: menu button visible, menu hidden', (await toggle.isVisible()) && !(await page.locator('#nav-menu').isVisible()));
  await toggle.click();
  check('mobile: menu opens with aria-expanded=true', (await toggle.getAttribute('aria-expanded')) === 'true' && (await page.locator('#nav-menu').isVisible()));
  await page.keyboard.press('Escape');
  check('mobile: Escape closes menu and returns focus', (await toggle.getAttribute('aria-expanded')) === 'false' && (await page.evaluate(() => document.activeElement?.classList.contains('menu-toggle'))));
  await toggle.click();
  await page.click('#nav-menu a[href="#faq"]');
  await page.waitForTimeout(300);
  check('mobile: choosing a link closes the menu and navigates', (await toggle.getAttribute('aria-expanded')) === 'false' && Math.abs(await page.evaluate(() => document.getElementById('faq').getBoundingClientRect().top)) < 140);
  await ctx.close();
}

// ---------- 3b. footer and privacy navigation ----------
{
  const { page, ctx } = await openPage({ width: 1280 });
  const footer = await page.evaluate(() => [...document.querySelectorAll('footer a')].map((a) => a.getAttribute('href')));
  check('footer links: early access, roadmap, FAQ, privacy notice, support email', ['#early-access', '#roadmap', '#faq', 'privacy.html', 'mailto:support@turnlineops.com'].every((h) => footer.includes(h)), footer.join(' '));
  const legal = await page.textContent('footer');
  check('footer carries tagline, © 2026, operator and non-affiliation language', ['Every flight. The whole operation.', '© 2026 Turnline', 'Apex Aviation Training Group LLC', 'not affiliated with'].every((t) => legal.includes(t)));
  await ctx.close();
}
for (const width of [390, 1280]) {
  const { page, ctx, log } = await openPage({ width, query: 'privacy.html' });
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')));
  const needed = ['index.html', 'index.html#early-access', 'index.html#roadmap', 'index.html#faq', 'mailto:support@turnlineops.com'];
  check(`privacy page at ${width}px: no horizontal scroll, V2 navigation back to the site, no console errors`, sw <= iw && needed.every((h) => links.includes(h)) && log.errors.length === 0, `scrollWidth ${sw}`);
  if (width === 1280) {
    const txt = await page.textContent('main');
    check('privacy page keeps operator, retention, rights and contact text', ['Apex Aviation Training Group LLC', 'deleted after 30 days', '24 months', 'support@turnlineops.com', '75 Tioga Street'].every((t) => txt.includes(t)));
    await page.click('a[href="index.html#faq"]');
    await page.waitForURL(/index\.html#faq$/);
    check('privacy page footer link lands on the FAQ section', await page.evaluate(() => Math.abs(document.getElementById('faq').getBoundingClientRect().top) < 140));
  }
  await ctx.close();
}

// ---------- 4. interactive sections ----------
{
  const { page, ctx } = await openPage({ width: 1280 });
  const details = page.locator('.faq-list details').first();
  check('FAQ has at least 10 questions', (await page.locator('.faq-list details').count()) >= 10);
  await details.locator('summary').click();
  const openAfterClick = await details.evaluate((d) => d.open);
  await details.locator('summary').focus();
  await page.keyboard.press('Enter');
  check('FAQ opens on click and closes with the keyboard', openAfterClick && !(await details.evaluate((d) => d.open)));

  check('feature explorer: one panel visible at a time', (await page.locator('[role="tabpanel"]:visible').count()) === 1);
  await page.locator('#tab-dispatch').focus();
  await page.keyboard.press('ArrowDown');
  const afterArrow = await page.evaluate(() => [document.activeElement.id, document.getElementById('panel-ground').hidden, document.getElementById('panel-dispatch').hidden]);
  await page.keyboard.press('End');
  const afterEnd = await page.evaluate(() => document.activeElement.id);
  check('feature explorer: arrow keys / End move between tabs and switch panels', afterArrow[0] === 'tab-ground' && afterArrow[1] === false && afterArrow[2] === true && afterEnd === 'tab-debrief');
  const statusWords = await page.evaluate(() => [...new Set([...document.querySelectorAll('.feature-list .status')].map((s) => s.textContent.trim()))].sort());
  check('feature statuses use only the five defined labels', statusWords.every((w) => ['Implemented internally · MSFS 2020 tested', 'Implemented internally', 'In active development', 'Planned', 'Research'].includes(w)), statusWords.join(', '));
  const legend = await page.evaluate(() => [...document.querySelectorAll('.legend dt')].map((d) => d.textContent.trim()));
  check('status legend defines exactly those five labels', legend.join('|') === 'Implemented internally · MSFS 2020 tested|Implemented internally|In active development|Planned|Research', legend.join('|'));

  await page.click('.view-toggle button[data-view="planned"]');
  const plannedHidden = await page.locator('.timeline .tl-alert').isHidden();
  await page.click('.view-toggle button[data-view="operated"]');
  check('scenario toggle switches between planned and operated views', plannedHidden && (await page.locator('.timeline .tl-alert').isVisible()) && (await page.locator('.view-toggle button[data-view="operated"]').getAttribute('aria-pressed')) === 'true');
  check('remaining concept visuals (scenario, concept debrief) are labelled as concepts', (await page.locator('#scenario .concept-tag').count()) >= 2);

  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.keyboard.press('Tab');
  check('first Tab reaches the skip link', await page.evaluate(() => document.activeElement?.classList.contains('skip-link')));
  const unnamed = await page.evaluate(() => [...document.querySelectorAll('button, a[href], input:not([type="hidden"])')].filter((el) => !(el.getAttribute('aria-label') || el.textContent.trim() || (el.id && document.querySelector(`label[for="${el.id}"]`)) || el.closest('label'))).map((el) => el.outerHTML.slice(0, 60)));
  check('every link, button and input has an accessible name', unnamed.length === 0, unnamed.join(' | '));
  await ctx.close();
}
{
  const { page, ctx } = await openPage({ width: 1280, reducedMotion: 'reduce' });
  const hidden = await page.evaluate(() => [...document.querySelectorAll('.reveal')].filter((e) => getComputedStyle(e).opacity !== '1').length);
  check('reduced motion: all content visible without animation', hidden === 0, `${hidden} hidden`);
  await ctx.close();
}
{
  const { page, ctx } = await openPage({ width: 1280, js: false });
  const visiblePanels = await page.locator('[role="tabpanel"]:visible').count();
  const reveals = await page.evaluate(() => [...document.querySelectorAll('.reveal')].filter((e) => getComputedStyle(e).opacity !== '1').length);
  check('without JavaScript: all six feature panels and all content are readable', visiblePanels === 6 && reveals === 0);
  await ctx.close();
}

// ---------- 5. waitlist: Turnstile, validation, API contract, messages ----------
{
  const { page, ctx, log } = await openPage({ width: 1280 });
  await page.waitForFunction(() => window.__renders?.length === 1);
  const render = await page.evaluate(() => window.__renders[0]);
  check('Turnstile script loaded from Cloudflare and rendered with the configured site key', render.sitekey === SITE_KEY && SITE_KEY.length > 0);
  check('Turnstile container sits inside the form', await page.evaluate(() => Boolean(document.querySelector('#signup #turnstile [name="cf-turnstile-response"]'))));

  await page.click('#submit');
  check('validation: empty email blocked, marked invalid, no request sent', (await page.getAttribute('#email', 'aria-invalid')) === 'true' && log.apiCalls.length === 0);
  await page.fill('#email', 'not-an-email');
  await page.click('#submit');
  check('validation: malformed email blocked', log.apiCalls.length === 0 && !(await page.evaluate(() => document.getElementById('email').validity.valid)));
  await page.fill('#email', 'pilot@example.com');
  await page.click('#submit');
  check('validation: consent required', (await page.textContent('#status')).includes('Please agree') && log.apiCalls.length === 0);
  await page.evaluate(() => document.querySelector('[name="cf-turnstile-response"]').remove());
  await page.check('#consent');
  await page.click('#submit');
  check('validation: verification check required', (await page.textContent('#status')).includes('complete the verification') && log.apiCalls.length === 0);
  await ctx.close();
}
{
  const long = 'x'.repeat(150);
  const { page, ctx, log } = await openPage({ width: 1280, query: `?utm_source=creator&utm_medium=video&utm_campaign=${long}`, api: () => ({ status: 200, body: '{"ok":true}', delay: 400 }) });
  await page.waitForFunction(() => window.__renders?.length === 1);
  await page.fill('#email', 'pilot@example.com');
  await page.check('#consent');
  await page.click('#submit');
  const inFlight = await page.evaluate(() => [document.getElementById('submit').disabled, document.getElementById('submit').textContent]);
  await page.evaluate(() => document.getElementById('signup').requestSubmit());
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('Check your inbox'));
  check('submit: button disabled while sending; a second submit is ignored', inFlight[0] === true && inFlight[1] === 'Submitting…' && log.apiCalls.length === 1);
  const call = log.apiCalls[0];
  const body = JSON.parse(call.body);
  check('submit: POST to the configured apiUrl with JSON', call.method === 'POST' && call.url === API_URL && call.headers['content-type'] === 'application/json', call.url);
  check('submit: body matches the backend contract', body.email === 'pilot@example.com' && body.consent === true && body.captcha.startsWith('stub-token-') && body.source === 'turnline_waitlist' && Object.keys(body).sort().join() === 'captcha,consent,email,source,utm_campaign,utm_medium,utm_source', Object.keys(body).join(','));
  check('submit: UTM parameters forwarded and capped at 100 characters', body.utm_source === 'creator' && body.utm_medium === 'video' && body.utm_campaign.length === 100);
  check('submit: success message, form reset, Turnstile reset, button restored', (await page.inputValue('#email')) === '' && !(await page.isChecked('#consent')) && (await page.evaluate(() => window.__resets)) >= 1 && (await page.textContent('#submit')) === 'Join the Early Access List');
  await ctx.close();
}
for (const [label, api, expect] of [
  ['server error (503)', () => ({ status: 503 }), 'could not submit your request'],
  ['rate limited (429)', () => ({ status: 429 }), 'Too many sign-up attempts'],
  ['rejected request (400)', () => ({ status: 400 }), 'check your email address'],
  ['network failure', () => ({ abort: true }), 'could not submit your request'],
]) {
  const { page, ctx } = await openPage({ width: 390, height: 844, api });
  await page.waitForFunction(() => window.__renders?.length === 1);
  await page.fill('#email', 'tester@example.invalid');
  await page.check('#consent');
  await page.click('#submit');
  await page.waitForFunction(() => document.getElementById('status').textContent.length > 0);
  const text = await page.textContent('#status');
  check(`failure message: ${label}`, text.includes(expect) && (await page.inputValue('#email')) === 'tester@example.invalid' && !(await page.isDisabled('#submit')), text);
  await ctx.close();
}
for (const [state, expect] of [['confirmed', 'Your email is confirmed'], ['unsubscribed', 'You have been unsubscribed'], ['invalid', 'invalid or expired'], ['error', 'could not complete that request'], ['bogus', '']]) {
  const { page, ctx } = await openPage({ width: 1280, query: `?waitlist=${state}#early-access` });
  const text = await page.textContent('#status');
  const inView = await page.evaluate(() => { const r = document.getElementById('early-access').getBoundingClientRect(); return r.top < window.innerHeight && r.bottom > 0; });
  check(`redirect status ?waitlist=${state}`, expect ? text.includes(expect) && inView : text === '', text || '(no message)');
  await ctx.close();
}
{
  const { page, ctx } = await openPage({ width: 1280, configOverride: 'window.TURNLINE_CONFIG={apiUrl:"",turnstileSiteKey:""};' });
  await page.fill('#email', 'pilot@example.com');
  await page.check('#consent');
  await page.click('#submit');
  check('rollback config (empty apiUrl) shows "Signups are not open yet" and loads no CAPTCHA', (await page.textContent('#status')).includes('not open yet') && !(await page.evaluate(() => [...document.scripts].some((s) => s.src.includes('turnstile')))));
  await ctx.close();
}

// ---------- 5b. email confirmation and unsubscribe pages (/confirm, /unsubscribe) ----------
{
  const ID = '6b1f0c2e-4d5a-4e8b-9f3c-2a7d1e5b8c40';
  const CTOKEN = 'a'.repeat(36) + 'b'.repeat(36);
  const UTOKEN = 'c'.repeat(64);
  const hash = (page, token) => `${page}#id=${ID}&token=${token}`;
  for (const name of ['confirm', 'unsubscribe']) {
    const src = await readFile(join(root, `${name}.html`), 'utf8');
    check(`/${name}: noindex, no-referrer meta, no inline script or style (strict CSP compatible)`, src.includes('<meta name="robots" content="noindex,nofollow">') && src.includes('<meta name="referrer" content="no-referrer">') && !/<script(?![^>]*\bsrc=)[^>]*>/i.test(src) && !/\sstyle="/i.test(src) && !/<style/i.test(src));
  }
  const headers = await readFile(join(root, '_headers'), 'utf8');
  const block = (path) => (headers.split(/\n(?=\/)/).find((b) => b.startsWith(path + '\n')) || '');
  check('_headers: token pages get no-store, no-referrer and an enforced CSP limited to self + the waitlist function', ['/confirm', '/confirm.html', '/unsubscribe', '/unsubscribe.html'].every((p) => { const b = block(p); return /Cache-Control: no-store/.test(b) && /Referrer-Policy: no-referrer/.test(b) && /Content-Security-Policy: default-src 'none'; script-src 'self';[^\n]*connect-src https:\/\/itapyrwjijnvzdsatttp\.supabase\.co;[^\n]*form-action 'none'/.test(b); }));

  // Opening the page changes nothing; the token leaves the address bar.
  {
    const { page, ctx, log } = await openPage({ width: 1280, query: hash('confirm', CTOKEN) });
    await page.waitForTimeout(300);
    const state = await page.evaluate(() => [location.href, document.getElementById('verify-button').disabled, document.body.innerHTML]);
    check('/confirm: opening the link sends nothing (scanner prefetch is harmless) and removes the token from the URL', log.apiCalls.length === 0 && !state[0].includes('token') && !state[0].includes('#') && state[1] === false && !state[2].includes('bbbbbbbb'), state[0]);
    check('/confirm: Cloudflare-style clean URL serves the page with no console errors or external requests', log.errors.length === 0 && log.external.length === 0 && (await page.title()).includes('Confirm'), log.errors.concat(log.external).join(' | '));
    await ctx.close();
  }
  for (const [label, api, expect, tone] of [
    ['confirmed', () => ({ status: 200, body: '{"status":"confirmed"}' }), 'Your email is confirmed', 'ok'],
    ['already confirmed', () => ({ status: 200, body: '{"status":"already_confirmed"}' }), 'already confirmed', 'ok'],
    ['invalid or expired', () => ({ status: 400, body: '{"error":"invalid_or_expired"}' }), 'invalid or has expired', 'warn'],
  ]) {
    const { page, ctx, log } = await openPage({ width: 390, height: 844, query: hash('confirm', CTOKEN), api });
    await page.click('#verify-button');
    await page.waitForFunction(() => document.getElementById('verify-status').textContent.length > 0);
    const call = log.apiCalls[0] || {};
    const body = JSON.parse(call.body || '{}');
    const ui = await page.evaluate(() => [document.getElementById('verify-status').textContent, document.getElementById('verify-status').dataset.tone, document.getElementById('verify-button').hidden]);
    check(`/confirm: explicit click → one JSON POST {action, id, token} without Referer → "${label}" shown`, log.apiCalls.length === 1 && call.method === 'POST' && call.url === API_URL && call.headers['content-type'] === 'application/json' && !call.headers.referer && body.action === 'confirm' && body.id === ID && body.token === CTOKEN && Object.keys(body).length === 3 && ui[0].includes(expect) && ui[1] === tone && ui[2] === true, ui[0]);
    await ctx.close();
  }
  {
    let n = 0;
    const { page, ctx, log } = await openPage({ width: 1280, query: hash('confirm', CTOKEN), api: () => (n++ === 0 ? { status: 503, body: '{"error":"temporarily_unavailable"}' } : { status: 200, body: '{"status":"confirmed"}' }) });
    await page.click('#verify-button');
    await page.waitForFunction(() => document.getElementById('verify-status').dataset.tone === 'error');
    const retryable = await page.evaluate(() => [document.getElementById('verify-button').disabled, document.getElementById('verify-button').hidden, document.getElementById('verify-status').textContent]);
    await page.click('#verify-button');
    await page.waitForFunction(() => document.getElementById('verify-status').dataset.tone === 'ok');
    check('/confirm: a server error says nothing changed and allows a retry, which then succeeds', retryable[0] === false && retryable[1] === false && retryable[2].includes('nothing has been changed') && log.apiCalls.length === 2, retryable[2]);
    await ctx.close();
  }
  for (const [label, q] of [['no token', 'confirm'], ['malformed token', `confirm#id=${ID}&token=short`], ['bad id', `confirm#id=x&token=${CTOKEN}`], ['legacy query string', `confirm?id=${ID}&token=${CTOKEN}`]]) {
    const { page, ctx, log } = await openPage({ width: 1280, query: q });
    await page.waitForTimeout(200);
    const ui = await page.evaluate(() => [document.getElementById('verify-status').textContent, document.getElementById('verify-button').hidden, location.href]);
    check(`/confirm with ${label}: explains the problem, offers no button, sends nothing, URL cleaned`, ui[0].includes('incomplete or damaged') && ui[1] === true && log.apiCalls.length === 0 && !ui[2].includes('token'), ui[0].slice(0, 80));
    await ctx.close();
  }
  {
    const { page, ctx, log } = await openPage({ width: 1280, query: hash('confirm', CTOKEN), configOverride: 'window.TURNLINE_CONFIG={apiUrl:"",turnstileSiteKey:""};' });
    await page.waitForTimeout(200);
    check('/confirm with signups rolled back (empty apiUrl): says unavailable, nothing sent', (await page.textContent('#verify-status')).includes('temporarily unavailable') && log.apiCalls.length === 0);
    await ctx.close();
  }
  {
    const { page, ctx, log } = await openPage({ width: 1280, query: hash('unsubscribe', UTOKEN), api: () => ({ status: 200, body: '{"status":"unsubscribed"}' }) });
    await page.waitForTimeout(200);
    const before = log.apiCalls.length;
    await page.click('#verify-button');
    await page.waitForFunction(() => document.getElementById('verify-status').dataset.tone === 'ok');
    const body = JSON.parse(log.apiCalls[0]?.body || '{}');
    check('/unsubscribe: opening sends nothing; explicit click POSTs {action:"unsubscribe", id, token} and confirms', before === 0 && log.apiCalls.length === 1 && body.action === 'unsubscribe' && body.id === ID && body.token === UTOKEN && (await page.textContent('#verify-status')).includes('You are unsubscribed') && !(await page.evaluate(() => location.href)).includes('token'));
    await ctx.close();
  }
  {
    const { page, ctx, log } = await openPage({ width: 1280, query: hash('unsubscribe', UTOKEN), api: () => ({ status: 400, body: '{"error":"invalid_or_expired"}' }) });
    await page.click('#verify-button');
    await page.waitForFunction(() => document.getElementById('verify-status').textContent.length > 0);
    check('/unsubscribe: an invalid link is reported with a support route', (await page.textContent('#verify-status')).includes('support@turnlineops.com') && log.apiCalls.length === 1);
    await ctx.close();
  }
  {
    // Serve /confirm with the production CSP from _headers (the local server does not apply _headers).
    const csp = /\/confirm\n[^/]*?Content-Security-Policy: ([^\n]+)/.exec(headers)[1];
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const violations = [];
    page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()); });
    let posted = 0;
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.startsWith(`${BASE}/confirm`)) { const r = await route.fetch(); return route.fulfill({ response: r, headers: { ...r.headers(), 'content-security-policy': csp } }); }
      if (url.startsWith(BASE)) return route.continue();
      if (API_URL && url.startsWith(API_URL)) { posted++; return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': BASE }, body: '{"status":"confirmed"}' }); }
      return route.abort();
    });
    await page.goto(`${BASE}/${hash('confirm', CTOKEN)}`, { waitUntil: 'load' });
    const styled = await page.evaluate(() => getComputedStyle(document.querySelector('.verify-card')).borderRadius !== '0px');
    await page.click('#verify-button');
    await page.waitForFunction(() => document.getElementById('verify-status').dataset.tone === 'ok');
    check('/confirm under the enforced production CSP: styles and script load, the POST is allowed, no violations', styled && posted === 1 && violations.length === 0, violations.join(' | '));
    await ctx.close();
  }
  for (const name of ['confirm', 'unsubscribe']) {
    const { page, ctx, log } = await openPage({ width: 1280, js: false, query: hash(name, name === 'confirm' ? CTOKEN : UTOKEN) });
    const noscript = await page.evaluate(() => document.querySelector('noscript') ? document.querySelector('noscript').textContent : '');
    check(`/${name} without JavaScript: explains that nothing changed and how to recover; the button stays disabled`, (await page.locator('noscript').count()) === 1 && /nothing has been changed/.test(await page.content()) && (await page.isDisabled('#verify-button')) && log.apiCalls.length === 0, noscript.slice(0, 60));
    await ctx.close();
    for (const width of [320, 768]) {
      const r = await openPage({ width, query: hash(name, name === 'confirm' ? CTOKEN : UTOKEN) });
      const [sw, iw] = await r.page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
      check(`/${name}: no horizontal scroll at ${width}px`, sw <= iw, `scrollWidth ${sw}, viewport ${iw}`);
      await r.ctx.close();
    }
  }
}

// ---------- 6. optional: real Cloudflare Turnstile with the public always-pass TEST key ----------
if (liveTurnstile) {
  const { page, ctx, log } = await openPage({ width: 1280, realTurnstile: true, configOverride: `window.TURNLINE_CONFIG={apiUrl:${JSON.stringify(API_URL)},turnstileSiteKey:"1x00000000000000000000AA"};` });
  try {
    await page.waitForFunction(() => document.querySelector('#turnstile iframe') || document.querySelector('#turnstile [name="cf-turnstile-response"]'), null, { timeout: 20000 });
    await page.waitForFunction(() => document.querySelector('[name="cf-turnstile-response"]')?.value?.length > 0, null, { timeout: 20000 });
    await page.fill('#email', 'pilot@example.com');
    await page.check('#consent');
    await page.click('#submit');
    await page.waitForFunction(() => document.getElementById('status').textContent.length > 0);
    check('live Turnstile (Cloudflare test key): widget initialises, token submitted', log.apiCalls.length === 1 && JSON.parse(log.apiCalls[0].body).captcha.length > 10, `token length ${JSON.parse(log.apiCalls[0]?.body || '{"captcha":""}').captcha.length}`);
  } catch (e) {
    check('live Turnstile (Cloudflare test key): widget initialises, token submitted', false, String(e).slice(0, 160));
  }
  await ctx.close();
}

await browser.close();
server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (outDir) await (await import('node:fs/promises')).writeFile(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
