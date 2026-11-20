// node --experimental-strip-types supabase/functions/signin/limits.test.ts
import { counts as isCounted, failureKeys, limitsFor, overLimit } from './limits.ts';

let failed = 0;
const ok = (cond: boolean, what: string, detail?: unknown) => {
  console.log(`  ${cond ? 'ok ' : 'NOT OK'} ${what}${cond || detail === undefined ? '' : `  <- ${JSON.stringify(detail)}`}`);
  if (!cond) failed++;
};
// The failures each limit has seen, by key and window, the way rate_count() answers.
const counts = (ls: ReturnType<typeof limitsFor>, seen: Record<string, number>) => ls.map(l => seen[`${l.key}@${l.window}`] ?? 0);

const owner = limitsFor('Sam', '10.0.0.1'), stranger = limitsFor('sam', '203.0.113.9');

// A stranger hammering a known name locks out their own address for it, not the owner's.
const afterStranger = { [`signin-fail-idip:sam|203.0.113.9@10 minutes`]: 10, [`signin-fail-id:sam@1 hour`]: 10,
  [`signin-fail-ip:203.0.113.9@10 minutes`]: 10, [`signin-fail-ip:203.0.113.9@1 day`]: 10 };
ok(overLimit(stranger, counts(stranger, afterStranger)), 'ten wrong tries at one name from one address pause that address for it');
ok(!overLimit(owner, counts(owner, afterStranger)), 'the owner on their own address is not held back by them');
ok(overLimit(owner, counts(owner, { 'signin-fail-id:sam@1 hour': 100 })), 'a hundred wrong tries at one name from anywhere is the backstop');
ok(!overLimit(owner, counts(owner, { 'signin-fail-id:sam@1 hour': 99 })), '  and 99 is not');

// A shared campus address: lots of people, a few typos each.
const campus = limitsFor('someone', '198.51.100.7');
ok(!overLimit(campus, counts(campus, { 'signin-fail-ip:198.51.100.7@10 minutes': 59, 'signin-fail-ip:198.51.100.7@1 day': 1999 })),
  'one address under 60 failures in ten minutes and 2000 in a day signs in');
ok(overLimit(campus, counts(campus, { 'signin-fail-ip:198.51.100.7@1 day': 2000 })), 'and the day cap is 2000');

ok(limitsFor(' SAM ', '1.2.3.4')[0].key === limitsFor('sam', '1.2.3.4')[0].key, 'a name counts the same whatever its case or spaces');
ok(limitsFor('sam', '').length === 1, 'with no address, only the backstop applies');
ok(failureKeys(owner).length === 3, 'a failure is counted once per key, not once per window', failureKeys(owner));

ok(!isCounted('signed-in') && !isCounted('unconfirmed') && !isCounted('slow') && !isCounted('unavailable'), 'a sign-in that works never counts, nor does anything but a wrong answer');
ok(isCounted('wrong'), 'a wrong answer does');

if (failed) { console.error(`FAIL: ${failed} sign-in limit check(s)`); process.exit(1); }
console.log('PASS: sign-in limits');
