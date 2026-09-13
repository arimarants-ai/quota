// node test/static.test.mjs            check the page and the service worker agree
// node test/static.test.mjs --update   accept the current precached files as the new baseline
//
// These are the mistakes that broke the installed app once and would not show up in a
// browser tab, so nothing here needs a browser either. See test/boot.test.mjs for the
// behaviour these files are supposed to have.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(join(ROOT, f), 'utf8');
const html = read('index.html');
const sw = read('sw.js');

const PRECACHE = JSON.parse(`[${sw.match(/const PRECACHE = \[([\s\S]*?)\];/)[1].replace(/'/g, '"').replace(/,\s*$/, '')}]`);
const VERSION = sw.match(/const VERSION = '([^']+)'/)[1];
const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1]);

// 1. Nothing the page cannot start without may come from someone else's server.
// The app used to load supabase-js from a CDN. An installed app is regularly opened
// before the phone has a connection, and every line of index.html depends on that file:
// when it did not arrive the page came up blank with no message at all.
for (const src of scripts) {
  assert.ok(!/^(https?:)?\/\//.test(src), `index.html loads ${src} from another origin. Vendor it under vendor/ instead: an installed app cannot rely on reaching a CDN at launch.`);
}

// 2. Everything the page asks for has to exist, and has to survive being offline.
for (const src of scripts) {
  assert.ok(existsSync(join(ROOT, src)), `index.html loads ${src}, which is not in the repo`);
  assert.ok(PRECACHE.includes(src), `${src} is not in PRECACHE in sw.js. The app cannot start without it, so it must be cached before it is needed.`);
}
for (const p of PRECACHE) {
  if (p === '/') continue;                                 // served as index.html
  assert.ok(existsSync(join(ROOT, p)), `sw.js precaches ${p}, which is not in the repo. It would fail to cache and the app would have nothing to fall back on offline.`);
}

// 2b. The page has to know which build it is. A fault that only happens on somebody's
// phone is unfixable without knowing what they are running, and the only way to be sure
// the two never drift is to check them against each other here.
const BUILD = (html.match(/const BUILD = '([^']+)'/) || [])[1];
assert.equal(BUILD, VERSION,
  `index.html says BUILD '${BUILD}' but sw.js says VERSION '${VERSION}'. They name the same build, and the page reports BUILD when something goes wrong, so a mismatch sends people chasing the wrong version.`);

// 2c. The manifest is what decides whether this can be installed, and whether a store
// packager (PWABuilder and friends) will take it. Every requirement it has to meet is
// mechanical, so none of them should ever be checked by hand.
const mf = JSON.parse(read('manifest.json'));
assert.ok(/<link[^>]+rel="manifest"[^>]+href="\/manifest\.json"/.test(html),
  'index.html does not link /manifest.json. Nothing is installable without it.');
for (const k of ['id', 'name', 'short_name', 'start_url', 'scope', 'display', 'background_color', 'theme_color']) {
  assert.ok(mf[k], `manifest.json has no ${k}. PWABuilder treats it as required.`);
}
assert.equal(mf.display, 'standalone', 'manifest display must be standalone to install as an app');
assert.ok(mf.short_name.length <= 12, `short_name "${mf.short_name}" is what fits under a home screen icon; keep it short`);

// Every icon it promises has to exist, be a PNG, and actually be the size it claims —
// a manifest that names a file that is not there fails a packager outright.
const png = f => { const b = readFileSync(join(ROOT, f)); assert.ok(b.subarray(1, 4).toString() === 'PNG', `${f} is not a PNG`);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };
for (const ic of mf.icons) {
  const f = ic.src.replace(/^\//, '');
  assert.ok(existsSync(join(ROOT, f)), `manifest.json names ${ic.src}, which is not in the repo`);
  const { w, h } = png(f);
  assert.equal(`${w}x${h}`, ic.sizes, `${ic.src} says ${ic.sizes} but is ${w}x${h}`);
  assert.ok(PRECACHE.includes(ic.src), `${ic.src} is not in PRECACHE, so an installed app would have no icon offline`);
}
const has = (size, purpose) => mf.icons.some(i => i.sizes === size && (i.purpose || 'any').split(' ').includes(purpose));
for (const size of ['192x192', '512x512']) {
  assert.ok(has(size, 'any'), `manifest.json has no ${size} icon. Both 192 and 512 are required to install.`);
  assert.ok(has(size, 'maskable'), `manifest.json has no ${size} maskable icon. Without one Android crops the square icon into its adaptive shape and takes the corners with it.`);
}

// iOS does not read the manifest for any of this.
assert.ok(/<link[^>]+rel="apple-touch-icon"/.test(html), 'no apple-touch-icon: iOS would use a screenshot of the page as the home screen icon');
assert.ok(/name="apple-mobile-web-app-capable"[^>]+content="yes"/.test(html), 'without apple-mobile-web-app-capable, iOS opens the home screen icon in Safari chrome');
const vp = /<meta name="viewport" content="([^"]+)"/.exec(html);
assert.ok(vp, 'no viewport meta');
assert.ok(/width=device-width/.test(vp[1]), 'viewport must be width=device-width');
assert.ok(/viewport-fit=cover/.test(vp[1]), 'viewport needs viewport-fit=cover, or a standalone app leaves bars around the notch');

// 3. Changing a precached file without bumping VERSION leaves installed apps on the old
// copy indefinitely, which is how a fix can look deployed and still not reach anyone.
const digest = createHash('sha256')
  .update(PRECACHE.map(p => readFileSync(join(ROOT, p === '/' ? 'index.html' : p))).reduce((a, b) => Buffer.concat([a, b])))
  .digest('hex').slice(0, 16);
const LOCK = 'test/precache.lock';
const lock = existsSync(join(ROOT, LOCK)) ? JSON.parse(read(LOCK)) : null;

if (process.argv.includes('--update')) {
  writeFileSync(join(ROOT, LOCK), JSON.stringify({ version: VERSION, digest }, null, 2) + '\n');
  console.log(`updated ${LOCK}: ${VERSION} ${digest}`);
} else {
  assert.ok(lock, `${LOCK} is missing. Run: node test/static.test.mjs --update`);
  // The lock has to match exactly, so that recording a change is a deliberate step and
  // a later change cannot hide behind a bump someone already made.
  if (digest !== lock.digest) {
    assert.notEqual(VERSION, lock.version,
      `A precached file changed but VERSION in sw.js is still '${VERSION}'. Installed apps would go on serving the old copy, so the change would look deployed without reaching anyone. Bump VERSION, then run: node test/static.test.mjs --update`);
  }
  assert.deepEqual({ version: VERSION, digest }, lock,
    `sw.js and ${LOCK} disagree. If the change is intended, run: node test/static.test.mjs --update`);
}

console.log('PASS: page and service worker agree');
