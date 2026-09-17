// node --experimental-strip-types supabase/functions/wheelday/message.test.ts
import assert from 'node:assert/strict';
import { endOfDayFor, remindersFor, type Due } from './message.ts';

// Some of these are about what a sentence must and must not carry rather than its exact
// wording, which is a thing worth being able to change without editing a test.
const ok = (cond: boolean, msg: string, saw = '') => {
  if (!cond) throw new Error(`FAIL ${msg}${saw ? `\n  saw: ${saw}` : ''}`);
  console.log('  ok  ' + msg);
};

const due = (user_id: string, wheel_name: string, group_name: string): Due => ({ user_id, wheel_name, group_name });

// One wheel, one person.
let m = remindersFor([due('a', 'Challenge', 'Mornings')]);
assert.equal(m.get('a'), 'Spin Challenge in Mornings before you post today.');

// Two wheels coming due together are one notification, not two buzzes for one trip.
m = remindersFor([due('a', 'Challenge', 'Mornings'), due('a', 'Recovery', 'Mornings')]);
assert.equal(m.size, 1);
assert.equal(m.get('a'), 'Spin Challenge and Recovery in Mornings before you post today.');

// Three read as a list.
m = remindersFor([due('a', 'One', 'G'), due('a', 'Two', 'G'), due('a', 'Three', 'G')]);
assert.equal(m.get('a'), 'Spin One, Two and Three in G before you post today.');

// Wheels in different groups do not claim to be in one of them.
m = remindersFor([due('a', 'Challenge', 'Mornings'), due('a', 'Sauna', 'Evenings')]);
assert.match(m.get('a')!, /in 2 groups/);

// Everyone gets their own.
m = remindersFor([due('a', 'Challenge', 'Mornings'), due('b', 'Challenge', 'Mornings')]);
assert.equal(m.size, 2);
assert.equal(m.get('a'), m.get('b'));

// The same wheel arriving twice for one person does not get said twice.
m = remindersFor([due('a', 'Challenge', 'Mornings'), due('a', 'Challenge', 'Mornings')]);
assert.equal(m.get('a'), 'Spin Challenge in Mornings before you post today.');


// ---- the end of somebody's day
{
  const one = endOfDayFor('40 pushups');
  ok(one.includes('40 pushups') && /still time/i.test(one),
    'says what is left and that there is still time', one);
  const two = endOfDayFor('40 pushups, 20 situps');
  ok(two.includes('40 pushups') && two.includes('20 situps'),
    'and both, when two quotas are short', two);
  ok(!/streak/i.test(one),
    'and says nothing about a streak, which is either known or not the point', one);
  const none = endOfDayFor('');
  ok(none.length > 0 && !none.includes('undefined'),
    'a line that came back empty still reads as a sentence', none);
}

console.log('all wheelday message checks passed');
