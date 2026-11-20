// How many wrong tries sign-in allows before it asks for a pause. Only a wrong password or a
// name nobody has counts; a sign-in that works never does, so whoever owns an account can
// always get in from their own phone.
//
//   one account from one address   10 in 10 minutes
//   one account from anywhere      100 in an hour, a backstop
//   one address, any account       60 in 10 minutes, 2000 in a day
//
// Kept apart from index.ts so it runs and is checked without Deno or any secret.

export type Limit = { key: string; window: string; max: number };

export function limitsFor(id: string, ip: string): Limit[] {
  const who = id.trim().toLowerCase();
  const out: Limit[] = [{ key: `signin-fail-id:${who}`, window: '1 hour', max: 100 }];
  if (ip) {
    out.push({ key: `signin-fail-idip:${who}|${ip}`, window: '10 minutes', max: 10 });
    out.push({ key: `signin-fail-ip:${ip}`, window: '10 minutes', max: 60 });
    out.push({ key: `signin-fail-ip:${ip}`, window: '1 day', max: 2000 });
  }
  return out;
}

// counts[i] is how many failures limits[i] has seen in its window.
export const overLimit = (limits: Limit[], counts: number[]) => limits.some((l, i) => (counts[i] ?? 0) >= l.max);

// The keys a failure is counted against: each one once, whichever windows it has.
export const failureKeys = (limits: Limit[]) => [...new Set(limits.map(l => l.key))];

// Which outcomes are counted. Only a wrong answer: never a sign-in that worked, an address
// still waiting on its confirmation (the password was right), a pause, or our own outage.
export type Outcome = 'signed-in' | 'wrong' | 'unconfirmed' | 'slow' | 'unavailable';
export const counts = (o: Outcome) => o === 'wrong';
