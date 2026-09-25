// Pure notification-text logic, kept out of index.ts so it can be tested without Deno.
export type Quota = { metric: string; target: number };
export type Post = { metric: string; amount: number };

/**
 * Text for a new post. `dayPosts` is everything the poster has logged in this
 * group today, including the post that just landed. `challenge` is what the wheel
 * gave them, when the post was marked as done with it: "did 25 decline pushups"
 * rather than "did 25 pushups".
 */
export function messageFor(name: string, metric: string, amount: number, quotas: Quota[], dayPosts: Post[], challenge?: string | null, where?: string | null): string {
  const totals = new Map<string, number>();
  for (const p of dayPosts) totals.set(p.metric, (totals.get(p.metric) ?? 0) + p.amount);

  const hit = (q: Quota, minus = 0) => (totals.get(q.metric) ?? 0) - minus >= q.target;
  // Only the post that crosses the line announces the goal, so it fires once a day.
  const justFinished = quotas.length > 0
    && quotas.every(q => hit(q))
    && !quotas.every(q => hit(q, q.metric === metric ? amount : 0));

  const what = challenge ? `${amount} ${challenge} ${metric}` : `${amount} ${metric}`;
  // Named as the thing that happened rather than left to be worked out. "Sam did 30
  // pushups" reads on a lock screen as something Sam mentioned; what it means is that Sam
  // posted proof, in a group, and there is something there to go and look at.
  const wheresit = where ? ` in ${where}` : '';
  return justFinished ? `${name} finished the day's goal${wheresit}` : `${name} posted ${what}${wheresit}`;
}

/**
 * Text for a flag: one person questioning whether a post met the challenge, and the group
 * deciding. Four different people want four different sentences out of the same two events,
 * so who is being told is an argument rather than something guessed from the row.
 *
 * `mine` is true when the post being questioned is the reader's own. Everyone else in the
 * group is being asked to vote; the person it is about is being told, and has no vote.
 */
export function flagFor(name: string, what: string, mine: boolean): string {
  return mine ? `${name} questioned your ${what}. The group is deciding.`
              : `${name} questioned ${what}. Have your say.`;
}
export function verdictFor(what: string, upheld: boolean, mine: boolean): string {
  if (mine) {
    return upheld ? `The group says your ${what} needs redoing. There is still time today.`
                  : `The group let your ${what} stand.`;
  }
  return upheld ? `The group says ${what} needs redoing.` : `The group let ${what} stand.`;
}

/**
 * A message in a chat. `where` is the group's name when it is a group's chat, and nothing
 * when it is between two people. `replied` is when it answers something you said.
 *
 * Who, and what they did, but never the words: a notification is a reason to open the app,
 * and what somebody said is read there, in the conversation it belongs to.
 */
export function chatFor(name: string, where?: string | null, replied = false): string {
  if (replied) return where ? `${name} replied to you in ${where}` : `${name} replied to your message`;
  return where ? `${name} messaged ${where}` : `${name} sent you a message`;
}

/** Who did it, by the name they chose, falling back to the one they signed up with. */
export type Who = { username: string; display_name?: string | null };
export const who = (p: Who) => p.display_name || p.username;

/**
 * Text for everything that is not a post. Kept here with the rest so it can be read
 * beside what a post says, and tested without Deno or a database.
 */
export function socialFor(kind: 'friend' | 'group' | 'comment' | 'reply' | 'like' | 'reaction' | 'story_like' | 'story_reaction' | 'comment_like' | 'message_reaction' | 'accepted_friend' | 'joined_group', name: string, extra?: string | null): string {
  if (kind === 'friend') return `${name} sent you a friend request`;
  if (kind === 'message_reaction') return `${name} reacted ${extra ?? ''} to your message`.replace(/ {2,}/g, ' ');
  // Somebody said yes. Worth hearing: an invitation sent and never spoken of again is the
  // one thing in the app that used to just quietly happen.
  if (kind === 'accepted_friend') return `${name} accepted your friend request`;
  if (kind === 'joined_group') return `${name} joined ${extra}`;
  if (kind === 'group') return `${name} added you to ${extra}`;
  if (kind === 'like') return `${name} liked your proof`;
  if (kind === 'reaction') return `${name} reacted ${extra ?? ''} to your proof`.replace(/ {2,}/g, ' ');
  // A story says so, because it is gone in a day and the post it is not is still there.
  if (kind === 'story_like') return `${name} liked your story`;
  if (kind === 'story_reaction') return `${name} reacted ${extra ?? ''} to your story`.replace(/ {2,}/g, ' ');
  // Who, not what. The words are read in the app, under the post they belong to.
  if (kind === 'comment_like') return `${name} liked your comment`;
  if (kind === 'reply') return `${name} replied to your comment`;
  return `${name} commented on your proof`;
}
