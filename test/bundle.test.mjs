// node test/bundle.test.mjs
//
// A bundled copy that has drifted from the sources is worse than none: it would be
// deployed in good faith and behave like an older version of the app.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle, BUNDLES } from './bundle.mjs';

const FUNCS = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'functions');

// What each one has to still contain to be the whole function rather than most of it.
const MUST = {
  notify: ['Deno.serve', 'function messageFor', 'function socialFor', 'function chatFor',
           'function flagFor', 'async function send', 'x-hook-secret'],
  wheelday: ['Deno.serve', 'function remindersFor', 'function endOfDayFor',
             'async function send', 'x-hook-secret', 'rpc/wheel_due_now', 'rpc/notices_due_now',
             'storage/v1/object/stories', 'async function sweepStories',
             'rpc/cron_health', 'function cronAlertBody'],
};

for (const name of Object.keys(BUNDLES)) {
  const committed = readFileSync(join(FUNCS, name, 'bundled.ts'), 'utf8');
  assert.equal(committed, bundle(name),
    `supabase/functions/${name}/bundled.ts no longer matches ${BUNDLES[name].files.join(', ')}. Run: node test/bundle.mjs --write`);
  // It has to stand alone: nothing left pointing at a file that will not be there.
  assert.ok(!/from '\.\.?\/[^']*\.ts'/.test(committed),
    `the ${name} bundle still imports a sibling file`);
  for (const needle of MUST[name]) {
    assert.ok(committed.includes(needle), `the ${name} bundle is missing ${needle}`);
  }
}
console.log('PASS: each one-file function matches the files it is built from');
