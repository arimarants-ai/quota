// Pure notification-text logic, kept out of index.ts so it can be tested without Deno.
export type Quota = { metric: string; target: number };
export type Post = { metric: string; amount: number };

/**
 * Text for a new post. `dayPosts` is everything the poster has logged in this
 * group today, including the post that just landed.
 */
export function messageFor(name: string, metric: string, amount: number, quotas: Quota[], dayPosts: Post[]): string {
  const totals = new Map<string, number>();
  for (const p of dayPosts) totals.set(p.metric, (totals.get(p.metric) ?? 0) + p.amount);

  const hit = (q: Quota, minus = 0) => (totals.get(q.metric) ?? 0) - minus >= q.target;
  // Only the post that crosses the line announces the goal, so it fires once a day.
  const justFinished = quotas.length > 0
    && quotas.every(q => hit(q))
    && !quotas.every(q => hit(q, q.metric === metric ? amount : 0));

  return justFinished ? `${name} completed the day's goal` : `${name} did ${amount} ${metric}`;
}
