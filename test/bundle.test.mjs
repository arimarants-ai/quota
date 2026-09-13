// node test/bundle.test.mjs
//
// A bundled copy that has drifted from the sources is worse than none: it would be
// deployed in good faith and behave like an older version of the app.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from './bundle.mjs';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'functions', 'notify');
const committed = readFileSync(join(DIR, 'bundled.ts'), 'utf8');

assert.equal(committed, bundle(),
  'supabase/functions/notify/bundled.ts no longer matches push.ts, message.ts and index.ts. Run: node test/bundle.mjs --write');

// It has to be able to stand alone: nothing left pointing at a file that will not be there.
assert.ok(!/from '\.\/(push|message)\.ts'/.test(committed), 'the bundle still imports a sibling file');
// And still be the whole function.
for (const needle of ['Deno.serve', 'function messageFor', 'function socialFor', 'async function send', 'x-hook-secret']) {
  assert.ok(committed.includes(needle), `the bundle is missing ${needle}`);
}
console.log('PASS: the one-file function matches the three it is built from');
