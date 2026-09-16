// node test/language.test.mjs
//
// The word filter is the one piece of index.html that is pure logic with no DOM around
// it, and the one that fails quietly: a list that stops matching lets everything through
// and nothing on screen says so. So it is lifted straight out of the page — between the
// filter:start and filter:end markers — and run here, rather than copied, which would
// drift the first time a word is added.
//
// Half of these cases are words that must NOT be caught. A filter that blocks "assess" or
// "raccoon" is worse than no filter: people stop being able to write ordinary sentences
// and cannot see why.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const src = (html.match(/\/\/ filter:start[\s\S]*?\/\/ filter:end/) || [])[0];
assert.ok(src, 'index.html has no filter:start/filter:end block. If the filter moved, move these markers with it.');
const { badWords, BAD } = new Function(`${src}\nreturn {badWords, BAD};`)();

const caught = s => badWords(s).map(h => h.word);
const clear = s => assert.deepEqual(caught(s), [], `"${s}" should go through untouched`);
const stops = (s, word, why) => {
  const hits = badWords(s);
  assert.ok(hits.length, `"${s}" should have been stopped`);
  assert.equal(hits[0].word, word, `"${s}" was stopped on ${hits[0].word}, expected ${word}`);
  if (why) assert.equal(hits[0].why, why, `"${s}" was filed as ${hits[0].why}, expected ${why}`);
};

// 1. The plain case, in every field it has to cover.
stops('fuck this', 'fuck', 'swear');
stops('100 pushups you dickhead', 'dickhead', 'swear');
stops('nice tits', 'tits', 'sexual');
stops('retarded', 'retarded', 'slur');

// 2. A username is one token with no spaces in it, which is the whole reason ANY exists.
stops('fuckyou123', 'fuck');
stops('xxshitlordxx', 'shit');
clear('assessment_andy');
clear('raccoon_runner');

// 3. Held-down letters and number-for-letter swaps.
stops('fuuuuuuck', 'fuck');
stops('sh1t', 'shit');
stops('f4ggot', 'faggot');
stops('B!TCH', 'bitch');

// 4. Words that live inside innocent ones. Every one of these has to go through.
for (const ok of ['assess the damage', 'a classic set', 'the analysis is done', 'raccoon',
  'cocktail hour', 'peacock', 'flame retardant', 'Scunthorpe half marathon',
  'Pakistan', 'titan lifts', 'documentary', 'circumference', 'grape juice', 'suspicion',
  'homogeneous', 'a prickly pear', 'bassist', 'shiitake mushrooms', 'con artist']) clear(ok);

// 4b. The tail of whole-word matching, written down rather than pretended away: a handful
// of slurs are also ordinary words, and the filter cannot tell which one was meant. They
// stay blocked. A chink of light and a rooster are losses worth taking.
stops('a chink of light', 'chink', 'slur');
stops('the cock crowed', 'cock', 'sexual');

// 5. Mild swearing is deliberately allowed: an app that stops somebody writing "that was
// hell" has started policing the wrong thing.
for (const ok of ['damn that hurt', 'hell of a week', 'this is crap', 'bloody hard']) clear(ok);

// 6. Numbers and captions are the normal traffic. Nothing here may trip.
for (const ok of ['100 pushups in the bag', '5k in 22:30', 'Day 365. Not one missed.',
  '', 'day 1', '50/50']) clear(ok);

// 7. Worst first, so what gets quoted back is the slur and not whatever came before it.
const mixed = badWords('shit that faggot');
assert.equal(mixed[0].word, 'faggot', 'a slur outranks a swear in the message');
assert.equal(mixed[0].why, 'slur');

// 8. Nothing in a WORD list may be a substring of anything in an ANY list, or the whole
// word rule is dead: the ANY match fires first and the careful list never gets a say.
const anys = Object.values(BAD).flatMap(t => t.any);
for (const [tier, t] of Object.entries(BAD))
  for (const w of t.word)
    assert.ok(!anys.some(a => w.includes(a)),
      `${tier} keeps "${w}" as a whole word, but an ANY entry already matches inside it`);

console.log('language ok');
