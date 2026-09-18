// Fan out a push notification to a group when someone posts proof.
// Called by the posts_notify trigger in schema.sql (v4).
import { send, type Subscription } from './push.ts';
import { chatFor, flagFor, messageFor, socialFor, verdictFor, who } from './message.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:hello@quota.app';
const HOOK_SECRET = Deno.env.get('HOOK_SECRET')!;
const SITE_URL = Deno.env.get('SITE_URL') ?? 'https://quota-jet.vercel.app';

const rest = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...init.headers },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
};

Deno.serve(async (req) => {
  // The trigger is the only caller; a shared secret keeps the endpoint from being driven by anyone else.
  if (req.headers.get('x-hook-secret') !== HOOK_SECRET) return new Response('forbidden', { status: 403 });

  // The trigger says what kind of thing happened rather than leaving it to be guessed
  // from the shape of the row: an invite carries a group_id too, and reading one as a post
  // would tell a whole group somebody had done nought pushups.
  const { kind = 'post', record } = await req.json();

  const blast = async (ids: string[], payload: string) => {
    if (!ids.length) return Response.json({ sent: 0, reason: 'nobody to notify' });
    const subs: (Subscription & { endpoint: string })[] =
      await rest(`push_subscriptions?user_id=in.(${ids.join(',')})&select=endpoint,p256dh,auth`);
    const results = await Promise.all(subs.map(async (s) => {
      try {
        return { endpoint: s.endpoint, status: await send(s, payload, { publicKey: VAPID_PUBLIC, privateKey: VAPID_PRIVATE, subject: VAPID_SUBJECT }) };
      } catch (e) {
        return { endpoint: s.endpoint, status: 0, error: String(e) };
      }
    }));
    // 404/410 mean the browser threw the subscription away; stop carrying it around.
    const dead = results.filter(r => r.status === 404 || r.status === 410).map(r => r.endpoint);
    for (const endpoint of dead) {
      await rest(`push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`, { method: 'DELETE' }).catch(() => {});
    }
    return Response.json({
      sent: results.filter(r => r.status >= 200 && r.status < 300).length,
      pruned: dead.length,
      failed: results.filter(r => r.status && (r.status < 200 || r.status >= 300) && r.status !== 404 && r.status !== 410),
    });
  };

  // A notification is worth tapping only if it lands on the thing it is about: the post
  // for something about a post, and the comment itself for something about a comment.
  const atPost = (id: number) => `${SITE_URL}/#post-${id}`;
  const atComment = (id: number) => `${SITE_URL}/#comment-${id}`;

  if (kind === 'invite') {
    const { type, from_user, to_user, group_id: gid } = record ?? {};
    if (!from_user || !to_user) return new Response('ignored', { status: 200 });
    const [[from], group] = await Promise.all([
      rest(`profiles?id=eq.${from_user}&select=username,display_name`),
      gid ? rest(`groups?id=eq.${gid}&select=name`) : Promise.resolve([]),
    ]);
    if (!from) return new Response('ignored', { status: 200 });
    const isGroup = type === 'group' && group?.[0];
    return blast([to_user], JSON.stringify({
      title: 'Quota',
      body: socialFor(isGroup ? 'group' : 'friend', who(from), isGroup ? group[0].name : null),
      url: `${SITE_URL}/#${isGroup ? 'groups' : 'friends'}`,
      tag: `invite-${record.id ?? to_user}`,
    }));
  }

  // A story is gone in a day, so its notification goes to the story rather than to a post.
  if (kind === 'story_like' || kind === 'story_reaction') {
    const { story_id, user_id: actor, emoji } = record ?? {};
    if (!story_id || !actor) return new Response('ignored', { status: 200 });
    const [[story], [from]] = await Promise.all([
      rest(`stories?id=eq.${story_id}&select=user_id`),
      rest(`profiles?id=eq.${actor}&select=username,display_name`),
    ]);
    if (!story || !from || story.user_id === actor) return new Response('ignored', { status: 200 });
    return blast([story.user_id], JSON.stringify({
      title: 'Quota',
      body: socialFor(kind, who(from), kind === 'story_reaction' ? emoji : null),
      url: `${SITE_URL}/#story-${story.user_id}`,
      tag: kind === 'story_reaction' ? `story-reaction-${story_id}-${emoji}` : `story-like-${story_id}`,
    }));
  }

  // Somebody liked a comment. The person to tell is whoever wrote it, not whoever owns
  // the post it sits under.
  if (kind === 'comment_like') {
    const { comment_id, user_id: actor } = record ?? {};
    if (!comment_id || !actor) return new Response('ignored', { status: 200 });
    const [[comment], [from]] = await Promise.all([
      rest(`comments?id=eq.${comment_id}&select=user_id,body`),
      rest(`profiles?id=eq.${actor}&select=username,display_name`),
    ]);
    if (!comment || !from || comment.user_id === actor) return new Response('ignored', { status: 200 });
    return blast([comment.user_id], JSON.stringify({
      title: 'Quota',
      body: socialFor('comment_like', who(from), comment.body),
      url: atComment(comment_id),
      tag: `comment-like-${comment_id}`,
    }));
  }

  // Somebody said yes. A friendship names a pair and nothing else, so who to tell is
  // whichever half of it did not just accept.
  if (kind === 'accepted_friend') {
    const { a, b, actor } = record ?? {};
    if (!a || !b || !actor) return new Response('ignored', { status: 200 });
    const tell = actor === a ? b : a;
    const [from] = await rest(`profiles?id=eq.${actor}&select=username,display_name`);
    if (!from) return new Response('ignored', { status: 200 });
    return blast([tell], JSON.stringify({
      title: 'Quota', body: socialFor('accepted_friend', who(from)),
      url: `${SITE_URL}/#friends`, tag: `accepted-${actor}`,
    }));
  }

  // Somebody joined a group. Only when they did it themselves — create_group() and an
  // invite being written both land in the same table, and neither is news.
  if (kind === 'accepted_group') {
    const { group_id: gid, user_id: joined, actor } = record ?? {};
    if (!gid || !joined || actor !== joined) return new Response('ignored', { status: 200 });
    const [[group], members, [from]] = await Promise.all([
      rest(`groups?id=eq.${gid}&select=name`),
      rest(`group_members?group_id=eq.${gid}&user_id=neq.${joined}&select=user_id`),
      rest(`profiles?id=eq.${joined}&select=username,display_name`),
    ]);
    if (!group || !from || !members.length) return new Response('nobody to notify', { status: 200 });
    return blast(members.map((m: { user_id: string }) => m.user_id), JSON.stringify({
      title: group.name, body: socialFor('joined_group', who(from), group.name),
      url: `${SITE_URL}/#groups`, tag: `joined-${gid}-${joined}`,
    }));
  }

  // Somebody said something. A group's chat goes to the group; a private one goes to the
  // other half of the pair. The link is the chat as the person reading it names it, which
  // for a private one is the sender rather than themselves.
  if (kind === 'message') {
    const { group_id: gid, a, b, user_id: actor, body: said } = record ?? {};
    if (!actor) return new Response('ignored', { status: 200 });
    const [from] = await rest(`profiles?id=eq.${actor}&select=username,display_name`);
    if (!from) return new Response('ignored', { status: 200 });
    if (gid) {
      const [[group], members] = await Promise.all([
        rest(`groups?id=eq.${gid}&select=name`),
        rest(`group_members?group_id=eq.${gid}&user_id=neq.${actor}&select=user_id`),
      ]);
      if (!group) return new Response('ignored', { status: 200 });
      return blast(members.map((m: { user_id: string }) => m.user_id), JSON.stringify({
        title: group.name, body: chatFor(who(from), said, group.name),
        url: `${SITE_URL}/#chat-g:${gid}`, tag: `chat-g-${gid}`,
      }));
    }
    const to = a === actor ? b : a;
    if (!to) return new Response('ignored', { status: 200 });
    return blast([to], JSON.stringify({
      title: 'Quota', body: chatFor(who(from), said),
      url: `${SITE_URL}/#chat-u:${actor}`, tag: `chat-u-${actor}`,
    }));
  }

  // Somebody reacted to a line. Only whoever wrote it is told.
  if (kind === 'message_reaction') {
    const { message_id, user_id: actor, emoji } = record ?? {};
    if (!message_id || !actor) return new Response('ignored', { status: 200 });
    const [[msg], [from]] = await Promise.all([
      rest(`messages?id=eq.${message_id}&select=user_id,group_id,a,b`),
      rest(`profiles?id=eq.${actor}&select=username,display_name`),
    ]);
    if (!msg || !from || msg.user_id === actor) return new Response('ignored', { status: 200 });
    const where = msg.group_id ? `g:${msg.group_id}` : `u:${actor}`;
    return blast([msg.user_id], JSON.stringify({
      title: 'Quota', body: socialFor('message_reaction', who(from), emoji),
      url: `${SITE_URL}/#chat-${where}`, tag: `msgreact-${message_id}-${emoji}`,
    }));
  }

  // Somebody questioned a post, or the group finished deciding about one. Everyone in the
  // group hears either way, and the person it is about hears a different sentence: they are
  // being told, not asked, because they do not get a vote on their own.
  if (kind === 'flag' || kind === 'flag_closed') {
    const { id, post_id, by_user, outcome } = record ?? {};
    if (!post_id) return new Response('ignored', { status: 200 });
    const [[post], [raiser]] = await Promise.all([
      rest(`posts?id=eq.${post_id}&select=user_id,group_id,metric,amount,challenge`),
      by_user ? rest(`profiles?id=eq.${by_user}&select=username,display_name`) : Promise.resolve([{}]),
    ]);
    if (!post) return new Response('ignored', { status: 200 });
    const members = await rest(`group_members?group_id=eq.${post.group_id}&select=user_id`);
    const what = `${post.amount} ${post.challenge ? `${post.challenge} ` : ''}${post.metric}`;
    const url = id ? `${SITE_URL}/#flag-${id}` : atPost(post_id);
    // The owner is told about their own; everyone else is asked. Two blasts rather than
    // one, because the same words cannot be right for both.
    const others = members.map((m: { user_id: string }) => m.user_id)
      .filter((u: string) => u !== post.user_id && (kind === 'flag_closed' || u !== by_user));
    const line = (mine: boolean) => kind === 'flag'
      ? flagFor(raiser?.username ? who(raiser) : 'Someone', what, mine)
      : verdictFor(what, outcome === 'upheld', mine);
    const tag = `flag-${id ?? post_id}${kind === 'flag_closed' ? '-done' : ''}`;
    await blast([post.user_id], JSON.stringify({ title: 'Quota', body: line(true), url, tag }));
    return blast(others, JSON.stringify({ title: 'Quota', body: line(false), url, tag }));
  }

  if (kind === 'comment' || kind === 'like' || kind === 'reaction') {
    const { post_id, user_id: actor, body: text, emoji } = record ?? {};
    if (!post_id || !actor) return new Response('ignored', { status: 200 });
    const [[post], [from]] = await Promise.all([
      rest(`posts?id=eq.${post_id}&select=user_id,group_id`),
      rest(`profiles?id=eq.${actor}&select=username,display_name`),
    ]);
    // Nobody needs telling about their own.
    if (!post || !from || post.user_id === actor) return new Response('ignored', { status: 200 });
    return blast([post.user_id], JSON.stringify({
      title: 'Quota',
      body: socialFor(kind, who(from), kind === 'comment' ? text : kind === 'reaction' ? emoji : null),
      // A comment lands on the comment; a like or a reaction is about the post itself.
      url: kind === 'comment' && record.id ? atComment(record.id) : atPost(post_id),
      // A reaction is tagged by the emoji so two different ones do not replace each other.
      tag: kind === 'reaction' ? `reaction-${post_id}-${emoji}` : `${kind}-${post_id}`,
    }));
  }

  if (!record?.group_id) return new Response('ignored', { status: 200 });
  const { group_id, user_id, metric, amount, day, challenge } = record;

  const [[group], [poster], members, dayPosts] = await Promise.all([
    rest(`groups?id=eq.${group_id}&select=name,quotas`),
    rest(`profiles?id=eq.${user_id}&select=username,display_name`),
    rest(`group_members?group_id=eq.${group_id}&user_id=neq.${user_id}&select=user_id`),
    rest(`posts?group_id=eq.${group_id}&user_id=eq.${user_id}&day=eq.${day}&select=metric,amount`),
  ]);
  if (!group || !poster || !members.length) return new Response('nobody to notify', { status: 200 });

  // dayPosts already includes the row that fired this trigger.
  const body = messageFor(poster.display_name || poster.username, metric, amount, group.quotas ?? [], dayPosts, challenge, group.name);

  return blast(
    members.map((m: { user_id: string }) => m.user_id),
    JSON.stringify({ title: group.name, body, url: atPost(record.id), tag: `group-${group_id}` }),
  );
});
