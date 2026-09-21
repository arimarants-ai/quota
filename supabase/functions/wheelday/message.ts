// What a spin-day reminder says. Kept apart from index.ts so it can be run and checked
// without a Deno runtime or any of the secrets.
export type Due = { user_id: string; wheel_name: string; group_name: string };

/**
 * What the end of somebody's day says. The line is what is left, worked out by the
 * database — "40 pushups", or "40 pushups, 20 situps" when two quotas are short.
 *
 * It says the number and it says there is still time, and it does not say anything about
 * a streak: somebody who is about to lose one knows, and somebody who is not would be
 * being nagged about nothing.
 */
export function endOfDayFor(line: string): string {
  const what = (line ?? '').trim();
  return what ? `${what} to go. Still time today.` : 'Your day is not finished yet. Still time.';
}

// One notification per person, however many wheels came due at once: three separate
// buzzes for the same trip to the app is how notifications get turned off.
export function remindersFor(due: Due[]): Map<string, string> {
  const byUser = new Map<string, Due[]>();
  for (const d of due) byUser.set(d.user_id, [...(byUser.get(d.user_id) ?? []), d]);
  const out = new Map<string, string>();
  for (const [uid, rows] of byUser) {
    const names = [...new Set(rows.map(r => r.wheel_name))];
    const groups = [...new Set(rows.map(r => r.group_name))];
    const what = names.length === 1 ? names[0]
      : names.length === 2 ? `${names[0]} and ${names[1]}`
      : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
    const where = groups.length === 1 ? groups[0] : `${groups.length} groups`;
    out.set(uid, `Spin ${what} in ${where} before you post today.`);
  }
  return out;
}


// ---- the day's one notification
// What notices_due_now() hands back, per person per kind.
export type Notice = {
  user_id: string;
  kind: 'open' | 'lastcall' | 'lapsed';
  hours: number;
  group_name: string;
  others: number;                  // other people in that group who have posted today
  mates: number;                   // how many other people are in it at all
};

const hrs = (n: number) => `${n} ${n === 1 ? 'hour' : 'hours'}`;

/**
 * The window opening. It says how long there is, because "post today" is not news and
 * "four hours" is. The number is the whole point, so it leads.
 */
export function windowFor(n: Notice): string {
  const h = Math.max(1, Math.round(n.hours));
  return `${hrs(h)} to post today.${n.group_name ? ` ${n.group_name} is waiting.` : ''}`;
}

/**
 * Last call. This one is allowed to mention the streak, because a group streak is not your
 * number — it is everybody's, and being the one who ends it is the thing worth saying.
 * The end-of-day nudge it replaces deliberately said nothing about streaks; that was about
 * somebody's own, which they already know about.
 *
 * Nobody else posted yet and there is nothing social to say, so it falls back to the clock.
 */
export function lastCallFor(n: Notice): string {
  const h = Math.max(1, Math.round(n.hours));
  if (n.others > 0 && n.others === n.mates) {
    return `Everyone in ${n.group_name} has posted but you. Your group's streak is on the line — don't be the one who breaks it.`;
  }
  if (n.others > 0) {
    return `${n.others} of ${n.mates} in ${n.group_name} have posted. ${hrs(h)} left — don't be the one who breaks the streak.`;
  }
  return `${hrs(h)} left to post today.`;
}

/**
 * For somebody who has not opened the app in three days. It replaces the window one rather
 * than arriving beside it: two notifications in a day is what somebody who has stopped
 * caring uninstalls over.
 */
export function lapsedFor(n: Notice): string {
  if (!n.group_name) return 'Your group has been going without you.';
  return n.others > 0
    ? `${n.group_name} posted without you today.`
    : `${n.group_name} is still going. Your spot is still there.`;
}

// Title and tag per kind. The tag is what makes today's replace yesterday's rather than
// stacking up on the lock screen.
export const NOTICE_META: Record<Notice['kind'], { title: string; tag: string }> = {
  open: { title: 'Your window is open', tag: 'day-open' },
  lastcall: { title: 'Last call', tag: 'day-last' },
  lapsed: { title: 'Quota', tag: 'day-open' },     // the one it stands in for
};

export function noticeBody(n: Notice): string {
  return n.kind === 'open' ? windowFor(n) : n.kind === 'lastcall' ? lastCallFor(n) : lapsedFor(n);
}
