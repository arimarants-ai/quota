// Moderation, for the two people in `moderators`. Deployed with JWT verification on, and
// every action checks am_moderator() as the caller as well: being signed in is not enough.
//
//   { action: 'polish', raw, report_id? }                  -> { polished }
//   { action: 'decide', report_id, decision: 'kept'|'removed', raw, polished, serious }
//       -> { result, email: { sent, error }, pushed }
//   { action: 'retry_email', report_id }                   -> { sent, error }
//
// The decision itself is moderate_report() in the database, called as the moderator, so it
// is one transaction and records who made it. What only a server can do follows it: the
// poster's email address is read here with the service role and never reaches the app, the
// email goes out through Resend, and whoever reported it is thanked by push.
//
// Secrets: RESEND_API_KEY, ANTHROPIC_API_KEY (polish falls back without it), and the push
// ones notify already has.
import { send, type Subscription } from '../notify/push.ts';
import { reportDecidedFor, thingWord } from '../notify/message.ts';
import { FROM, REPLY_TO, postedOn, takedownEmail, undeliverable } from './emails.ts';
import { polish } from './polish.ts';

const secret = (k: string) => (typeof Deno !== 'undefined' ? Deno.env.get(k) : undefined) ?? '';
const SUPABASE_URL = secret('SUPABASE_URL');
const SERVICE_KEY = secret('SUPABASE_SERVICE_ROLE_KEY');
const ANON_KEY = secret('SUPABASE_ANON_KEY');
const RESEND_KEY = secret('RESEND_API_KEY');
const ANTHROPIC_KEY = secret('ANTHROPIC_API_KEY');
const VAPID = { publicKey: secret('VAPID_PUBLIC_KEY'), privateKey: secret('VAPID_PRIVATE_KEY'), subject: secret('VAPID_SUBJECT') || 'mailto:hello@hitquota.app' };
const SITE_URL = secret('SITE_URL') || 'https://app.hitquota.app';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });

// As the service role: for the poster's address, and for writing down how the email went.
const svc = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${SUPABASE_URL}/${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`${path.split('?')[0]} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
};
const one = async (path: string) => ((await svc(`rest/v1/${path}`)) as any[])[0] ?? null;

// As the person calling, so the database decides what they may do.
const asUser = (auth: string) => async (fn: string, args: unknown) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST', body: JSON.stringify(args),
    headers: { apikey: ANON_KEY, Authorization: auth, 'Content-Type': 'application/json' },
  });
  const body = await res.json().catch(() => null);
  return res.ok ? { data: body, error: null } : { data: null, error: body?.message || `${fn} -> ${res.status}` };
};

// Who posted it, where and when, read off the thing if it is still there and off the copy
// the report saved if it is not (v58): a comment can go with the post it was under, and the
// email still has to say when it was posted.
async function factsOf(r: any) {
  let owner = r.user_id, gid = r.group_id, at = r.thing_posted_at || r.created_at, path = r.media_path;
  try {
    if (r.what === 'post') {
      const p = await one(`posts?id=eq.${r.thing_id}&select=user_id,group_id,created_at,video_path`);
      if (p) { owner = p.user_id; gid = p.group_id; at = p.created_at; path = p.video_path; }
    } else if (r.what === 'story') {
      const s = await one(`stories?id=eq.${r.thing_id}&select=user_id,created_at,media_path`);
      if (s) { owner = s.user_id; at = s.created_at; path = s.media_path; }
    } else if (r.what === 'comment') {
      const c = await one(`comments?id=eq.${r.thing_id}&select=user_id,created_at,post_id`);
      if (c) {
        owner = c.user_id; at = c.created_at;
        gid = (await one(`posts?id=eq.${c.post_id}&select=group_id`))?.group_id ?? gid;
      }
    } else if (r.what === 'message') {
      const m = await one(`messages?id=eq.${r.thing_id}&select=user_id,group_id,created_at`);
      if (m) { owner = m.user_id; gid = m.group_id; at = m.created_at; }
    }
  } catch (e) { console.warn('moderation: reading the thing failed', String(e)); }
  const [poster, group] = await Promise.all([
    one(`profiles?id=eq.${owner}&select=username,display_name,tz`),
    gid ? one(`groups?id=eq.${gid}&select=name`) : Promise.resolve(null),
  ]);
  return { owner, poster, group: group?.name ?? null, at, thing: thingWord(r.what, path) };
}

// The email for a take-down, and a note on the report of how it went.
async function emailFor(reportId: number): Promise<{ sent: boolean; error: string | null }> {
  const r = await one(`reports?id=eq.${reportId}&select=*`);
  if (!r || r.resolution !== 'removed') return { sent: false, error: 'not a take-down' };
  const f = await factsOf(r);
  let error: string | null = null;
  try {
    const user = await svc(`auth/v1/admin/users/${f.owner}`) as { email?: string };
    if (undeliverable(user?.email)) error = 'no email address on the account';
    else if (!RESEND_KEY) error = 'RESEND_API_KEY is not set';
    else {
      const mail = takedownEmail({
        name: f.poster?.display_name || f.poster?.username, thing: f.thing, group: f.group,
        date: postedOn(f.at, f.poster?.tz), reason: r.polished_reason || r.raw_reason,
        strikeNo: r.strike_no, suspended: r.suspended, selfHarm: r.reason === 'self_harm',
      });
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: FROM, to: [user.email], reply_to: REPLY_TO, subject: mail.subject, html: mail.html, text: mail.text }),
      });
      if (!res.ok) error = `Resend ${res.status}: ${(await res.text()).slice(0, 300)}`;
    }
  } catch (e) { error = String(e).slice(0, 300); }
  if (error) console.error('moderation: email failed for report', reportId, error);
  // Every report the one decision closed carries the same outcome.
  const same = r.thing_id == null ? `thing_id=is.null&user_id=eq.${r.user_id}` : `thing_id=eq.${r.thing_id}`;
  await svc(`rest/v1/reports?what=eq.${r.what}&${same}&resolved_at=eq.${encodeURIComponent(r.resolved_at)}`, {
    method: 'PATCH', body: JSON.stringify(error ? { email_error: error } : { email_sent_at: new Date().toISOString(), email_error: null }),
  }).catch(e => console.error('moderation: could not record the email outcome', String(e)));
  return { sent: !error, error };
}

// Push to a list of people, pruning subscriptions the browser threw away.
async function blast(ids: string[], payload: string) {
  if (!ids.length || !VAPID.publicKey) return 0;
  const subs = await svc(`rest/v1/push_subscriptions?user_id=in.(${ids.join(',')})&select=endpoint,p256dh,auth`) as (Subscription & { endpoint: string })[];
  let sent = 0;
  for (const s of subs) {
    try {
      const status = await send(s, payload, VAPID);
      if (status >= 200 && status < 300) sent++;
      if (status === 404 || status === 410) await svc(`rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: 'DELETE' }).catch(() => {});
    } catch (e) { console.warn('moderation: push failed', String(e)); }
  }
  return sent;
}

if (typeof Deno !== 'undefined') Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const auth = req.headers.get('Authorization') || '';
  const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY, Authorization: auth } });
  if (!who.ok) return json({ error: 'not signed in' }, 401);
  const rpc = asUser(auth);
  const mod = await rpc('am_moderator', {});
  if (mod.data !== true) return json({ error: 'only a moderator can do this' }, 403);
  let body: Record<string, any>;
  try { body = await req.json(); } catch { return json({ error: 'bad request' }, 400); }

  try {
    if (body.action === 'polish') {
      let thing = 'post';
      if (body.report_id) {
        const r = await one(`reports?id=eq.${Number(body.report_id)}&select=what,media_path`).catch(() => null);
        if (r) thing = thingWord(r.what, r.media_path);
      }
      const { polished } = await polish(String(body.raw ?? ''), { key: ANTHROPIC_KEY, thing });
      return json({ polished });
    }

    if (body.action === 'decide') {
      const id = Number(body.report_id);
      const decision = body.decision === 'removed' ? 'removed' : body.decision === 'kept' ? 'kept' : '';
      if (!id || !decision) return json({ error: 'report_id and decision are needed' }, 400);
      const { data: result, error } = await rpc('moderate_report', {
        p_report_id: id, p_decision: decision, p_raw: body.raw ?? null, p_polished: body.polished ?? null, p_serious: !!body.serious,
      });
      if (error) return json({ error }, 400);
      const email = decision === 'removed' ? await emailFor(id) : { sent: false, error: null };
      const pushed = await blast((result?.reporters ?? []).filter(Boolean), JSON.stringify({
        title: 'Quota', body: reportDecidedFor(decision === 'removed'), url: `${SITE_URL}/`, tag: `report-decided-${id}`,
      })).catch(e => { console.warn('moderation: thank-you push failed', String(e)); return 0; });
      return json({ result, email, pushed });
    }

    if (body.action === 'retry_email') {
      const id = Number(body.report_id);
      if (!id) return json({ error: 'report_id is needed' }, 400);
      return json(await emailFor(id));
    }

    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    console.error('moderation:', body.action, String(e));
    return json({ error: 'something went wrong' }, 500);
  }
});
