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

