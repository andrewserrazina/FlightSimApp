// Renders docs/marketing/og-card.html to marketing/assets/og-image.png (1200x630) with Playwright's Chromium.
//   node scripts/marketing-og-image.mjs
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.goto(pathToFileURL(join(root, 'docs/marketing/og-card.html')).href);
await page.screenshot({ path: join(root, 'marketing/assets/og-image.png') });
await browser.close();
console.log('wrote marketing/assets/og-image.png');
