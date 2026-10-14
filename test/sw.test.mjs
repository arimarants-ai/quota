// node test/sw.test.mjs
//
// The service worker runs where nothing else in this repo does, and the way it can fail
// is invisible until somebody's installed app will not start: it precaches best-effort,
// so a bad moment on the network leaves a version short, and if the previous version has
// already been deleted there is no copy of the library anywhere. The page then loads, the
// import it cannot start without is missing, and all anyone sees is "Load failed".
//
// So sw.js is run here against a stand-in for the browser's cache and network.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
const SRC = readFileSync(join(ROOT, 'sw.js'), 'utf8');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
  if (!ok) failed++;
};

// A cache that remembers what was put in it, and a network that can be told to refuse.
function browser({ refuse = [] } = {}) {
  const stores = new Map();
  const cache = name => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return {
      async match(req) { return m.get(String(req.url || req)) || undefined; },
      async put(req, res) { m.set(String(req.url || req), res); },
      async add(url) {
        if (refuse.includes(url)) throw new Error('network');
        m.set(url, { ok: true, url, clone: () => ({ ok: true, url }) });
      },
    };
  };
  const caches = {
    async open(name) { return cache(name); },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async match(req) {
      for (const m of stores.values()) { const hit = m.get(String(req.url || req)); if (hit) return hit; }
      return undefined;
    },
  };
  const handlers = {};
  const self = {
    addEventListener: (t, fn) => { (handlers[t] ||= []).push(fn); },
    skipWaiting() {}, clients: { async claim() {}, async matchAll() { return []; } },
    location: { origin: 'https://example.test' },
    caches, registration: { showNotification() {} },
  };
  const ctx = vm.createContext({ self, caches, fetch: async () => ({ ok: true }), console, URL, Response: class {}, navigator: { userAgent: '' } });
  ctx.globalThis = ctx;
  vm.runInContext(SRC, ctx);
  const fire = async (type) => {
    const waits = [];
    for (const fn of handlers[type] || []) fn({ waitUntil: p => waits.push(p) });
    await Promise.all(waits);
  };
  return { stores, caches, fire, version: /const VERSION = '([^']+)'/.exec(SRC)[1],
    precache: JSON.parse(`[${/const PRECACHE = \[([\s\S]*?)\];/.exec(SRC)[1].replace(/'/g, '"').replace(/,\s*$/, '')}]`) };
}

// 1. The ordinary case: everything caches, the old version goes.
{
  const b = browser();
  b.stores.set('quota-old', new Map([['/old', {}]]));
  await b.fire('install');
  await b.fire('activate');
  const now = await b.caches.keys();
  check('a clean install caches everything it needs',
    b.precache.every(u => b.stores.get(b.version).has(u)),
    [...b.stores.get(b.version).keys()].join(', '));
  check('  and the previous version is cleared away', !now.includes('quota-old'), now.join(', '));
}

// 2. The one that breaks installed apps: the network drops a file during install.
{
  const gone = '/vendor/supabase-js-2.49.4/591.supabase.js';
  const b = browser({ refuse: [gone] });
  b.stores.set('quota-old', new Map([[gone, { ok: true, url: gone }]]));
  await b.fire('install');
  const short = !b.stores.get(b.version).has(gone);
  check('a file that would not download leaves this version short', short);
  await b.fire('activate');
  const now = await b.caches.keys();
  check('  so the previous version is kept, not deleted', now.includes('quota-old'), now.join(', '));
  check('  and the file is still findable somewhere', !!await b.caches.match(gone));
}

// 3. Activate repairs what install could not get, and then tidies up.
{
  const late = '/icon-512.png';
  const b = browser({ refuse: [late] });
  b.stores.set('quota-old', new Map([['/old', {}]]));
  await b.fire('install');
  b.refuse = [];                                  // the network comes back
  const b2 = b;
  // Re-running activate with a working network is what a later launch does.
  const fixed = browser();
  fixed.stores.set(b2.version, b2.stores.get(b2.version));
  fixed.stores.set('quota-old', new Map([['/old', {}]]));
  await fixed.fire('activate');
  check('a later launch fills in what was missed', fixed.stores.get(fixed.version).has(late));
  check('  and only then lets the old copy go', !(await fixed.caches.keys()).includes('quota-old'));
}

// 4. A file whose name does not change between releases — the manifest, an icon — must
// not be answered out of a superseded cache. caches.match() searches every one of them,
// so asking it outright serves the old copy for as long as that cache survives.
{
  const b = browser();
  const stale = { ok: true, url: '/manifest.json', stale: true, clone: () => ({ ok: true }) };
  b.stores.set('quota-old', new Map([['/manifest.json', stale]]));
  await b.fire('install');
  const fresh = await b.stores.get(b.version).get('/manifest.json');
  const req = { url: '/manifest.json', method: 'GET', mode: 'same-origin' };
  check('this version answers with its own copy, not one left behind',
    fresh && !fresh.stale, JSON.stringify(fresh));
  // And the old one is still reachable as a last resort when there is nothing else.
  check('  while the older copy is still there to fall back on when offline',
    !!await b.caches.match({ url: '/manifest.json' }));
  await b.fire('activate');
  check('  and once this version is complete, the old one is gone',
    !(await b.caches.keys()).includes('quota-old'), (await b.caches.keys()).join(', '));
}

// 5. A clip somebody watched is kept by its path on R2, whatever signature its URL had, and
// is served back in the pieces a player asks for. Safari opens every clip by asking for
// its first two bytes, and plays nothing at all unless exactly those come back as a 206.
{
  const store = new Map(), order = [];
  const media = {
    async match(k) { const r = store.get(String(k)); return r ? r.clone() : undefined; },
    async put(k, res) { store.set(String(k), res); order.push(String(k)); },
    async keys() { return order.filter(k => store.has(k)); },
    async delete(k) { return store.delete(String(k)); },
  };
  let downloads = 0;
  const bytes = new Uint8Array(1000).map((_, i) => i % 251);
  const fetchFake = async (url, init) => {
    downloads++;
    if (!init || init.mode !== 'cors') throw new Error('the clip should be fetched whole, with CORS');
    return new Response(bytes, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '1000' } });
  };
  const handlers = {};
  const self = { addEventListener: (t, fn) => { (handlers[t] ||= []).push(fn); }, skipWaiting() {},
    clients: { async claim() {} }, location: { origin: 'https://app.example.test' }, registration: {} };
  const caches = { async open() { return media; }, async keys() { return ['quota-media', 'quota-v1']; }, async delete() {} };
  const ctx = vm.createContext({ self, caches, fetch: fetchFake, console, URL, Response, Blob, navigator: { userAgent: '' } });
  vm.runInContext(SRC, ctx);
  const req = range => ({ method: 'GET', url: '', mode: 'no-cors', headers: new Headers(range ? { range } : {}) });
  const at = sig => new URL(`https://acct.r2.cloudflarestorage.com/quota-proof/7/u/1.mp4?X-Amz-Signature=${sig}`);

  const first = await ctx.watched(req('bytes=0-1'), at('aaa'));
  const two = new Uint8Array(await first.arrayBuffer());
  check('the first two bytes come back as a 206 of exactly two bytes',
    first.status === 206 && two.length === 2 && first.headers.get('content-range') === 'bytes 0-1/1000',
    `${first.status} ${first.headers.get('content-range')} ${two.length}`);
  const rest = await ctx.watched(req('bytes=500-'), at('bbb'));
  const tail = new Uint8Array(await rest.arrayBuffer());
  check('  a later range is the right bytes', rest.status === 206 && tail.length === 500 && tail[0] === bytes[500]);
  check('  and a second URL for the same clip did not download it again', downloads === 1, `${downloads} downloads`);
  const whole = await ctx.watched(req(null), at('ccc'));
  check('  asked for whole, it is the whole clip', whole.status === 200 && (await whole.arrayBuffer()).byteLength === 1000);
  const past = await ctx.watched(req('bytes=5000-'), at('ddd'));
  check('  and a range past the end is refused, not invented', past.status === 416);
  check('rangeOf reads the three shapes a player sends',
    JSON.stringify([ctx.rangeOf('bytes=0-1', 10), ctx.rangeOf('bytes=4-', 10), ctx.rangeOf('bytes=-3', 10), ctx.rangeOf('', 10)]) === '[[0,1],[4,9],[7,9],null]');

  // Updating the app clears the old version's files, not the clips.
  const gone = [];
  caches.delete = async k => { gone.push(k); return true; };
  caches.open = async () => ({ match: async () => ({}), add: async () => {}, put: async () => {} });
  const waits = [];
  for (const fn of handlers.activate || []) fn({ waitUntil: p => waits.push(p) });
  await Promise.all(waits);
  check('an update leaves the watched clips where they are', !gone.includes('quota-media') && gone.includes('quota-v1'), gone.join(', '));

  // Anything that is not an R2 clip is none of this code's business.
  let routed = 0;
  for (const fn of handlers.fetch) fn({ request: { method: 'GET', url: 'https://acct.r2.cloudflarestorage.com/quota-proof/7/u/1.mp4.jpg', mode: 'no-cors' }, respondWith() { routed++; } });
  check('a still is left to the browser', routed === 0);
  for (const fn of handlers.fetch) fn({ request: { method: 'GET', url: 'https://txvjakpeyfnzigtsvmja.supabase.co/storage/v1/object/sign/proof/1.mov', mode: 'no-cors' }, respondWith() { routed++; } });
  check('a clip still on Supabase is left to the network', routed === 0);
}

console.log(failed ? `\nFAIL: ${failed} check(s)` : '\nPASS: the worker never leaves an app with nothing to start from');
process.exit(failed ? 1 : 0);
