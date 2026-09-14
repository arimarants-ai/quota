// Run: node --experimental-strip-types message.test.ts
import { messageFor, socialFor } from './message.ts';
let n = 0;
const eq = (got: string, want: string, msg: string) => {
  if (got !== want) throw new Error(`FAIL ${msg}\n  got:  ${got}\n  want: ${want}`);
  console.log('  ok  ' + msg); n++;
};

const push100 = [{ metric: 'pushups', target: 100 }];
const both = [{ metric: 'pushups', target: 100 }, { metric: 'situps', target: 50 }];

eq(messageFor('John', 'pushups', 30, push100, [{ metric: 'pushups', amount: 30 }]),
   'John did 30 pushups', 'partial progress reports the amount');

eq(messageFor('Sydney', 'pushups', 40, push100,
   [{ metric: 'pushups', amount: 60 }, { metric: 'pushups', amount: 40 }]),
   "Sydney completed the day's goal", 'the post that reaches the target announces the goal');

eq(messageFor('Sydney', 'pushups', 10, push100,
   [{ metric: 'pushups', amount: 100 }, { metric: 'pushups', amount: 10 }]),
   'Sydney did 10 pushups', 'a post after the goal is already met does not re-announce');

eq(messageFor('Ari', 'pushups', 100, both, [{ metric: 'pushups', amount: 100 }]),
   'Ari did 100 pushups', 'one of two quotas met is not the goal');

eq(messageFor('Ari', 'situps', 50, both,
   [{ metric: 'pushups', amount: 100 }, { metric: 'situps', amount: 50 }]),
   "Ari completed the day's goal", 'the last outstanding quota completes the goal');

eq(messageFor('Ari', 'pushups', 200, push100, [{ metric: 'pushups', amount: 200 }]),
   "Ari completed the day's goal", 'overshooting in one post still completes it');

eq(messageFor('Ari', 'pushups', 5, [], [{ metric: 'pushups', amount: 5 }]),
   'Ari did 5 pushups', 'a group with no quotas never announces a goal');

// A post done with the wheel's challenge says what was actually done, rather than the
// group's plain metric.
eq(messageFor('Bob', 'pushups', 25, [{ metric: 'pushups', target: 100 }], [{ metric: 'pushups', amount: 25 }], 'decline'),
   'Bob did 25 decline pushups', 'a challenge shows up in the notification');

eq(messageFor('Bob', 'pushups', 25, [{ metric: 'pushups', target: 100 }], [{ metric: 'pushups', amount: 25 }]),
   'Bob did 25 pushups', 'without one, nothing changes');

eq(messageFor('Bob', 'pushups', 25, [{ metric: 'pushups', target: 100 }], [{ metric: 'pushups', amount: 25 }], null),
   'Bob did 25 pushups', 'and a null challenge is the same as none');

eq(messageFor('Bob', 'pushups', 100, [{ metric: 'pushups', target: 100 }], [{ metric: 'pushups', amount: 100 }], 'decline'),
   "Bob completed the day's goal", 'finishing the day still announces the goal');

console.log(`\nall ${n} message checks passed`);

// --- everything that is not a post
{
  eq(socialFor('friend', 'Ari'), 'Ari sent you a friend request', 'a friend request says who');
  eq(socialFor('group', 'Ari', 'Lock In'), 'Ari added you to Lock In', 'a group invite names the group');
  eq(socialFor('like', 'Ari'), 'Ari liked your proof', 'a like says whose');
  eq(socialFor('comment', 'Ari', 'nice one'), 'Ari: nice one', 'a comment carries what was said');
  eq(socialFor('comment', 'Ari', '  nice\n  one  '), 'Ari: nice one', '  tidied onto one line');
  eq(socialFor('comment', 'Ari', ''), 'Ari commented on your proof', '  and says something when there is nothing to quote');
  const long = 'x'.repeat(200);
  const got = socialFor('comment', 'Ari', long);
  eq(String(got.length <= 90), 'true', '  a long one is cut rather than filling the screen');
  eq(String(got.endsWith('…')), 'true', '  and says it was cut');
}
eq(socialFor('reaction', 'Ari', '🔥'), 'Ari reacted 🔥', 'a reaction carries the emoji');
eq(socialFor('reaction', 'Ari'), 'Ari reacted', '  and reads properly without one');
