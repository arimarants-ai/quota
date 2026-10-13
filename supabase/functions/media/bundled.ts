// GENERATED — do not edit. Built from rules.ts, r2.ts, index.ts by test/bundle.mjs.
// This is the same function in one file, for pasting into the Supabase dashboard when
// the CLI is not to hand. Deploying either one gives the same behaviour.

// Who may put a file where, and who may look at it, for proof kept on Cloudflare R2.
//
// R2 has no row level security, so the rules Supabase Storage enforced on the `proof` and
// `stories` buckets are enforced here instead, before anything is signed. They are the
// policies on storage.objects as they stand in the live project (pg_policies), and no
// looser:
//
//   proof   "members watch proof"        select  is_member(folder[1])
//           "members upload own proof"   insert  folder[2] = auth.uid() and is_member(folder[1])
//           "delete own proof"           delete  folder[2] = auth.uid()
//   stories "watch stories you can see"  select  a story row with this media_path that
//                                                can_see_user(owner) and is under 24 hours old
//           "upload your own story"      insert  folder[1] = auth.uid()
//           "delete your own story file" delete  folder[1] = auth.uid()
//
// "the group's maker removes proof" is not here. As written it compares the group id with
// storage.foldername(g.name) — the group's own name, not the file's — so it has never let
// anybody delete anything, and copying what it was meant to say would be a looser rule than
// the one in force.
//
// Both buckets share one R2 bucket. A story keeps its Supabase name under `stories/`, and
// proof keeps its own, which always starts with a group id, so the two cannot collide.
//
// Kept apart from index.ts so it runs and is checked without Deno or any secret.

export const STORY_PREFIX = 'stories/';
export const UPLOAD_SECONDS = 600;
export const VIEW_SECONDS = 3600;
// Sizes are the buckets' own limits (storage.buckets.file_size_limit).
export const PROOF_MAX = 52428800;
export const STORY_MAX = 26214400;
export const POSTER_MAX = 2 * 1048576;
export const CACHE_CONTROL = 'private, max-age=31536000, immutable';
export const MAX_PATHS = 200;

const VIDEO_EXT = new Set(['mp4', 'mov', 'webm', 'm4v']);
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'gif', 'avif']);
// What each bucket accepted (storage.buckets.allowed_mime_types).
const PROOF_TYPE = /^(video|image)\/[a-z0-9.+-]+$/;
const STORY_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm']);

export const isVideoKey = (key: string) => VIDEO_EXT.has((key.split('.').pop() || '').toLowerCase());
export const posterOf = (key: string) => `${key}.jpg`;

// storage.foldername(): every segment but the last.
export const folders = (name: string) => name.split('/').slice(0, -1);

// A key this function will sign at all. Nothing that climbs, nothing absolute, nothing
// that is not a plain name.
export function cleanKey(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && key.length <= 512
    && /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/.test(key)
    && !key.split('/').some(s => s === '.' || s === '..');
}

export type Kind = { bucket: 'proof'; group: number; owner: string } | { bucket: 'stories'; owner: string };

// Which bucket's rules a key answers to, and what its folders say. null for anything that
// fits neither shape — is_member() on a folder that is not a number is an error in SQL,
// which is a no.
export function kindOf(key: string): Kind | null {
  if (!cleanKey(key)) return null;
  if (key.startsWith(STORY_PREFIX)) {
    const f = folders(key.slice(STORY_PREFIX.length));
    return f.length >= 1 ? { bucket: 'stories', owner: f[0] } : null;
  }
  const f = folders(key);
  if (f.length < 2 || !/^[0-9]{1,18}$/.test(f[0])) return null;
  return { bucket: 'proof', group: Number(f[0]), owner: f[1] };
}

// "members watch proof" for proof; for a story, the row has to be one the person can read,
// which the stories table's own policy decides (can_see_user and the 24 hours) — the
// caller asks it as them and passes in which keys came back.
export function canView(key: string, groups: Set<number>, visibleStories: Set<string>): boolean {
  const k = kindOf(key);
  if (!k) return false;
  return k.bucket === 'proof' ? groups.has(k.group) : visibleStories.has(key);
}

export function canDelete(key: string, uid: string): boolean {
  const k = kindOf(key);
  return !!k && k.owner === uid;
}

export type UploadAsk = { group_id?: unknown; story?: unknown; ext?: unknown; contentType?: unknown; size?: unknown; thumbSize?: unknown };
export type UploadPlan = { key: string; contentType: string; size: number; thumb: { key: string; size: number } | null; group: number | null };

// Builds the key from who is asking and when, never from anything the request says about
// where it should go. Returns a reason instead when the ask itself is wrong; whether the
// person is in the group is the caller's to check (it needs the database).
export function planUpload(ask: UploadAsk, uid: string, now: number): UploadPlan | string {
  const ext = String(ask.ext ?? '').toLowerCase().replace(/^\./, '');
  if (!VIDEO_EXT.has(ext) && !IMAGE_EXT.has(ext)) return 'that kind of file is not proof';
  const contentType = String(ask.contentType ?? '').toLowerCase();
  const size = Number(ask.size);
  const story = ask.story === true;
  if (story ? !STORY_TYPES.has(contentType) : !PROOF_TYPE.test(contentType)) return 'that content type is not allowed';
  if (!Number.isInteger(size) || size <= 0) return 'size is required';
  if (size > (story ? STORY_MAX : PROOF_MAX)) return 'too big';
  const thumbSize = ask.thumbSize == null ? null : Number(ask.thumbSize);
  if (thumbSize !== null && (!Number.isInteger(thumbSize) || thumbSize <= 0 || thumbSize > POSTER_MAX)) return 'that still is the wrong size';
  if (!/^[0-9a-f-]{36}$/.test(uid)) return 'not signed in';
  let key: string, group: number | null = null;
  if (story) key = `${STORY_PREFIX}${uid}/${now}.${ext}`;
  else {
    group = Number(ask.group_id);
    if (!Number.isSafeInteger(group) || group <= 0) return 'which group?';
    key = `${group}/${uid}/${now}.${ext}`;
  }
  // A still only goes beside a clip, which is the only thing that has one.
  const thumb = thumbSize !== null && VIDEO_EXT.has(ext) ? { key: posterOf(key), size: thumbSize } : null;
  return { key, contentType, size, thumb, group };
}

// A signed GET is the same URL for the length of a window, so a browser that already
// fetched it can answer from its own cache instead of downloading the clip again. Each one
// is good for at least VIEW_SECONDS from the moment it is handed out.
export const VIEW_WINDOW = 1800;
export function viewWindow(nowMs: number) {
  const start = Math.floor(nowMs / 1000 / VIEW_WINDOW) * VIEW_WINDOW;
  return { signedAt: new Date(start * 1000), expires: VIEW_SECONDS + VIEW_WINDOW, until: (start + VIEW_SECONDS + VIEW_WINDOW) * 1000 };
}

// Talking to Cloudflare R2 through its S3 API. aws4fetch rather than the AWS SDK: it is a
// few kilobytes of SigV4 and nothing else, which is all a signed URL needs.
//
// Needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET as function
// secrets. Nothing here ever prints them.
import { AwsClient } from 'npm:aws4fetch@1.0.20';

const r2env = (k: string) => (typeof Deno !== 'undefined' ? Deno.env.get(k) : undefined) ?? '';

let client: AwsClient | null = null;
const r2 = () => client ??= new AwsClient({
  accessKeyId: r2env('R2_ACCESS_KEY_ID'), secretAccessKey: r2env('R2_SECRET_ACCESS_KEY'),
  service: 's3', region: 'auto',
});
// Path-style, so every object is under /<bucket>/ on one host — which is also what lets
// the app's service worker know an R2 file by its path whatever the signature on it.
export const objectUrl = (key: string) =>
  `https://${r2env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com/${r2env('R2_BUCKET')}/${key.split('/').map(encodeURIComponent).join('/')}`;

const stamp = (d: Date) => d.toISOString().replace(/[:-]|\.\d{3}/g, '');

// A URL that does one thing to one object until it runs out. Every header given here is
// signed, so whoever uses the URL has to send exactly these values.
export async function presign(method: 'GET' | 'PUT', key: string, seconds: number,
  headers: Record<string, string> = {}, signedAt?: Date): Promise<string> {
  const url = `${objectUrl(key)}?X-Amz-Expires=${seconds}`;
  const signed = await r2().sign(url, {
    method, headers,
    aws: { signQuery: true, allHeaders: true, ...(signedAt ? { datetime: stamp(signedAt) } : {}) },
  });
  return signed.url;
}

// Deleting something already gone is a success in S3, which is what a retry wants.
export async function removeObject(key: string): Promise<boolean> {
  const res = await r2().fetch(objectUrl(key), { method: 'DELETE' });
  await res.body?.cancel();
  return res.ok || res.status === 404;
}

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
