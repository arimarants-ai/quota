// node test/numbers.test.mjs
//
// The private numbers page (site/n/<path>/): posts and people, live, at an address nobody
// is told. It is a page on its own with no library, so it is driven here on its own,
// against a stand-in for the one Supabase endpoint it asks. What matters: the numbers are
// there straight away, they keep themselves up to date, it asks nothing while out of
// sight, and a dropped connection neither blanks the page nor stops it for good.
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = readdirSync(join(ROOT, 'site', 'n'))[0];
const HTML = readFileSync(join(ROOT, 'site', 'n', DIR, 'index.html'), 'utf8');
const SB = 'https://txvjakpeyfnzigtsvmja.supabase.co';

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) failed++;
};

const server = createServer((req, res) => { res.writeHead(200, {'content-type': 'text/html'}); res.end(HTML); });
await new Promise(r => server.listen(0, r));
const PAGE = `http://127.0.0.1:${server.address().port}/n/${DIR}/`;
const browser = await chromium.launch();

// The stand-in for the one endpoint the page uses. `stats` is what quota_numbers answers,
// and a case can change it to watch the page follow.
function backend(page, {schema = true, down = false} = {}) {
  const st = {stats: {posts_total: 1200, posts_today: 14, posters_today: 9, users_total: 87, users_new_today: 2, active_today: 31, active_now: 4},
    calls: 0, down};
  page.route(`${SB}/**`, async r => {
    const u = new URL(r.request().url()), body = JSON.parse(r.request().postData() || '{}');
    const json = (status, data) => r.fulfill({status, contentType: 'application/json', body: JSON.stringify(data)});
    if (u.pathname !== '/rest/v1/rpc/quota_numbers') return json(404, {});
    st.calls++;
    if (st.down) return r.abort();
    if (!schema) return json(404, {code: 'PGRST202', message: 'Could not find the function public.quota_numbers'});
    st.since = body.p_since;
    return json(200, st.stats);
  });
  return st;
}
const nums = page => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.n')].map(n => [n.dataset.k, n.querySelector('b').textContent])));

{
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}});
  const page = await ctx.newPage();
  const st = backend(page);
  await page.goto(PAGE);
  await page.waitForSelector('.n');
  const n = await nums(page);
  check('the page shows the four numbers straight away, no sign-in',
    n.posts_today === '14' && n.posts_total === '1,200' && n.active_today === '31' && n.users_total === '87', JSON.stringify(n));
  const txt = await page.innerText('main');
  check('  with who posted, who is on now and who joined today', /by 9 people/.test(txt) && /4 in the app right now/.test(txt) && /2 joined today/.test(txt), txt);
  check('  and that it is live', /Live · updated/.test(txt));
  check('  counted from midnight where the viewer is', st.since === await page.evaluate(() => midnight()), st.since);
  check('  and tells search engines to keep away', /noindex/.test(await page.getAttribute('meta[name=robots]', 'content')));

  st.stats = {...st.stats, posts_today: 15, posts_total: 1201, active_now: 5};
  await page.waitForTimeout(4600);
  const m = await nums(page);
  check('a post that lands while it is open shows up by itself', m.posts_today === '15' && m.posts_total === '1,201', JSON.stringify(m));
  check('  and the numbers that moved light up', await page.locator('.n.bump').count() === 2);

  // Out of sight, it asks nothing; back in front, it asks at once.
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', {configurable: true, get: () => true}); });
  await page.waitForTimeout(500);
  const before = st.calls;
  await page.waitForTimeout(4600);
  check('in the background it asks for nothing', st.calls === before, `${before} -> ${st.calls}`);
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(400);
  check('  and asks at once when it is back', st.calls > before);

  // The connection dropping keeps the last numbers up and says so; coming back, it carries on.
  st.down = true;
  await page.waitForTimeout(4600);
  check('a dropped connection keeps the last numbers and says it is reconnecting',
    (await nums(page)).posts_today === '15' && /Reconnecting/.test(await page.innerText('#live')));
  st.down = false;
  await page.waitForTimeout(4600);
  check('  and it carries on when the connection is back', /Live · updated/.test(await page.innerText('#live')));
  await ctx.close();
}

// Before the database part is run, it says so rather than spinning.
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  backend(page, {schema: false});
  await page.goto(PAGE);
  await page.waitForTimeout(800);
  check('without the database part it says it is not switched on yet', /Not switched on yet/.test(await page.innerText('#live')));
  await ctx.close();
}

await browser.close();
server.close();
if (failed) { console.log(`\nFAIL: ${failed} check(s)`); process.exit(1); }
console.log('\nPASS: the numbers keep up');
