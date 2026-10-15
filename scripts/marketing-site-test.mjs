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
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };
const served = new Map();
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = join(root, path.endsWith('/') ? path + 'index.html' : path);
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
  check('no third-party logos or images (plain-text provider names only)', !/<img\b/i.test(html), 'no <img> elements');
}

// ---------- 2. layout, resources, console ----------
for (const width of [320, 390, 768, 1024, 1280, 1440]) {
  const { page, ctx, log } = await openPage({ width, height: 900 });
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  check(`no horizontal scroll at ${width}px`, sw <= iw, `scrollWidth ${sw}, viewport ${iw}`);
  if (outDir && [390, 1440].includes(width)) await page.screenshot({ path: join(outDir, `full-${width}.png`), fullPage: true });
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
  for (const id of ['top', 'platform', 'how', 'features', 'different', 'scenario', 'integrations', 'roadmap', 'faq', 'early-access']) {
    if (!(await page.locator('#' + id).count())) check(`section #${id} exists`, false);
  }
  check('all ten sections A–J plus footer present', (await page.locator('#top, #platform, #how, #features, #different, #scenario, #integrations, #roadmap, #faq, #early-access, footer').count()) === 11);
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
  check('feature statuses use only the four defined labels', statusWords.every((w) => ['Implemented internally', 'In active development', 'Planned', 'Research'].includes(w)), statusWords.join(', '));

  await page.click('.view-toggle button[data-view="planned"]');
  const plannedHidden = await page.locator('.timeline .tl-alert').isHidden();
  await page.click('.view-toggle button[data-view="operated"]');
  check('scenario toggle switches between planned and operated views', plannedHidden && (await page.locator('.timeline .tl-alert').isVisible()) && (await page.locator('.view-toggle button[data-view="operated"]').getAttribute('aria-pressed')) === 'true');
  check('concept visuals are labelled as concepts', (await page.locator('.concept-tag').count()) >= 3 && (await page.evaluate(() => [...document.querySelectorAll('[aria-label]')].filter((e) => /not live software/i.test(e.getAttribute('aria-label'))).length)) === 1);

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
  check('submit: success message, form reset, Turnstile reset, button restored', (await page.inputValue('#email')) === '' && !(await page.isChecked('#consent')) && (await page.evaluate(() => window.__resets)) >= 1 && (await page.textContent('#submit')) === 'Join the Turnline Waitlist');
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
