// GENERATED — do not edit. Built from ../notify/push.ts, ../notify/message.ts, emails.ts, polish.ts, index.ts by test/bundle.mjs.
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

// ---- the native app
// The App Store and Play Store app cannot use Web Push: its token comes from Apple (APNs)
// or Google (FCM) and is stored in the same table, with an endpoint of `apns:<token>` or
// `fcm:<token>`. Everything else about a notification is the same payload the web one
// gets, so both callers (notify and wheelday) go on calling send() and nothing else.
//
// The keys are read here rather than passed in, so neither caller has to change:
//   APNS_KEY (the .p8 file's contents), APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC (bundle id)
//   FCM_SERVICE_ACCOUNT (the service account JSON from Firebase)
const env = (k: string): string | undefined =>
  (globalThis as any).Deno?.env.get(k) ?? (globalThis as any).process?.env?.[k];

const pemBody = (pem: string) => unb64u(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '').replace(/\+/g, '-').replace(/\//g, '_'));

/** A signed JWT. ES256 (APNs) comes back from Web Crypto as raw r||s, which is what JWS wants. */
export async function jwt(header: object, claims: object, pem: string, alg: 'ES256' | 'RS256') {
  const signed = `${b64u(enc.encode(JSON.stringify(header)))}.${b64u(enc.encode(JSON.stringify(claims)))}`;
  const algo = alg === 'ES256' ? { name: 'ECDSA', namedCurve: 'P-256' } : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  const key = await subtle.importKey('pkcs8', pemBody(pem), algo, false, ['sign']);
  const sig = await subtle.sign(alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : 'RSASSA-PKCS1-v1_5', key, enc.encode(signed));
  return `${signed}.${b64u(sig)}`;
}

// Both services want the same credential reused rather than minted per message: Apple
// refuses a provider token refreshed more than once every 20 minutes, and Google's access
// token lasts an hour. Kept for 50 minutes.
const held: Record<string, { v: string; at: number }> = {};
const reuse = async (k: string, make: () => Promise<string>) => {
  if (held[k] && Date.now() - held[k].at < 50 * 60e3) return held[k].v;
  held[k] = { v: await make(), at: Date.now() };
  return held[k].v;
};

type Note = { title?: string; body?: string; url?: string; tag?: string };

/** What Apple is sent. The address rides alongside aps, where the app reads it on a tap. */
export const apnsBody = (n: Note) => JSON.stringify({
  aps: { alert: { title: n.title ?? 'Quota', body: n.body ?? '' }, sound: 'default', ...(n.tag ? { 'thread-id': n.tag } : {}) },
  url: n.url ?? '',
});
/** What Google is sent. Data values must be strings. */
export const fcmBody = (token: string, n: Note) => JSON.stringify({
  message: { token, notification: { title: n.title ?? 'Quota', body: n.body ?? '' }, data: { url: n.url ?? '' },
    android: n.tag ? { notification: { tag: n.tag } } : undefined },
});

async function sendApns(token: string, n: Note): Promise<number> {
  const key = env('APNS_KEY'), kid = env('APNS_KEY_ID'), iss = env('APNS_TEAM_ID');
  if (!key || !kid || !iss) throw new Error('APNs is not set up: APNS_KEY, APNS_KEY_ID and APNS_TEAM_ID are missing');
  const auth = await reuse('apns', () => jwt({ alg: 'ES256', kid }, { iss, iat: Math.floor(Date.now() / 1000) }, key, 'ES256'));
  const post = (host: string) => fetch(`https://${host}/3/device/${token}`, {
    method: 'POST',
    headers: {
      authorization: `bearer ${auth}`, 'apns-topic': env('APNS_TOPIC') ?? 'app.hitquota.quota',
      'apns-push-type': 'alert', 'apns-priority': '10',
      ...(n.tag ? { 'apns-collapse-id': n.tag.slice(0, 64) } : {}),
    },
    body: apnsBody(n),
  });
  // A build run from Xcode gets a token from Apple's sandbox, and one from TestFlight or the
  // App Store gets a production one. Nothing on the token says which, so production is tried
  // first and the sandbox only when production does not know the token.
  let res = await post('api.push.apple.com');
  let why = res.ok ? '' : (await res.json().catch(() => ({}))).reason ?? '';
  if (res.status === 400 && why === 'BadDeviceToken') {
    res = await post('api.sandbox.push.apple.com');
    why = res.ok ? '' : (await res.json().catch(() => ({}))).reason ?? '';
    if (res.status === 400 && why === 'BadDeviceToken') return 410;   // neither knows it: prune
  }
  return res.status === 410 || why === 'Unregistered' ? 410 : res.status;
}

async function sendFcm(token: string, n: Note): Promise<number> {
  const raw = env('FCM_SERVICE_ACCOUNT');
  if (!raw) throw new Error('FCM is not set up: FCM_SERVICE_ACCOUNT is missing');
  const sa = JSON.parse(raw);
  const access = await reuse('fcm', async () => {
    const now = Math.floor(Date.now() / 1000);
    const assertion = await jwt({ alg: 'RS256', typ: 'JWT' }, {
      iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
    }, sa.private_key, 'RS256');
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${assertion}`,
    });
    if (!r.ok) throw new Error(`FCM sign-in refused: ${r.status} ${await r.text()}`);
    return (await r.json()).access_token;
  });
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: 'POST', headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
    body: fcmBody(token, n),
  });
  return res.status === 404 ? 410 : res.status;   // UNREGISTERED: the app is gone from that phone
}

/** Send one notification. Returns the HTTP status so callers can prune dead endpoints. */
export async function send(sub: Subscription, payload: string, opts: {
  publicKey: string; privateKey: string; subject: string; ttl?: number;
}): Promise<number> {
  const native = /^(apns|fcm):(.+)$/.exec(sub.endpoint);
  if (native) {
    const n: Note = JSON.parse(payload);
    return native[1] === 'apns' ? sendApns(native[2], n) : sendFcm(native[2], n);
  }
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
export function messageFor(name: string, metric: string, amount: number, quotas: Quota[], dayPosts: Post[], challenge?: string | null, where?: string | null): string {
  const totals = new Map<string, number>();
  for (const p of dayPosts) totals.set(p.metric, (totals.get(p.metric) ?? 0) + p.amount);

  const hit = (q: Quota, minus = 0) => (totals.get(q.metric) ?? 0) - minus >= q.target;
  // Only the post that crosses the line announces the goal, so it fires once a day.
  const justFinished = quotas.length > 0
    && quotas.every(q => hit(q))
    && !quotas.every(q => hit(q, q.metric === metric ? amount : 0));

  const what = challenge ? `${amount} ${challenge} ${metric}` : `${amount} ${metric}`;
  // Named as the thing that happened rather than left to be worked out. "Sam did 30
  // pushups" reads on a lock screen as something Sam mentioned; what it means is that Sam
  // posted proof, in a group, and there is something there to go and look at.
  const wheresit = where ? ` in ${where}` : '';
  return justFinished ? `${name} finished the day's goal${wheresit}` : `${name} posted ${what}${wheresit}`;
}

/**
 * Text for a flag: one person questioning whether a post met the challenge, and the group
 * deciding. Four different people want four different sentences out of the same two events,
 * so who is being told is an argument rather than something guessed from the row.
 *
 * `mine` is true when the post being questioned is the reader's own. Everyone else in the
 * group is being asked to vote; the person it is about is being told, and has no vote.
 */
export function flagFor(name: string, what: string, mine: boolean): string {
  return mine ? `${name} questioned your ${what}. The group is deciding.`
              : `${name} questioned ${what}. Have your say.`;
}
export function verdictFor(what: string, upheld: boolean, mine: boolean): string {
  if (mine) {
    return upheld ? `The group says your ${what} needs redoing. There is still time today.`
                  : `The group let your ${what} stand.`;
  }
  return upheld ? `The group says ${what} needs redoing.` : `The group let ${what} stand.`;
}

/**
 * A message in a chat. `where` is the group's name when it is a group's chat, and nothing
 * when it is between two people. `replied` is when it answers something you said.
 *
 * Who, and what they did, but never the words: a notification is a reason to open the app,
 * and what somebody said is read there, in the conversation it belongs to.
 */
export function chatFor(name: string, where?: string | null, replied = false): string {
  if (replied) return where ? `${name} replied to you in ${where}` : `${name} replied to your message`;
  return where ? `${name} messaged ${where}` : `${name} sent you a message`;
}

/** Who did it, by the name they chose, falling back to the one they signed up with. */
export type Who = { username: string; display_name?: string | null };
export const who = (p: Who) => p.display_name || p.username;

/**
 * Text for everything that is not a post. Kept here with the rest so it can be read
 * beside what a post says, and tested without Deno or a database.
 */
export function socialFor(kind: 'friend' | 'group' | 'comment' | 'reply' | 'like' | 'reaction' | 'story_like' | 'story_reaction' | 'comment_like' | 'message_reaction' | 'accepted_friend' | 'joined_group', name: string, extra?: string | null): string {
  if (kind === 'friend') return `${name} sent you a friend request`;
  if (kind === 'message_reaction') return `${name} reacted ${extra ?? ''} to your message`.replace(/ {2,}/g, ' ');
  // Somebody said yes. Worth hearing: an invitation sent and never spoken of again is the
  // one thing in the app that used to just quietly happen.
  if (kind === 'accepted_friend') return `${name} accepted your friend request`;
  if (kind === 'joined_group') return `${name} joined ${extra}`;
  if (kind === 'group') return `${name} added you to ${extra}`;
  if (kind === 'like') return `${name} liked your proof`;
  if (kind === 'reaction') return `${name} reacted ${extra ?? ''} to your proof`.replace(/ {2,}/g, ' ');
  // A story says so, because it is gone in a day and the post it is not is still there.
  if (kind === 'story_like') return `${name} liked your story`;
  if (kind === 'story_reaction') return `${name} reacted ${extra ?? ''} to your story`.replace(/ {2,}/g, ' ');
  // Who, not what. The words are read in the app, under the post they belong to.
  if (kind === 'comment_like') return `${name} liked your comment`;
  if (kind === 'reply') return `${name} replied to your comment`;
  return `${name} commented on your proof`;
}

/**
 * A forfeit. The group hears who owes and what, in the words the group chose; the person
 * who owed hears when somebody else marked it paid. Never money, so never an amount.
 */
export function forfeitFor(name: string, forfeit: string): string {
  return `${name} owes the crew: ${forfeit}`;
}
export function forfeitPaidFor(name: string, forfeit?: string | null): string {
  return forfeit ? `${name} marked your forfeit paid: ${forfeit}` : `${name} marked your forfeit paid`;
}

/**
 * Reports. What a reason is called when a person reads it: the database's own words are
 * for the database. Shared with the moderation function, so the push and the email and the
 * app never call the same thing two different names.
 */
export const REASON_LABEL: Record<string, string> = {
  spam: 'spam', harassment: 'harassment', hate: 'hate', sexual: 'sexual content',
  violence: 'violence', self_harm: 'self-harm', fake: 'fake proof', other: 'something else',
};
export const reasonLabel = (r: string | null | undefined) => REASON_LABEL[String(r ?? '')] ?? String(r ?? 'something').replace(/_/g, '-');

const IMAGE = /\.(jpe?g|png|webp|heic|heif|gif|avif)$/i;
/** What the reported thing is, in a word: a post is a video unless its file is a picture. */
export function thingWord(what: string | null | undefined, path?: string | null): string {
  if (what === 'post') return path && IMAGE.test(path) ? 'photo' : 'video';
  if (what === 'story' || what === 'comment' || what === 'message') return what;
  if (what === 'user') return 'profile';
  return 'post';
}

/** The moderators' push for a new report. Who, what, where and why, and nothing about who reported it. */
export function reportFor(name: string | null | undefined, thing: string, group: string | null | undefined, reason: string | null | undefined): string {
  const who = name ? `${name}'s` : 'A';
  const what = name ? thing : thing.toLowerCase();
  return `${who} ${what}${group ? ` in ${group}` : ''} was reported for ${reasonLabel(reason)}. Tap to review.`;
}

/** The thank-you the person who reported something hears, once it has been decided. */
export function reportDecidedFor(removed: boolean): string {
  return removed ? 'Thanks for reporting. We took it down.' : "Thanks for reporting. We looked into it and it's staying up.";
}

// The emails a take-down sends. Pure, so every variant is checked without Deno or Resend.
//
// Four of them: strike 1 (a warning), strike 2 (a final warning), suspended (strike 3, or
// serious), and self-harm, which is not a penalty at all and says so. Every one is from
// "the Quota team": a moderator is never named, and neither is whoever reported it.

export const FROM = 'Quota <safety@hitquota.app>';
export const REPLY_TO = 'safety@hitquota.app';
const GREEN = '#0A7F46';
const LOGO = 'https://app.hitquota.app/icon-192.png';

export const esc = (s: string) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** The first name if there is one, the way a person would start a note to somebody. */
export function firstName(name: string | null | undefined): string {
  return String(name || '').trim().split(/\s+/)[0].slice(0, 40);
}

/** "November 5", in the poster's own time zone when we know it. */
export function postedOn(at: string | null | undefined, tz?: string | null): string {
  const d = at ? new Date(at) : null;
  if (!d || isNaN(+d)) return '';
  try { return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: tz || 'UTC' }); }
  catch { return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }); }
}

export type Takedown = {
  name: string | null | undefined;   // the poster's display name or username
  thing: string;                     // video, photo, story, comment, message, profile
  group?: string | null;
  date?: string;                     // already formatted, e.g. "November 5"
  reason?: string | null;            // the polished reason
  strikeNo?: number | null;
  suspended?: boolean;
  selfHarm?: boolean;
};

export type Email = { subject: string; html: string; text: string };

/** Which email this is. Self-harm first: it is never a strike, whatever else is set. */
export function variant(t: Pick<Takedown, 'selfHarm' | 'suspended' | 'strikeNo'>): 'self_harm' | 'suspended' | 'strike2' | 'strike1' {
  if (t.selfHarm) return 'self_harm';
  if (t.suspended) return 'suspended';
  return (t.strikeNo ?? 1) >= 2 ? 'strike2' : 'strike1';
}

// A block of the email: a paragraph, the grey reason, or the amber strike box.
type Block = { p: string } | { why: string } | { warn: [string, string] };

function render(subject: string, blocks: Block[], signoff: string[]): Email {
  const text = [
    ...blocks.map(b => 'p' in b ? b.p : 'why' in b ? `Why: ${b.why}` : `${b.warn[0]}\n${b.warn[1]}`),
    signoff.join('\n'),
  ].join('\n\n');
  const row = (inner: string, pad = '14px 28px 0') => `<tr><td style="padding:${pad}">${inner}</td></tr>`;
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f5f6f6">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6f6;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #e8e9ea;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;color:#0b0c0e;font-size:15px;line-height:1.55">
<tr><td style="padding:24px 28px 0"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="padding-right:10px"><img src="${LOGO}" width="32" height="32" alt="" style="display:block;border-radius:8px;background:${GREEN}"></td>
<td style="font-weight:700;font-size:17px;color:${GREEN}">Quota</td></tr></table></td></tr>
${blocks.map(b => 'p' in b
    ? row(`<p style="margin:0">${esc(b.p)}</p>`)
    : 'why' in b
      ? row(`<div style="background:#f2f3f4;border-radius:10px;padding:14px 16px"><div style="font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#6e6e73;margin-bottom:4px">Why</div>${esc(b.why)}</div>`)
      : row(`<div style="background:#fff7e6;border:1px solid #f5d48a;border-radius:10px;padding:14px 16px"><b style="color:#8a5a00">${esc(b.warn[0])}</b><br><span style="color:#5c4a1f">${esc(b.warn[1])}</span></div>`)).join('\n')}
${row(`<p style="margin:0">${signoff.map(esc).join('<br>')}</p>`, '18px 28px 0')}
<tr><td style="padding:22px 28px 26px;font-size:12px;color:#8b8f94">Quota &middot; hitquota.app</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, html, text };
}

/** The email for a take-down, in whichever of the four shapes it needs. */
export function takedownEmail(t: Takedown): Email {
  const first = firstName(t.name);
  const hi = first ? `Hi ${first},` : 'Hi,';
  const where = t.group ? ` in ${t.group}` : '';
  const when = t.date ? ` on ${t.date}` : '';
  const reason = String(t.reason || '').trim();
  const appeal = "Think we got this wrong? Just reply to this email and we'll take another look.";
  const grind = ['Keep grinding,', 'The Quota team'];
  const v = variant(t);

  if (v === 'self_harm') {
    return render('Checking in from Quota', [
      { p: hi },
      { p: `A ${t.thing} you posted${where} was taken down to keep everyone on Quota safe. This isn't a penalty, and nothing is held against you.` },
      { p: "If you're going through something hard right now, you don't have to handle it alone. In the US or Canada, you can call or text 988 at any time. Elsewhere, findahelpline.com lists free, confidential support near you. If you're in immediate danger, please call your local emergency services." },
    ], ['The Quota team']);
  }

  const blocks: Block[] = [
    { p: hi },
    { p: `A ${t.thing} you posted${where}${when} was reported, and the Quota team took it down.${v === 'suspended' ? ' Your account has been suspended.' : ''}` },
  ];
  if (reason) blocks.push({ why: reason });
  if (v === 'suspended') {
    blocks.push({ p: "While your account is suspended you can still sign in, but you can't post, comment or message." });
    blocks.push({ p: appeal });
    return render('Your Quota account has been suspended', blocks, grind);
  }
  blocks.push({ warn: v === 'strike2'
    ? ['Final warning: strike 2 of 3', 'One more strike within 6 months will suspend your account.']
    : ['This is a warning: strike 1 of 3', 'A second strike is a final warning. A third suspends your account. Strikes clear after 6 months without a new one.'] });
  if (t.thing === 'video' || t.thing === 'photo') {
    blocks.push({ p: `That ${t.thing} no longer counts as proof. If it was today's, you still have until midnight to post again.` });
  }
  blocks.push({ p: appeal });
  return render(`Your Quota ${t.thing} was taken down`, blocks, grind);
}

// Addresses that cannot receive anything: accounts from before real emails were asked for.
export const undeliverable = (email: string | null | undefined) => !email || /@users\.quota\.local$/i.test(email);

// The moderator's note, rewritten for the person it is about. The moderator types fast and
// the poster reads it once, so this is the step between the two.
//
// It must never get in the way of a decision. Anything wrong — no key, no credit, a
// timeout, an empty answer, something far too long — falls back to the note itself,
// tidied up, and nobody is told: the moderator sees text in the box either way and can
// edit it before it goes.

export const MODEL = 'claude-haiku-5-5';

export const SYSTEM = [
  'You rewrite a content moderator\'s short note into the reason shown to a person whose post on Quota (a group fitness accountability app) was taken down.',
  'Write 1 to 3 sentences addressed to the poster, in the second person ("your caption...").',
  'Use a professional, business-appropriate tone that is kind but firm. Correct spelling and grammar. No slang, no emoji, no sarcasm.',
  'Never name or hint at who reported it. Never invent facts the note does not contain.',
  'Explain briefly why it is not allowed on Quota.',
  'Return only the text of the reason, with no preamble, quotes or sign-off.',
].join('\n');

/** The note with basic cleanup: trimmed, first letter capitalised, ending with a full stop. */
export function tidy(raw: string | null | undefined): string {
  let s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  s = s[0].toUpperCase() + s.slice(1);
  if (!/[.!?]["')\]]?$/.test(s)) s += '.';
  return s;
}

/** Whether what came back is usable as a reason. */
export function usable(out: string | null | undefined): boolean {
  const s = String(out ?? '').trim();
  return s.length > 0 && s.length <= 700;
}

export async function polish(raw: string, opts: { key?: string; thing?: string; fetch?: typeof fetch; timeoutMs?: number }): Promise<{ polished: string; fallback: boolean }> {
  const note = String(raw ?? '').trim().slice(0, 1500);
  const fallback = { polished: tidy(note), fallback: true };
  if (!note || !opts.key) return fallback;
  const f = opts.fetch ?? fetch;
  try {
    const res = await f('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': opts.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 300, system: SYSTEM,
        messages: [{ role: 'user', content: `What was taken down: ${opts.thing || 'a post'}\nModerator's note: ${note}` }],
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    });
    if (!res.ok) { console.warn('polish: falling back,', res.status); return fallback; }
    const data = await res.json();
    const out = (data?.content ?? []).filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('').trim();
    return usable(out) ? { polished: out.replace(/^["“]|["”]$/g, '').trim(), fallback: false } : fallback;
  } catch (e) {
    console.warn('polish: falling back,', String(e));
    return fallback;
  }
}

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

// Who posted it, where and when, read off the thing if it is still there and off the
// report if it is not.
async function factsOf(r: any) {
  let owner = r.user_id, gid = r.group_id, at = r.created_at, path = r.media_path;
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
