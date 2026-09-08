// npx playwright@1.56 install --with-deps chromium   (once)
// node test/boot.test.mjs
//
// One rule, and every check here is a way of breaking it: whatever goes wrong, the app
// must never end up showing an empty page. It used to. render() ran only on the last
// line of load(), so a failed query alerted "JWT expired" and left nothing behind, and
// an installed app hits that far more than a browser tab does — it opens with a token
// that expired days ago, often before the phone has a connection.
//
// The page runs for real, against test/stub-supabase.js in place of the library.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let chromium;
try { ({ chromium } = await import('playwright')); }
catch { console.log('SKIP: boot tests need playwright (npx playwright install --with-deps chromium)'); process.exit(0); }

const STUB = await readFile(join(HERE, 'stub-supabase.js'), 'utf8');
const LIB = '**/vendor/**/supabase.js';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

// Playwright's request interception suppresses xhr.upload.onprogress, so an upload
// answered by route.fulfill() reports nothing and would prove nothing. Instead the page
// is served with its SUPABASE_URL pointed back here, and this server answers the storage
// endpoint for real, so the upload runs the whole way through a real XHR.
let base = '';
let uploadReply = { status: 200, body: '{}', hold: null };
const server = createServer(async (req, res) => {
  let p = req.url.split(/[?#]/)[0];
  if (req.method === 'POST' && p.startsWith('/storage/v1/object/')) {
    req.on('data', () => {});
    req.on('end', async () => {
      if (uploadReply.hold) await uploadReply.hold;
      res.writeHead(uploadReply.status, { 'content-type': 'application/json' });
      res.end(uploadReply.body);
    });
    return;
  }
  if (p === '/') p = '/index.html';
  try {
    let body = await readFile(join(ROOT, p));
    if (p === '/index.html' && req.url.includes('local')) body = String(body).replace(/const SUPABASE_URL = '[^']+'/, `const SUPABASE_URL = '${base}'`);
    res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(r => server.listen(0, r));
base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) failed++;
};

// Every case gets a clean context: the app keeps its session in localStorage.
// With a mode, the stub is installed and the page is loaded ready to inspect. With null,
// the real library is used and the case navigates itself, so it can add routes first.
async function withPage(mode, body) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const alerts = [];
  page.on('dialog', d => { alerts.push(d.message()); d.dismiss(); });
  await page.addInitScript(() => {
    self.__btn = [];
    addEventListener('DOMContentLoaded', () => {
      new MutationObserver(() => {
        const b = document.querySelector('#dlg button.primary');
        if (b && self.__btn.at(-1) !== b.textContent) self.__btn.push(b.textContent);
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
  });
  await page.route('**fonts.googleapis.com**', r => r.abort());   // not reachable from CI either
  if (mode) {
    await page.route(LIB, r => r.fulfill({ contentType: 'text/javascript', body: STUB }));
    await page.addInitScript(m => { self.__MODE = m; }, mode);
    await page.goto(`${base}/?local`, { waitUntil: 'domcontentloaded' });
  }
  try { await body(page, alerts); } finally { await ctx.close(); }
}

const SIGNED_IN = { session: { user: { id: 'u1' } } };
const settle = p => p.waitForTimeout(700);

// The session read never coming back is the one that showed nothing at all: no alert to
// dismiss, no screen, no way to tell whether it was working.
await withPage({ hang: true }, async (page, alerts) => {
  await settle(page);
  check('a session read that never returns still shows a screen', (await page.innerHTML('#app')).includes('splash'));
  check('  and does not open a modal over it', alerts.length === 0, alerts.join(' | '));
});

// The exact bug that was reported: expired token, refresh cannot save it.
await withPage({ ...SIGNED_IN, queryError: 'JWT expired', refreshOk: false }, async (page, alerts) => {
  await settle(page);
  const html = await page.innerHTML('#app');
  check('an expired token that cannot be refreshed lands on sign-in', html.includes('auth'), `#app was ${html.length} chars`);
  check('  and never leaves a blank page', html.trim().length > 50);
  check('  and does not alert "JWT expired" first', alerts.length === 0, alerts.join(' | '));
});

// The same token, when a refresh does save it: the app should recover on its own.
await withPage({ ...SIGNED_IN, queryError: 'JWT expired', refreshOk: true }, async (page, alerts) => {
  await settle(page);
  check('an expired token that refreshes recovers into the app', await page.isVisible('#bar'));
  check('  with no error banner left behind', await page.isHidden('#err'));
  check('  and no modal', alerts.length === 0, alerts.join(' | '));
});

// Anything that is not an auth problem: say so, offer a way out, keep the app on screen.
await withPage({ ...SIGNED_IN, queryError: 'network is down' }, async (page, alerts) => {
  await settle(page);
  check('a failed load explains itself in the banner', (await page.innerText('#err')).includes('network is down'));
  check('  with a retry', await page.isVisible('#err button'));
  check('  and no modal', alerts.length === 0, alerts.join(' | '));
});

// No session at all: the sign-in screen, and not the splash it started on.
await withPage({ session: null }, async page => {
  await settle(page);
  const html = await page.innerHTML('#app');
  check('no session goes to the sign-in screen', html.includes('auth') && !html.includes('splash'));
});

// Resuming an installed app fires visibilitychange constantly; each one used to refetch
// every table in the database.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  const before = await page.evaluate(() => self.__calls.loads);
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => {
      for (const hidden of [true, false]) {
        Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      }
    });
  }
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => self.__calls.loads);
  check('resuming repeatedly does not refetch every time', after === before, `${before} -> ${after} loads`);
});

// The caption used to be hidden the moment playback started, along with the play button
// and the gradient. It is the one thing on that overlay worth reading while watching.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  const cap = page.locator('.reel .cap').first();
  check('a post shows its caption', await cap.isVisible() && (await cap.innerText()).includes('fifty in the bag'));
  await page.locator('.reel').first().evaluate(el => el.classList.add('playing'));
  check('  and keeps it once the video is playing', await cap.isVisible());
  // Native controls sit at the bottom of the video, so the caption has to move off them.
  const [reel, box] = await Promise.all([
    page.locator('.reel').first().boundingBox(),
    cap.boundingBox(),                                     // null once it is hidden
  ]);
  const clearance = box && reel ? reel.y + reel.height - (box.y + box.height) : -1;
  check('  clear of the native controls', clearance >= 40,
    box ? `only ${Math.round(clearance)}px above the bottom` : 'the caption is not on screen at all');
});

// A post with no caption should not leave an empty overlay floating over the video.
await withPage({ ...SIGNED_IN, noCaption: true }, async page => {
  await settle(page);
  check('a post without a caption still renders', await page.locator('.reel').count() === 1);
  check('  but with no empty caption overlay', await page.locator('.reel .ov.bot').count() === 0);
});

// Uploading a phone video is the longest thing the app does, and supabase-js sends it
// through fetch, which reports nothing at all. A motionless "Uploading…" is how a slow
// connection and a stuck one look identical.
async function submitProof(page) {
  await page.locator('.bar .add').click();
  await page.locator('#dlg input[name=amount]').fill('20');
  await page.locator('#dlg input[name=video]').setInputFiles({
    name: 'clip.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(4 * 1048576, 7),
  });
  await page.locator('#dlg button.primary').click();
}
const labels = page => page.evaluate(() => self.__btn);

await withPage(SIGNED_IN, async page => {
  await settle(page);
  let release;
  uploadReply = { status: 200, body: '{}', hold: new Promise(r => { release = r; }) };
  await submitProof(page);
  await page.waitForFunction(() => self.__btn.some(t => /Uploading… \d+%/.test(t)), null, { timeout: 5000 }).catch(() => {});
  const seen = await labels(page);
  check('the upload button reports a percentage', seen.some(t => /Uploading… \d+%/.test(t)), seen.join(' -> '));
  check('  and the progress bar fills', await page.locator('#uprog').evaluate(el => el.style.getPropertyValue('--w')) !== '');
  check('  and the size line counts MB sent', /of 4\.0 MB/.test(await page.locator('#vsize').textContent()),
    await page.locator('#vsize').textContent());
  release();
  await page.waitForTimeout(700);
  // dlg() closes the dialog but leaves its markup in place, so ask whether it is open.
  const open = await page.locator('#dlg').evaluate(d => d.open);
  check('  then posts and closes the dialog', (await labels(page)).includes('Posting…') && !open,
    `${(await labels(page)).join(' -> ')} | dialog open: ${open}`);
});

// A rejected upload has to repeat what the server said, not fail silently.
await withPage(SIGNED_IN, async (page, alerts) => {
  await settle(page);
  uploadReply = { status: 413, body: JSON.stringify({ message: 'The object exceeded the maximum allowed size' }), hold: null };
  await submitProof(page);
  await page.waitForTimeout(900);
  check('a rejected upload repeats the reason', alerts.some(a => a.includes('exceeded the maximum allowed size')), alerts.join(' | '));
  check('  and the form can be used again', await page.locator('#dlg button.primary').isEnabled());
  check('  and the progress bar is cleared away', await page.locator('#uprog').isHidden());
});
uploadReply = { status: 200, body: '{}', hold: null };

// The library can end a session without the app asking. The screen has to follow.
await withPage(SIGNED_IN, async page => {
  await settle(page);
  check('starts signed in', await page.isVisible('#bar'));
  await page.evaluate(() => self.__authCb('SIGNED_OUT', null));
  await page.waitForTimeout(200);
  check('  a sign-out from the library returns to the welcome screen',
    await page.isHidden('#bar') && (await page.innerHTML('#app')).includes('auth'));
});

// The library failing to arrive is what a blank page used to look like from the outside.
await withPage(null, async page => {
  await page.route(LIB, r => r.abort());
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  check('a missing library says so instead of showing nothing',
    (await page.innerHTML('#app')).includes('could not start'));
});

// And the real vendored library has to actually work, with Supabase unreachable.
await withPage(null, async page => {
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.route('**supabase.co**', r => r.abort());
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const html = await page.innerHTML('#app');
  check('the vendored library boots the page', !html.includes('could not start') && html.trim().length > 50);
  check('  with no uncaught errors', errs.length === 0, errs.join(' | '));
});

// The page's own self-check still passes.
await withPage(null, async page => {
  const logs = [];
  page.on('console', m => logs.push(`${m.type()}: ${m.text()}`));
  await page.route('**supabase.co**', r => r.abort());
  await page.goto(`${base}/#test`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  check('the #test self-check passes', logs.some(l => l.includes('self-check ok')) && !logs.some(l => /assert/i.test(l)),
    logs.join(' | '));
});

await browser.close();
server.close();
if (failed) { console.log(`\nFAIL: ${failed} check(s)`); process.exit(1); }
console.log('\nPASS: the app always shows something');
