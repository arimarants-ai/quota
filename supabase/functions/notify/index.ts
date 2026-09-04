// Fan out a push notification to a group when someone posts proof.
// Called by the posts_notify trigger in schema.sql (v4).
import { send, type Subscription } from './push.ts';
import { messageFor } from './message.ts';

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

  const { record } = await req.json();
  if (!record?.group_id) return new Response('ignored', { status: 200 });
  const { group_id, user_id, metric, amount, day } = record;

  const [[group], [poster], members, dayPosts] = await Promise.all([
    rest(`groups?id=eq.${group_id}&select=name,quotas`),
    rest(`profiles?id=eq.${user_id}&select=username,display_name`),
    rest(`group_members?group_id=eq.${group_id}&user_id=neq.${user_id}&select=user_id`),
    rest(`posts?group_id=eq.${group_id}&user_id=eq.${user_id}&day=eq.${day}&select=metric,amount`),
  ]);
  if (!group || !poster || !members.length) return new Response('nobody to notify', { status: 200 });

  // dayPosts already includes the row that fired this trigger.
  const body = messageFor(poster.display_name || poster.username, metric, amount, group.quotas ?? [], dayPosts);

  const payload = JSON.stringify({ title: group.name, body, url: `${SITE_URL}/`, tag: `group-${group_id}` });

  const ids = members.map((m: { user_id: string }) => m.user_id);
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
});
