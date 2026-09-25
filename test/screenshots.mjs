// node test/screenshots.mjs    regenerate the manifest screenshots
//
// The four screenshots Chrome and PWABuilder show on the install prompt, rendered from
// the real app at 1284x2778 with the same Supabase stub the boot test uses. The data is
// an example, not anybody's account: a fortnight of history so the streak reads as what
// the app is for, and a flat placeholder where somebody's proof would be.
//
// A screenshot taken on a real phone, of a real run, beats this every time. This exists
// so the listing can never be left showing a version of the app that no longer exists.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
const STUB = await readFile(join(ROOT, '../test/stub-supabase.js'), 'utf8');
const LIB = '**/vendor/supabase-js-2.49.4/supabase.js';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  try {
    const body = await readFile(join(ROOT, p));
    res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
// The camera shot needs a fake capture device, which the headless shell does not carry.
const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];
const browser = await chromium.launch({ channel: 'chromium', args })
  .catch(() => chromium.launch({ args }));

// A run with some history behind it, so the screenshot shows what the app is for rather
// than what it looks like on the day you install it.
const seed = `(() => {
  const d = n => { const x = new Date(); x.setDate(x.getDate() - n); return x.toLocaleDateString('en-CA'); };
  for (let i = 1; i < 14; i++) S.totals.push({g: 1, u: 'u1', d: d(i), m: 'pushups', n: 50});
  notNowPush();   // a permission ask is not what the app is for
  const c = document.createElement('canvas'); c.width = 900; c.height = 1125;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 900, 1125);
  g.addColorStop(0, '#0b2018'); g.addColorStop(.55, '#123c28'); g.addColorStop(1, '#061014');
  x.fillStyle = g; x.fillRect(0, 0, 900, 1125);
  x.globalAlpha = .07; x.fillStyle = '#2fd36f';
  for (let i = 0; i < 90; i++) { const r = 20 + Math.random() * 160;
    x.beginPath(); x.arc(Math.random() * 900, Math.random() * 1125, r, 0, 7); x.fill(); }
  const url = c.toDataURL('image/jpeg', .9);
  for (const p of S.posts) { p.path = p.path.replace(/\\.mp4$/, '.jpg'); p.url = url; }
  render();
})()`;

async function shot(name, mode, body) {
  const ctx = await browser.newContext({
    viewport: { width: 428, height: 926 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
  });
  const page = await ctx.newPage();
  page.on('dialog', d => d.dismiss());
  await page.route(LIB, r => r.fulfill({ contentType: 'text/javascript', body: STUB }));
  await page.addInitScript(m => { self.__MODE = m; }, mode);
  await page.goto(`${base}/?local`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  await page.evaluate(seed);
  await page.waitForTimeout(400);
  if (body) await body(page);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(ROOT, name) });
  console.log('wrote', name);
  await ctx.close();
}

const SIGNED_IN = { session: { user: { id: 'u1' } } };
const NO_WHEEL = { ...SIGNED_IN, wheel: false };

await shot('screenshot-feed.png', SIGNED_IN);
await shot('screenshot-group.png', SIGNED_IN, async page => {
  await page.evaluate(() => openGroup(1));
  await page.waitForTimeout(300);
});
await shot('screenshot-post.png', NO_WHEEL, async page => {
  await page.locator('.bar .add').click();
  await page.waitForTimeout(400);
});
await shot('screenshot-camera.png', NO_WHEEL, async page => {
  await page.locator('.bar .add').click();
  await page.waitForTimeout(300);
  await page.locator('#dlg button:has-text("Record")').click();
  await page.waitForTimeout(1500);
});

await browser.close();
server.close();
console.log('done');
