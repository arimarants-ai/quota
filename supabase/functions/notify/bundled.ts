// GENERATED — do not edit. Built from push.ts, message.ts and index.ts by test/bundle.mjs.
// This is the same function in one file, for pasting into the Supabase dashboard when
// the CLI is not to hand. Deploying either one gives the same behaviour.

// Web Push: VAPID auth (RFC 8292) + aes128gcm payload encryption (RFC 8291/8188).
// Web Crypto only, so this runs unchanged on Deno and Node.

const enc = new TextEncoder();
const subtle = crypto.subtle;

export const b64u = (b: ArrayBuffer | Uint8Array): string => {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = '';
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const unb64u = (s: string): Uint8Array => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
  return Uint8Array.from(b, c => c.charCodeAt(0));
};

const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

// HKDF-SHA256 (extract + expand in one call).
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8);
  return new Uint8Array(bits);
}

// The VAPID keypair is ECDSA; the JWK needs x and y, which we split off the public key.
async function vapidKey(publicKey: string, privateKey: string) {
  const raw = unb64u(publicKey);                       // 0x04 || X(32) || Y(32)
  if (raw.length !== 65 || raw[0] !== 0x04) throw new Error('VAPID public key must be a 65-byte uncompressed P-256 point');
  return subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256', ext: true,
    x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33, 65)), d: privateKey,
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/** Signed `Authorization: vapid ...` header value for one push endpoint. */
export async function vapidHeader(endpoint: string, publicKey: string, privateKey: string, subject: string) {
  const { origin } = new URL(endpoint);
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc.encode(JSON.stringify({
    aud: origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject,
  })));
  const signed = `${head}.${body}`;
  const key = await vapidKey(publicKey, privateKey);
  // Web Crypto returns the raw r||s ECDSA signature, which is exactly what JWS wants.
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(signed));
  return `vapid t=${signed}.${b64u(sig)}, k=${publicKey}`;
}

/** Encrypt a payload for one subscription. Returns the aes128gcm body. */
export async function encrypt(plaintext: string, p256dh: string, auth: string, salt?: Uint8Array) {
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  salt ??= crypto.getRandomValues(new Uint8Array(16));

  // Fresh sender keypair per message, per RFC 8291.
  const as = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await subtle.exportKey('raw', as.publicKey));

  const shared = new Uint8Array(await subtle.deriveBits(
    { name: 'ECDH', public: await subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []) },
    as.privateKey, 256,
  ));

  const ikm = await hkdf(authSecret, shared, cat(enc.encode('WebPush: info'), new Uint8Array([0]), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const key = await subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // 0x02 marks the last record; there is only ever one record here.
  const padded = cat(enc.encode(plaintext), new Uint8Array([2]));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, padded));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return cat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

export type Subscription = { endpoint: string; p256dh: string; auth: string };

/** Send one notification. Returns the HTTP status so callers can prune dead endpoints. */
export async function send(sub: Subscription, payload: string, opts: {
  publicKey: string; privateKey: string; subject: string; ttl?: number;
}): Promise<number> {
  const body = await encrypt(payload, sub.p256dh, sub.auth);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidHeader(sub.endpoint, opts.publicKey, opts.privateKey, opts.subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(opts.ttl ?? 86400),
    },
    body,
  });
  return res.status;
}

// Pure notification-text logic, kept out of index.ts so it can be tested without Deno.
export type Quota = { metric: string; target: number };
export type Post = { metric: string; amount: number };

/**
 * Text for a new post. `dayPosts` is everything the poster has logged in this
 * group today, including the post that just landed. `challenge` is what the wheel
 * gave them, when the post was marked as done with it: "did 25 decline pushups"
 * rather than "did 25 pushups".
 */
export function messageFor(name: string, metric: string, amount: number, quotas: Quota[], dayPosts: Post[], challenge?: string | null): string {
  const totals = new Map<string, number>();
  for (const p of dayPosts) totals.set(p.metric, (totals.get(p.metric) ?? 0) + p.amount);

  const hit = (q: Quota, minus = 0) => (totals.get(q.metric) ?? 0) - minus >= q.target;
  // Only the post that crosses the line announces the goal, so it fires once a day.
  const justFinished = quotas.length > 0
    && quotas.every(q => hit(q))
    && !quotas.every(q => hit(q, q.metric === metric ? amount : 0));

  const what = challenge ? `${amount} ${challenge} ${metric}` : `${amount} ${metric}`;
  return justFinished ? `${name} completed the day's goal` : `${name} did ${what}`;
}

/** Who did it, by the name they chose, falling back to the one they signed up with. */
export type Who = { username: string; display_name?: string | null };
export const who = (p: Who) => p.display_name || p.username;

/**
 * Text for everything that is not a post. Kept here with the rest so it can be read
 * beside what a post says, and tested without Deno or a database.
 */
export function socialFor(kind: 'friend' | 'group' | 'comment' | 'like' | 'reaction' | 'story_like' | 'story_reaction', name: string, extra?: string | null): string {
  if (kind === 'friend') return `${name} sent you a friend request`;
  if (kind === 'group') return `${name} added you to ${extra}`;
  if (kind === 'like') return `${name} liked your proof`;
  if (kind === 'reaction') return `${name} reacted ${extra ?? ''}`.trim();
  // A story says so, because it is gone in a day and the post it is not is still there.
  if (kind === 'story_like') return `${name} liked your story`;
  if (kind === 'story_reaction') return `${name} reacted ${extra ?? ''} to your story`.replace(/ {2,}/g, ' ');
  // A comment is worth reading in the notification itself, but a long one turns the
  // whole thing into a wall; the rest is one tap away.
  const body = (extra ?? '').replace(/\s+/g, ' ').trim();
  const short = body.length > 80 ? `${body.slice(0, 79)}…` : body;
  return short ? `${name}: ${short}` : `${name} commented on your proof`;
}

// Fan out a push notification to a group when someone posts proof.
// Called by the posts_notify trigger in schema.sql (v4).

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
