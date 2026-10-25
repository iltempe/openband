// The social previews of www.openband.it (Open Graph / Twitter cards, 1200×630): scripts/og/card.html with
// the studio's screenshot, rendered in Chrome to docs/og-card.png and docs/og-contribute.png.
// Run after a new studio screenshot: node scripts/build-og.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chrome =
  process.env.CHROME ??
  ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
if (!chrome) throw new Error('No Chrome found: set CHROME');

const dataUrl = (file, type) => `data:${type};base64,${fs.readFileSync(path.join(root, file)).toString('base64')}`;
const html = fs
  .readFileSync(path.join(root, 'scripts/og/card.html'), 'utf8')
  .replace('__STUDIO__', dataUrl('docs/studio.png', 'image/png'))
  .replace('__ICON__', dataUrl('public/icon.svg', 'image/svg+xml'));
const tmp = path.join(root, 'build', 'og-card.html');
fs.mkdirSync(path.dirname(tmp), { recursive: true });
fs.writeFileSync(tmp, html);

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
  for (const [query, out] of [
    ['', 'docs/og-card.png'],
    ['?page=contribute', 'docs/og-contribute.png'],
  ]) {
    await page.goto(`${pathToFileURL(tmp).href}${query}`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(root, out), clip: { x: 0, y: 0, width: 1200, height: 630 } });
    console.log(`✓ ${out}`);
  }
} finally {
  await browser.close();
  fs.rmSync(tmp, { force: true });
}
