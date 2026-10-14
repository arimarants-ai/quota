// Signed URLs for proof on Cloudflare R2.
//
// The app never holds an R2 key. It asks here, as itself, and gets back URLs that do one
// thing to one file for a few minutes. What it is allowed to ask for is in rules.ts, which
// is the storage policies the Supabase buckets had, moved to where R2 can be guarded.
//
//   { action: 'sign-upload', group_id, ext, contentType, size, thumbSize? }
//   { action: 'sign-upload', story: true, ext, contentType, size }
//       -> { key, url, headers, thumb: { key, url, headers } | null, expiresIn }
//   { action: 'sign-view', paths: [...] }  -> { urls: { [path]: url | null }, until }
//   { action: 'delete', paths: [...] }     -> { deleted: [...], refused: [...] }
//
// Deployed with JWT verification on: nobody signed out gets as far as this file.
import { canDelete, canView, CACHE_CONTROL, cleanKey, kindOf, MAX_PATHS, planUpload, STORY_PREFIX, UPLOAD_SECONDS, viewWindow } from './rules.ts';
import { presign, removeObject } from './r2.ts';

const SUPABASE_URL = typeof Deno !== 'undefined' ? Deno.env.get('SUPABASE_URL')! : '';
const SERVICE_KEY = typeof Deno !== 'undefined' ? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')! : '';
const ANON_KEY = typeof Deno !== 'undefined' ? Deno.env.get('SUPABASE_ANON_KEY')! : '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });

// As the service role, for the one question the person cannot ask about themselves
// without a policy in the way: which groups they are in.
const rest = async (path: string) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
  if (!res.ok) throw new Error(`${path.split('?')[0]} -> ${res.status}`);
  return res.json();
};

// is_member(), for every group at once.
const groupsOf = async (uid: string) =>
  new Set<number>((await rest(`group_members?select=group_id&user_id=eq.${uid}`) as { group_id: number }[]).map(r => Number(r.group_id)));

// Which of these story files the person may watch, decided by the stories table's own
// policy: the query runs as them, so a row comes back exactly when the bucket policy would
// have said yes.
async function visibleStories(auth: string, keys: string[]) {
  if (!keys.length) return new Set<string>();
  const list = keys.map(k => `"${k}"`).join(',');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/stories?select=media_path&media_path=in.(${encodeURIComponent(list)})`,
    { headers: { apikey: ANON_KEY, Authorization: auth } });
  if (!res.ok) return new Set<string>();
  return new Set<string>((await res.json() as { media_path: string }[]).map(r => r.media_path));
}

const paths = (v: unknown) => Array.isArray(v) ? [...new Set(v.filter(cleanKey))].slice(0, MAX_PATHS) : [];

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const auth = req.headers.get('Authorization') || '';
  const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY, Authorization: auth } });
  if (!who.ok) return json({ error: 'not signed in' }, 401);
  const uid = String((await who.json()).id || '');
  if (!uid) return json({ error: 'not signed in' }, 401);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'bad request' }, 400); }

  try {
    if (body.action === 'sign-upload') {
      const plan = planUpload(body, uid, Date.now());
      if (typeof plan === 'string') return json({ error: plan }, 400);
      if (plan.group !== null && !(await groupsOf(uid)).has(plan.group)) return json({ error: 'not a member of that group' }, 403);
      const headers = (type: string, size: number) => ({ 'Content-Type': type, 'Cache-Control': CACHE_CONTROL, 'Content-Length': String(size) });
      const put = headers(plan.contentType, plan.size);
      const thumb = plan.thumb && { key: plan.thumb.key, headers: headers('image/jpeg', plan.thumb.size) };
      return json({
        key: plan.key, url: await presign('PUT', plan.key, UPLOAD_SECONDS, put), headers: put,
        thumb: thumb && { ...thumb, url: await presign('PUT', thumb.key, UPLOAD_SECONDS, thumb.headers) },
        expiresIn: UPLOAD_SECONDS,
      });
    }

    if (body.action === 'sign-view') {
      const keys = paths(body.paths);
      const proof = keys.filter(k => kindOf(k)?.bucket === 'proof');
      const stories = keys.filter(k => k.startsWith(STORY_PREFIX));
      const [groups, seen] = await Promise.all([
        proof.length ? groupsOf(uid) : Promise.resolve(new Set<number>()),
        visibleStories(auth, stories),
      ]);
      const w = viewWindow(Date.now());
      const urls: Record<string, string | null> = {};
      for (const k of keys) urls[k] = canView(k, groups, seen) ? await presign('GET', k, w.expires, {}, w.signedAt) : null;
      return json({ urls, until: w.until });
    }

    if (body.action === 'delete') {
      const keys = paths(body.paths);
      const deleted: string[] = [], refused: string[] = [];
      for (const k of keys) {
        if (canDelete(k, uid) && await removeObject(k)) deleted.push(k); else refused.push(k);
      }
      return json({ deleted, refused });
    }

    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    console.error('media:', body.action, String(e));
    return json({ error: 'something went wrong' }, 500);
  }
});
