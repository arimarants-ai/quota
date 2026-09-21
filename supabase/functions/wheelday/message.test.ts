// node --experimental-strip-types supabase/functions/wheelday/message.test.ts
import assert from 'node:assert/strict';
import { endOfDayFor, remindersFor, noticeBody, NOTICE_META, type Due, type Notice } from './message.ts';

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


// ---- the day's one notification
{
  const n = (over: Partial<Notice> = {}): Notice =>
    ({ user_id: 'a', kind: 'open', hours: 5, group_name: 'Mornings', others: 0, mates: 3, ...over }) as Notice;

  const w = noticeBody(n({ kind: 'open', hours: 4 }));
  ok(/4 hours/.test(w) && /Mornings/.test(w), 'the window one leads with how long is left', w);
  ok(/1 hour\b/.test(noticeBody(n({ kind: 'open', hours: 1 }))), 'and says one hour, not one hours');

  const alone = noticeBody(n({ kind: 'lastcall', others: 3, mates: 3, hours: 2 }));
  ok(/Everyone in Mornings/.test(alone) && /streak/i.test(alone),
    'last call with everyone else in says so, and says streak', alone);
  const some = noticeBody(n({ kind: 'lastcall', others: 2, mates: 3, hours: 2 }));
  ok(/2 of 3/.test(some) && /streak/i.test(some), 'and counts them when it is only some', some);
  const nobody = noticeBody(n({ kind: 'lastcall', others: 0, mates: 3, hours: 2 }));
  ok(!/streak/i.test(nobody) && /2 hours/.test(nobody),
    'with nobody in there is nothing social to say, so it is just the clock', nobody);

  const lap = noticeBody(n({ kind: 'lapsed', others: 2 }));
  ok(/posted without you/.test(lap), 'the lapsed one says what was missed', lap);
  ok(/still going/.test(noticeBody(n({ kind: 'lapsed', others: 0 }))),
    'and does not claim they posted when nobody did');
  ok(!/hour/.test(noticeBody(n({ kind: 'lapsed', others: 2 }))),
    'a lapsed message is not a countdown', lap);

  // The promise the whole block exists to keep: the lapsed message stands in for the
  // window one, so it carries the same tag and replaces it rather than stacking beside it.
  assert.equal(NOTICE_META.lapsed.tag, NOTICE_META.open.tag);
  ok(NOTICE_META.lastcall.tag !== NOTICE_META.open.tag,
    'and last call is its own, because it is allowed to arrive as well');

  for (const kind of ['open', 'lastcall', 'lapsed'] as const) {
    const body = noticeBody(n({ kind, group_name: '' }));
    ok(body.length > 0 && !/undefined|null/.test(body),
      `${kind} still reads as a sentence with no group to name`, body);
  }
}

console.log('all wheelday message checks passed');
