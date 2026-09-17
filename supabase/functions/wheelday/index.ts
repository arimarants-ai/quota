// Tell people it is wheel spin day.
//
// Everything else the app pushes happens because someone did something. This one has to
// happen at a time, and "morning" is a different moment for each person, so pg_cron calls
// this once an hour and public.wheel_due_now() works out whose morning it is. That
// function also claims each reminder as it returns it, so an overlapping run or a retried
// call cannot wake the same person twice for the same spin.
import { send, type Subscription } from '../notify/push.ts';

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

import { endOfDayFor, remindersFor, type Due } from './message.ts';

// One place that sends, because there are two reasons to now and they prune dead
// subscriptions and count what went out identically.
type Sender = (payload: string, sub: Subscription & { endpoint: string }) => Promise<number>;

// Send one message to each of a set of people, and tidy up after the ones whose browser
// has thrown the subscription away. Both reminders below go through this.
async function blast(messages: Map<string, string>, title: string, tag: string) {
  const ids = [...messages.keys()];
  if (!ids.length) return { people: 0, sent: 0, pruned: 0 };
  const subs: (Subscription & { endpoint: string; user_id: string })[] =
    await rest(`push_subscriptions?user_id=in.(${ids.join(',')})&select=endpoint,p256dh,auth,user_id`);

  const results = await Promise.all(subs.map(async (s) => {
    const payload = JSON.stringify({
      title,
      body: messages.get(s.user_id),
      url: `${SITE_URL}/`,
      tag,                           // replaces yesterday's rather than stacking up
    });
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
  return {
    people: ids.length,
    sent: results.filter(r => r.status >= 200 && r.status < 300).length,
    pruned: dead.length,
  };
}

Deno.serve(async (req) => {
  // The cron job is the only caller; a shared secret keeps the endpoint from being driven
  // by anyone who finds the URL.
  if (req.headers.get('x-hook-secret') !== HOOK_SECRET) return new Response('forbidden', { status: 403 });

  // Two questions on the same hourly beat, because both are "whose clock says so right
  // now" and neither is worth a cron job, a function and a secret of its own. Each claims
  // what it returns, so an overlapping run cannot wake anybody twice.
  const [due, ending] = await Promise.all([
    rest('rpc/wheel_due_now', { method: 'POST', body: '{}' }) as Promise<Due[]>,
    // A project that has not run the v29 block has no such function; that is not a reason
    // for spin day to stop working.
    (rest('rpc/day_due_now', { method: 'POST', body: '{}' }) as Promise<{ user_id: string; line: string }[]>)
      .catch(() => []),
  ]);

  const spin = due.length
    ? await blast(remindersFor(due), 'Today is wheel spin day', 'wheel-day')
    : { people: 0, sent: 0, pruned: 0 };

  const late = ending.length
    ? await blast(new Map(ending.map(r => [r.user_id, endOfDayFor(r.line)])),
        'Your day is not done', 'day-end')
    : { people: 0, sent: 0, pruned: 0 };

  return Response.json({ due: due.length, spin, ending: ending.length, late });
});
