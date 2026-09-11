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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
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

console.log(failed ? `\nFAIL: ${failed} check(s)` : '\nPASS: the worker never leaves an app with nothing to start from');
process.exit(failed ? 1 : 0);
