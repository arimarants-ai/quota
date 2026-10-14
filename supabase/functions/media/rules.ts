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
