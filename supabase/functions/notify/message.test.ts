// Run: node --experimental-strip-types message.test.ts
import { chatFor, flagFor, messageFor, socialFor, verdictFor } from './message.ts';
let n = 0;
const eq = (got: string, want: string, msg: string) => {
  if (got !== want) throw new Error(`FAIL ${msg}\n  got:  ${got}\n  want: ${want}`);
  console.log('  ok  ' + msg); n++;
};
// Some of these are about what a sentence must and must not carry rather than its exact
// wording, which is a thing worth being able to change without editing a test.
const ok = (cond: boolean, msg: string, saw = '') => {
  if (!cond) throw new Error(`FAIL ${msg}${saw ? `\n  saw: ${saw}` : ''}`);
  console.log('  ok  ' + msg); n++;
};

const push100 = [{ metric: 'pushups', target: 100 }];
const both = [{ metric: 'pushups', target: 100 }, { metric: 'situps', target: 50 }];

eq(messageFor('John', 'pushups', 30, push100, [{ metric: 'pushups', amount: 30 }]),
   'John posted 30 pushups', 'partial progress reports the amount, and says it was posted');

eq(messageFor('Sydney', 'pushups', 40, push100,
   [{ metric: 'pushups', amount: 60 }, { metric: 'pushups', amount: 40 }]),
   "Sydney finished the day's goal", 'the post that reaches the target announces the goal');

eq(messageFor('Sydney', 'pushups', 10, push100,
   [{ metric: 'pushups', amount: 100 }, { metric: 'pushups', amount: 10 }]),
   'Sydney posted 10 pushups', 'a post after the goal is already met does not re-announce');

eq(messageFor('Ari', 'pushups', 100, both, [{ metric: 'pushups', amount: 100 }]),
   'Ari posted 100 pushups', 'one of two quotas met is not the goal');

eq(messageFor('Ari', 'situps', 50, both,
   [{ metric: 'pushups', amount: 100 }, { metric: 'situps', amount: 50 }]),
   "Ari finished the day's goal", 'the last outstanding quota completes the goal');

eq(messageFor('Ari', 'pushups', 200, push100, [{ metric: 'pushups', amount: 200 }]),
   "Ari finished the day's goal", 'overshooting in one post still completes it');

eq(messageFor('Ari', 'pushups', 5, [], [{ metric: 'pushups', amount: 5 }]),
   'Ari posted 5 pushups', 'a group with no quotas never announces a goal');

// A post done with the wheel's challenge says what was actually done, rather than the
// group's plain metric.
eq(messageFor('Bob', 'pushups', 25, [{ metric: 'pushups', target: 100 }], [{ metric: 'pushups', amount: 25 }], 'decline'),
   'Bob posted 25 decline pushups', 'a challenge shows up in the notification');

eq(messageFor('Bob', 'pushups', 25, [{ metric: 'pushups', target: 100 }], [{ metric: 'pushups', amount: 25 }]),
   'Bob posted 25 pushups', 'without one, nothing changes');

eq(messageFor('Bob', 'pushups', 25, [{ metric: 'pushups', target: 100 }], [{ metric: 'pushups', amount: 25 }], null),
   'Bob posted 25 pushups', 'and a null challenge is the same as none');

eq(messageFor('Bob', 'pushups', 100, [{ metric: 'pushups', target: 100 }], [{ metric: 'pushups', amount: 100 }], 'decline'),
   "Bob finished the day's goal", 'finishing the day still announces the goal');

console.log(`\nall ${n} message checks passed`);

// --- everything that is not a post
{
  eq(socialFor('friend', 'Ari'), 'Ari sent you a friend request', 'a friend request says who');
  eq(socialFor('group', 'Ari', 'Lock In'), 'Ari added you to Lock In', 'a group invite names the group');
  eq(socialFor('like', 'Ari'), 'Ari liked your proof', 'a like says whose');
  // Who, and what they did, and never the words: those are read in the app.
  eq(socialFor('comment', 'Ari', 'nice one'), 'Ari commented on your proof', 'a comment says who, not what');
  eq(socialFor('reply', 'Ari', 'nice one'), 'Ari replied to your comment', 'a reply says it is a reply to yours');
}
eq(socialFor('reaction', 'Ari', '🔥'), 'Ari reacted 🔥 to your proof', 'a reaction carries the emoji and says what it was on');
eq(socialFor('reaction', 'Ari'), 'Ari reacted to your proof', '  and reads properly without one');
// A story says it is a story: it will not be there tomorrow, and the post it is not still is.
eq(socialFor('story_like', 'Ari'), 'Ari liked your story', 'a story like says so');
eq(socialFor('story_reaction', 'Ari', '🔥'), 'Ari reacted 🔥 to your story', '  and a story reaction carries the emoji');
eq(socialFor('story_reaction', 'Ari'), 'Ari reacted to your story', '  reading properly without one');
eq(socialFor('comment_like', 'Ari', 'nice one'), 'Ari liked your comment', 'a comment like does not quote the comment');

// A chat notification names the chat and the person, never the words.
eq(chatFor('Ari', 'Lock In'), 'Ari messaged Lock In', 'a group message names the group');
eq(chatFor('Ari'), 'Ari sent you a message', 'a private one says so');
eq(chatFor('Ari', 'Lock In', true), 'Ari replied to you in Lock In', 'a reply in a group says it answers you');
eq(chatFor('Ari', null, true), 'Ari replied to your message', 'and in a private chat');

// ---- questioning somebody's proof
// The same two events, four different sentences, because being asked to vote and being
// told about your own are not the same thing to read on a lock screen.
{
  const asked = flagFor('Max', '20 pushups', false);
  const told = flagFor('Max', '20 pushups', true);
  ok(asked.includes('Max') && /have your say/i.test(asked),
    'somebody else is asked to vote', asked);
  ok(told.includes('your 20 pushups') && !/have your say/i.test(told),
    'the person it is about is told, not asked', told);
  ok(!told.includes('your your'), 'and told once, not twice', told);

  const lost = verdictFor('20 pushups', true, true);
  const kept = verdictFor('20 pushups', false, true);
  ok(/redoing/i.test(lost) && /still time/i.test(lost),
    'an upheld flag says what to do about it', lost);
  ok(/stand/i.test(kept) && !/redo/i.test(kept), 'a dismissed one says it stands', kept);

  const lostThem = verdictFor('20 pushups', true, false);
  ok(!/your/i.test(lostThem), 'and the group hears about it without being blamed for it', lostThem);
}

// ---- somebody said yes
{
  const f = socialFor('accepted_friend', 'Sam');
  ok(/sam/i.test(f) && /accepted/i.test(f), 'an accepted friend request says who', f);
  const g = socialFor('joined_group', 'Sam', 'Mornings');
  ok(/sam/i.test(g) && /mornings/i.test(g), 'and joining a group says which one', g);
}
