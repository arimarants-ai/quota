// Pure notification-text logic, kept out of index.ts so it can be tested without Deno.
export type Quota = { metric: string; target: number };
export type Post = { metric: string; amount: number };

/**
 * Text for a new post. `dayPosts` is everything the poster has logged in this
 * group today, including the post that just landed. `challenge` is what the wheel
 * gave them, when the post was marked as done with it: "did 25 decline pushups"
 * rather than "did 25 pushups".
 */
export function messageFor(name: string, metric: string, amount: number, quotas: Quota[], dayPosts: Post[], challenge?: string | null): string {
  const totals = new Map<string, number>();
  for (const p of dayPosts) totals.set(p.metric, (totals.get(p.metric) ?? 0) + p.amount);

  const hit = (q: Quota, minus = 0) => (totals.get(q.metric) ?? 0) - minus >= q.target;
  // Only the post that crosses the line announces the goal, so it fires once a day.
  const justFinished = quotas.length > 0
    && quotas.every(q => hit(q))
    && !quotas.every(q => hit(q, q.metric === metric ? amount : 0));

  const what = challenge ? `${amount} ${challenge} ${metric}` : `${amount} ${metric}`;
  return justFinished ? `${name} completed the day's goal` : `${name} did ${what}`;
}

/** Who did it, by the name they chose, falling back to the one they signed up with. */
export type Who = { username: string; display_name?: string | null };
export const who = (p: Who) => p.display_name || p.username;

/**
 * Text for everything that is not a post. Kept here with the rest so it can be read
 * beside what a post says, and tested without Deno or a database.
 */
export function socialFor(kind: 'friend' | 'group' | 'comment' | 'like', name: string, extra?: string | null): string {
  if (kind === 'friend') return `${name} sent you a friend request`;
  if (kind === 'group') return `${name} added you to ${extra}`;
  if (kind === 'like') return `${name} liked your proof`;
  // A comment is worth reading in the notification itself, but a long one turns the
  // whole thing into a wall; the rest is one tap away.
  const body = (extra ?? '').replace(/\s+/g, ' ').trim();
  const short = body.length > 80 ? `${body.slice(0, 79)}…` : body;
  return short ? `${name}: ${short}` : `${name} commented on your proof`;
}
