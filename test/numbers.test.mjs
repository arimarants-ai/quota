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
  await page.waitForFunction(() => document.querySelector('.n[data-k="posts"] b').textContent !== '–');
  const card = k => page.evaluate(k => { const el = document.querySelector(`.n[data-k="${k}"]`);
    return {n: el.querySelector('b').textContent, when: el.querySelector('.k em').textContent, sub: el.querySelector('.sub').textContent}; }, k);
  let p = await card('posts'), u = await card('users');
  check('it opens on today: posts today and users today, no sign-in',
    p.n === '14' && p.when === 'Today' && u.n === '31' && u.when === 'Today', JSON.stringify({p, u}));
  check('  with who posted today, and who is in the app right now', /by 9 people/.test(p.sub) && /4 in the app right now/.test(u.sub), JSON.stringify({p, u}));
  check('  and that it is live', /Live ·/.test(await page.innerText('#live')));
  check('  counted from midnight where the viewer is', st.since === await page.evaluate(() => midnight()), st.since);
  check('  on white, and leading nowhere on the website', await page.evaluate(() => getComputedStyle(document.body).backgroundColor) === 'rgb(255, 255, 255)'
    && await page.locator('a').count() === 0);
  check('  and tells search engines to keep away', /noindex/.test(await page.getAttribute('meta[name=robots]', 'content')));

  // Tapping a number turns that one over to all time, and back.
  await page.click('.n[data-k="posts"]');
  p = await card('posts'); u = await card('users');
  check('tapping posts shows posts all time, leaving users on today', p.n === '1,200' && p.when === 'All time' && u.when === 'Today', JSON.stringify({p, u}));
  await page.click('.n[data-k="users"]');
  u = await card('users');
  check('  and tapping users shows users all time, with who joined today', u.n === '87' && u.when === 'All time' && /2 joined today/.test(u.sub), JSON.stringify(u));
  check('  the switch at the top says all time once both are', await page.getAttribute('.seg [data-p="all"]', 'aria-pressed') === 'true');
  await page.click('.seg [data-p="today"]');
  p = await card('posts'); u = await card('users');
  check('  and Today turns both back', p.when === 'Today' && u.when === 'Today' && p.n === '14', JSON.stringify({p, u}));
  await page.click('.seg [data-p="all"]');
  p = await card('posts');
  check('  All time turns both over', p.when === 'All time' && (await card('users')).when === 'All time');

  st.stats = {...st.stats, posts_today: 15, posts_total: 1201, active_now: 5};
  await page.waitForTimeout(4600);
  p = await card('posts');
  check('a post that lands while it is open shows up by itself', p.n === '1,201' && /15 of them today/.test(p.sub), JSON.stringify(p));
  check('  and the number that moved lights up', await page.locator('.n.bump').count() === 1);

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
    (await card('posts')).n === '1,201' && /Reconnecting/.test(await page.innerText('#live')));
  st.down = false;
  await page.waitForTimeout(4600);
  check('  and it carries on when the connection is back', /Live ·/.test(await page.innerText('#live')));
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
