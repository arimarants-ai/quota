// node --experimental-strip-types supabase/functions/welcome/message.test.ts
import assert from 'node:assert/strict';
import { welcomeEmail, firstName, undeliverable } from './index.ts';

assert.equal(firstName('Ari Marants'), 'Ari');
assert.equal(firstName('  '), '');
assert.equal(firstName(null), '');

const named = welcomeEmail('Ari Marants');
assert.equal(named.subject, "You're in, Ari. Here's how day one works");
assert.match(named.html, /Welcome to Quota, Ari\./);
assert.match(named.html, /href="https:\/\/app\.hitquota\.app"/);
assert.match(named.text, /1\. Start a crew\./);
assert.match(named.text, /3\. Set a forfeit\./);

const nameless = welcomeEmail('');
assert.equal(nameless.subject, "You're in. Here's how day one works");
assert.match(nameless.html, /Welcome to Quota\./);

// A name is somebody's own text, and it lands inside HTML.
assert.ok(!welcomeEmail('<b>x</b>').html.includes('<b>x</b>'), 'a name is escaped');

assert.ok(undeliverable('ari@users.quota.local'));
assert.ok(undeliverable(''));
assert.ok(!undeliverable('ari@gmail.com'));
console.log('PASS: welcome email');
