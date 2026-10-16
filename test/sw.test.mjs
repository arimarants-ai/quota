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
function browser({ refuse = [], net = async () => ({ ok: true }) } = {}) {
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
  const ctx = vm.createContext({ self, caches, fetch: (...a) => net(...a), console, URL, Response: class { constructor(body) { this.body = body; this.ok = false; } },
    navigator: { userAgent: '' }, setTimeout, clearTimeout });
  ctx.globalThis = ctx;
  vm.runInContext(SRC, ctx);
  const fire = async (type) => {
    const waits = [];
    for (const fn of handlers[type] || []) fn({ waitUntil: p => waits.push(p) });
    await Promise.all(waits);
  };
  // A page load, the way the browser asks for one: what the worker answered with.
  const navigate = async () => {
    let answer;
    for (const fn of handlers.fetch || []) fn({ request: { method: 'GET', url: 'https://example.test/', mode: 'navigate' },
      respondWith: p => { answer = p; }, waitUntil() {} });
    return answer;
  };
  return { stores, caches, fire, navigate, version: /const VERSION = '([^']+)'/.exec(SRC)[1],
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

// A slow connection is not an offline one: it never fails, it crawls. The page has to come
// from the copy already here after a few seconds, not whenever the network gets round to it.
{
  const fresh = { ok: true, which: 'network', clone: () => ({ ok: true, which: 'network' }) };
  const kept = { ok: true, which: 'kept' };
  const b = browser({ net: () => new Promise(r => setTimeout(() => r(fresh), 6000)) });
  (await b.caches.open(b.version)).put('/', kept);
  const t0 = Date.now(), res = await b.navigate(), took = Date.now() - t0;
  check('on a crawling connection the page comes from the kept copy within a few seconds',
    res && res.which === 'kept' && took < 4500, `${res && res.which} after ${took}ms`);

  const quick = browser({ net: async () => fresh });
  (await quick.caches.open(quick.version)).put('/', kept);
  const r2 = await quick.navigate();
  check('  while a connection that answers still gets the newest page', r2 && r2.which === 'network', r2 && r2.which);

  const none = browser({ net: () => new Promise(r => setTimeout(() => r(fresh), 200)) });
  const r3 = await none.navigate();
  check('  and with nothing kept yet it waits for the network rather than giving up', r3 && r3.which === 'network', r3 && r3.which);
}

// 5. Clips stream straight from R2. Kept here, a clip had to be downloaded whole before the
// player saw a byte of it, and when that failed the hand-back to the network went black on
// phones. Nothing from R2 is touched, and the old kept clips are cleared on update.
{
  const handlers = {};
  const self = { addEventListener: (t, fn) => { (handlers[t] ||= []).push(fn); }, skipWaiting() {},
    clients: { async claim() {} }, location: { origin: 'https://app.example.test' }, registration: {} };
  const caches = { async open() { return { match: async () => ({}), add: async () => {}, put: async () => {} }; },
    async keys() { return ['quota-media', 'quota-v1']; }, async delete() {} };
  const ctx = vm.createContext({ self, caches, fetch: async () => { throw new Error('no network'); }, console, URL, Response, Blob, navigator: { userAgent: '' } });
  vm.runInContext(SRC, ctx);

  let routed = 0;
  const ask = url => { for (const fn of handlers.fetch) fn({ request: { method: 'GET', url, mode: 'no-cors', headers: new Headers({ range: 'bytes=0-1' }) }, respondWith() { routed++; } }); };
  ask('https://acct.r2.cloudflarestorage.com/quota-proof/7/u/1.mp4?X-Amz-Signature=aaa');
  check('a clip on R2 goes straight to the player', routed === 0);
  ask('https://acct.r2.cloudflarestorage.com/quota-proof/7/u/1.mp4.jpg');
  check('  and so does its still', routed === 0);
  ask('https://txvjakpeyfnzigtsvmja.supabase.co/storage/v1/object/sign/proof/1.mov');
  check('  and a clip still on Supabase', routed === 0);

  const gone = [];
  caches.delete = async k => { gone.push(k); return true; };
  const waits = [];
  for (const fn of handlers.activate || []) fn({ waitUntil: p => waits.push(p) });
  await Promise.all(waits);
  check('an update clears the clips the old worker kept', gone.includes('quota-media') && gone.includes('quota-v1'), gone.join(', '));
}

console.log(failed ? `\nFAIL: ${failed} check(s)` : '\nPASS: the worker never leaves an app with nothing to start from');
process.exit(failed ? 1 : 0);
