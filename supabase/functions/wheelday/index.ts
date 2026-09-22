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
// Who to tell when the machinery stops. Unset and none of this runs: an alarm with nowhere
// to ring is not worth a query an hour.
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? '';

const rest = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...init.headers },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
};

import { NOTICE_META, noticeBody, remindersFor, type Due, type Notice } from './message.ts';
import { SWEEP_MAX, sweepStories, type StoryRow } from './sweep.ts';
import { cronAlertBody, cronAlertDue, type CronFail } from './health.ts';

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
  const [due, notices] = await Promise.all([
    rest('rpc/wheel_due_now', { method: 'POST', body: '{}' }) as Promise<Due[]>,
    // A project that has not run the v34 block has no such function; that is not a reason
    // for spin day to stop working.
    (rest('rpc/notices_due_now', { method: 'POST', body: '{}' }) as Promise<Notice[]>).catch(() => []),
  ]);

  const spin = due.length
    ? await blast(remindersFor(due), 'Today is wheel spin day', 'wheel-day')
    : { people: 0, sent: 0, pruned: 0 };

  // The database already decided who gets what; all that is left is to say it. Each kind
  // goes out as its own blast because the title and the tag differ, and the tag is what
  // makes the lapsed message replace the window one instead of landing beside it.
  const byKind = new Map<Notice['kind'], Map<string, string>>();
  for (const n of notices) {
    const m = byKind.get(n.kind) ?? new Map<string, string>();
    m.set(n.user_id, noticeBody(n));
    byKind.set(n.kind, m);
  }
  const day: Record<string, unknown> = {};
  for (const [kind, msgs] of byKind) {
    const meta = NOTICE_META[kind];
    day[kind] = await blast(msgs, meta.title, meta.tag);
  }

  // And the third thing on this beat: yesterday's stories. It is here rather than in
  // pg_cron because deleting a file is the storage API's job and SQL is no longer allowed
  // to do it — see sweep.ts.
  const swept = await sweepStories({
    list: (cutoff, limit) =>
      rest(`stories?created_at=lt.${encodeURIComponent(cutoff)}&select=id,media_path&order=created_at.asc&limit=${limit}`) as Promise<StoryRow[]>,
    removeFiles: async (paths) => {
      const res = await fetch(`${SUPABASE_URL}/storage/v1/object/stories`, {
        method: 'DELETE',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes: paths }),
      });
      return res.ok;
    },
    removeRows: async (ids) => { await rest(`stories?id=in.(${ids.join(',')})`, { method: 'DELETE' }); },
  }).catch(e => ({ rows: 0, files: 0, held: true, error: String(e) }));

  // Is anything else on this schedule broken? Nothing else asks, which is how stories-expire
  // managed to fail for a day without a word.
  const health = await (async () => {
    if (!OWNER_USER_ID) return { checked: false };
    const rows: CronFail[] = await (rest('rpc/cron_health', { method: 'POST', body: '{}' }) as Promise<CronFail[]>)
      .catch(() => []);
    if (!cronAlertDue(rows)) return { checked: true, failing: 0 };
    // Once a day, not once an hour: an alarm that goes off hourly gets silenced. The claim
    // is day_reminders, which exists to say exactly this — one row per person per day per
    // kind — so nothing new is needed to remember we have already said it.
    const today = new Date().toISOString().slice(0, 10);
    const claimed = await rest('day_reminders', {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify([{ user_id: OWNER_USER_ID, day: today, kind: 'cronalert' }]),
    }).catch(() => []);
    if (!Array.isArray(claimed) || !claimed.length) return { checked: true, failing: rows.length, said: false };
    const sent = await blast(new Map([[OWNER_USER_ID, cronAlertBody(rows)]]), 'Quota needs a look', 'cron-health');
    return { checked: true, failing: rows.length, said: true, sent };
  })();

  return Response.json({ due: due.length, spin, notices: notices.length, day, swept, sweepMax: SWEEP_MAX, health });
});
