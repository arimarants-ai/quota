// node test/social.test.mjs   check the app's social links are the website's
//
// Quota's TikTok, Instagram and Facebook live in site-src/social.mjs, which both website
// generators read. The app cannot import it: it is one static file with no build step, served
// from app/ on its own. So app/index.html carries a copy (SOCIAL and SOCIAL_ICON), and this
// fails the moment a handle, an address or a logo in one of them stops matching the other.
// It also keeps the links to the one place they belong, the Follow Quota row in Settings.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOCIAL, ICONS } from '../site-src/social.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'app', 'index.html'), 'utf8');

const block = name => {
  const m = html.match(new RegExp(`\\nconst ${name} = ([\\[{][\\s\\S]*?\\n[\\]}]);\\n`));
  assert.ok(m, `app/index.html has no const ${name}. The Follow Quota row reads it.`);
  return new Function(`return ${m[1]}`)();
};
const appSocial = block('SOCIAL'), appIcons = block('SOCIAL_ICON');

assert.deepEqual(appSocial.map(({key, name, url}) => ({key, name, url})), SOCIAL.map(({key, name, url}) => ({key, name, url})),
  'SOCIAL in app/index.html differs from site-src/social.mjs (accounts, their order, names or addresses). Copy them across.');
assert.deepEqual(appIcons, Object.fromEntries(SOCIAL.map(s => [s.key, ICONS[s.key]])),
  'SOCIAL_ICON in app/index.html differs from ICONS in site-src/social.mjs. Copy the path data across exactly.');

// One row, one copy of each address: a second place in the app that links out to these would
// be one more thing to keep in step, and the brief is Settings only.
assert.equal(html.split('followRow()').length - 1, 1, 'followRow() should be used exactly once, in Settings');
for (const s of SOCIAL) {
  assert.equal(html.split(s.url).length - 1, 1, `${s.url} appears more than once in app/index.html; use SOCIAL instead`);
}
for (const host of ['tiktok.com', 'instagram.com', 'facebook.com']) {
  assert.equal(html.split(host).length - 1, 1, `${host} appears outside SOCIAL in app/index.html`);
}
console.log('PASS: the app follows the same three accounts as the website');
