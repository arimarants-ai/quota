// Fan out a push notification to a group when someone posts proof.
// Called by the posts_notify trigger in schema.sql (v4).
import { send, type Subscription } from './push.ts';
import { messageFor, socialFor, who } from './message.ts';

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

  // A notification is worth tapping only if it lands on the thing it is about.
  const atPost = (id: number) => `${SITE_URL}/#post-${id}`;

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
      url: atPost(post_id),
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
  const body = messageFor(poster.display_name || poster.username, metric, amount, group.quotas ?? [], dayPosts, challenge);

  return blast(
    members.map((m: { user_id: string }) => m.user_id),
    JSON.stringify({ title: group.name, body, url: atPost(record.id), tag: `group-${group_id}` }),
  );
});
