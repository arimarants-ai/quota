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
