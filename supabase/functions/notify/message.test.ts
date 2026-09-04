// Run: node --experimental-strip-types message.test.ts
import { messageFor } from './message.ts';
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

console.log(`\nall ${n} message checks passed`);
