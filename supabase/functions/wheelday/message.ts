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
  kind: 'open' | 'lastcall' | 'lapsed' | 'challenge' | 'period';
  hours: number;
  group_name: string;              // the group, or for a challenge the wheel
  others: number;                  // other people in that group who have posted today
  mates: number;                   // how many other people are in it at all
  line: string;                    // what is still owed today: "40 pushups, 20 situps"
  done: number;                    // challenge days done
  needs: number;                   // challenge days required
  unit?: string;                   // 'month' or 'year', for a period reminder (schema v60)
  days_left?: number;              // and how many days of it are left, today included
  since_days?: number | null;      // for a lapsed one, days since their last post (schema v63)
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
 * Last call. It is about your own streak: that is the number you are keeping, and saying
 * so is the nudge. It used to say "don't be the one who breaks the streak", which made
 * one person's missed day the group's failure; the group's run is a bonus now, and a
 * reminder is not the place to hang it on anybody.
 *
 * Nobody else posted yet and there is nothing social to say, so it falls back to the clock.
 */
export function lastCallFor(n: Notice): string {
  const h = Math.max(1, Math.round(n.hours));
  // What is actually left comes first. Being told the number is the difference between a
  // nudge you can act on and one you have to open the app to understand — and somebody
  // twenty of fifty in gets this too now, which the version before this did not do.
  const owed = (n.line ?? '').trim();
  const left = owed ? `${owed} to go.` : '';
  if (n.others > 0 && n.others === n.mates) {
    return `${left} Everyone in ${n.group_name} has posted but you. ${hrs(h)} left to keep your streak.`.trim();
  }
  if (n.others > 0) {
    return `${left} ${n.others} of ${n.mates} in ${n.group_name} have posted. ${hrs(h)} left to keep your streak.`.trim();
  }
  return left ? `${left} ${hrs(h)} left today.` : `${hrs(h)} left to post today.`;
}

/**
 * A challenge whose cycle shuts tonight, with days still owed on it.
 *
 * This takes the evening instead of last call rather than as well as it: a whole cycle's
 * work about to be lost is the more urgent of the two, and two messages in an evening is
 * how an app gets muted.
 */
export function challengeFor(n: Notice): string {
  const h = Math.max(1, Math.round(n.hours));
  const short = Math.max(0, (n.needs ?? 0) - (n.done ?? 0));
  const what = n.group_name ? `${n.group_name} ends tonight` : 'Your challenge ends tonight';
  const got = n.needs > 0 ? ` ${n.done} of ${n.needs} days done` : '';
  return short === 1 && n.done > 0
    ? `${what} —${got}, one more and it counts. ${hrs(h)} left.`
    : `${what} —${got}. ${hrs(h)} left.`;
}

/**
 * A month's or a year's total that is still short in its last three days (schema v60). The
 * only thing those groups are ever told: a total is not something to chase every day, so it
 * is said once, near the end, with what is left and how long there is.
 */
export function periodFor(n: Notice): string {
  const unit = n.unit || 'month', left = Math.max(1, Math.round(n.days_left ?? 1));
  const owed = (n.line ?? '').trim();
  const what = owed ? `${owed} to go${n.group_name ? ` in ${n.group_name}` : ''}.` : `${n.group_name || 'Your group'} isn't in yet.`;
  return `${what} ${left === 1 ? `Last day of the ${unit}.` : `${left} days left this ${unit}.`}`;
}

// Three to six in words, the way the message always said three. Past that it is a number.
const DAYS_WORD: Record<number, string> = { 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six' };

/**
 * For somebody who has not posted in three days or more. It replaces the window one rather
 * than arriving beside it: two notifications in a day is what somebody who has stopped
 * caring uninstalls over.
 *
 * It says how long it has really been (since_days, schema v63). It used to say three days
 * on day 30. From a week on it is a different message: by then they are falling behind,
 * and the people they signed up with are the reason to come back, so it says that, once,
 * plainly. Without the number (a database from before v63, or somebody who has never
 * posted) it is the three days it always was.
 */
export function lapsedFor(n: Notice): string {
  const d = Number.isFinite(n.since_days as number) ? Math.round(n.since_days as number) : null;
  if (d !== null && d >= 7) {
    return `${d} days since your last post, and you're falling behind. ${n.group_name || 'Your group'} is relying on you.`;
  }
  if (!n.group_name) return 'Your group has been going without you.';
  const days = d !== null && d >= 3 ? DAYS_WORD[d] : 'Three';
  return n.others > 0
    ? `${n.group_name} posted without you today. ${days} days since your last one.`
    : `${n.group_name} is still going. Your spot is still there.`;
}

// Title and tag per kind. The tag is what makes today's replace yesterday's rather than
// stacking up on the lock screen.
export const NOTICE_META: Record<Notice['kind'], { title: string; tag: string }> = {
  open: { title: 'Your window is open', tag: 'day-open' },
  lastcall: { title: 'Last call', tag: 'day-last' },
  lapsed: { title: 'Quota', tag: 'day-open' },     // the one it stands in for
  challenge: { title: 'Last call', tag: 'day-last' },   // likewise: it takes last call's place
  period: { title: 'Nearly there', tag: 'day-open' },   // it stands in for the window that day
};

export function noticeBody(n: Notice): string {
  return n.kind === 'open' ? windowFor(n)
    : n.kind === 'challenge' ? challengeFor(n)
    : n.kind === 'lastcall' ? lastCallFor(n)
    : n.kind === 'period' ? periodFor(n)
    : lapsedFor(n);
}
