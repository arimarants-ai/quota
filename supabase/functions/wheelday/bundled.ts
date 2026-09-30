// GENERATED — do not edit. Built from ../notify/push.ts, message.ts, sweep.ts, health.ts, index.ts by test/bundle.mjs.
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

// What a spin-day reminder says. Kept apart from index.ts so it can be run and checked
// without a Deno runtime or any of the secrets.
export type Due = { user_id: string; wheel_name: string; group_name: string };

/**
 * What the end of somebody's day says. The line is what is left, worked out by the
 * database — "40 pushups", or "40 pushups, 20 situps" when two quotas are short.
 *
 * It says the number and it says there is still time, and it does not say anything about
 * a streak: somebody who is about to lose one knows, and somebody who is not would be
 * being nagged about nothing.
 */
export function endOfDayFor(line: string): string {
  const what = (line ?? '').trim();
  return what ? `${what} to go. Still time today.` : 'Your day is not finished yet. Still time.';
}

// One notification per person, however many wheels came due at once: three separate
// buzzes for the same trip to the app is how notifications get turned off.
export function remindersFor(due: Due[]): Map<string, string> {
  const byUser = new Map<string, Due[]>();
  for (const d of due) byUser.set(d.user_id, [...(byUser.get(d.user_id) ?? []), d]);
  const out = new Map<string, string>();
  for (const [uid, rows] of byUser) {
    const names = [...new Set(rows.map(r => r.wheel_name))];
    const groups = [...new Set(rows.map(r => r.group_name))];
    const what = names.length === 1 ? names[0]
      : names.length === 2 ? `${names[0]} and ${names[1]}`
      : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
    const where = groups.length === 1 ? groups[0] : `${groups.length} groups`;
    out.set(uid, `Spin ${what} in ${where} before you post today.`);
  }
  return out;
}


// ---- the day's one notification
// What notices_due_now() hands back, per person per kind.
export type Notice = {
  user_id: string;
  kind: 'open' | 'lastcall' | 'lapsed' | 'challenge';
  hours: number;
  group_name: string;              // the group, or for a challenge the wheel
  others: number;                  // other people in that group who have posted today
  mates: number;                   // how many other people are in it at all
  line: string;                    // what is still owed today: "40 pushups, 20 situps"
  done: number;                    // challenge days done
  needs: number;                   // challenge days required
};

const hrs = (n: number) => `${n} ${n === 1 ? 'hour' : 'hours'}`;

/**
 * The window opening. It says how long there is, because "post today" is not news and
 * "four hours" is. The number is the whole point, so it leads.
 */
export function windowFor(n: Notice): string {
  const h = Math.max(1, Math.round(n.hours));
  return `${hrs(h)} to post today.${n.group_name ? ` ${n.group_name} is waiting.` : ''}`;
}

/**
 * Last call. It is about your own streak: that is the number you are keeping, and saying
 * so is the nudge. It used to say "don't be the one who breaks the streak", which made
 * one person's missed day the group's failure; the group's run is a bonus now, and a
 * reminder is not the place to hang it on anybody.
 *
 * Nobody else posted yet and there is nothing social to say, so it falls back to the clock.
 */
export function lastCallFor(n: Notice): string {
  const h = Math.max(1, Math.round(n.hours));
  // What is actually left comes first. Being told the number is the difference between a
  // nudge you can act on and one you have to open the app to understand — and somebody
  // twenty of fifty in gets this too now, which the version before this did not do.
  const owed = (n.line ?? '').trim();
  const left = owed ? `${owed} to go.` : '';
  if (n.others > 0 && n.others === n.mates) {
    return `${left} Everyone in ${n.group_name} has posted but you. ${hrs(h)} left to keep your streak.`.trim();
  }
  if (n.others > 0) {
    return `${left} ${n.others} of ${n.mates} in ${n.group_name} have posted. ${hrs(h)} left to keep your streak.`.trim();
  }
  return left ? `${left} ${hrs(h)} left today.` : `${hrs(h)} left to post today.`;
}

/**
 * A challenge whose cycle shuts tonight, with days still owed on it.
 *
 * This takes the evening instead of last call rather than as well as it: a whole cycle's
 * work about to be lost is the more urgent of the two, and two messages in an evening is
 * how an app gets muted.
 */
export function challengeFor(n: Notice): string {
  const h = Math.max(1, Math.round(n.hours));
  const short = Math.max(0, (n.needs ?? 0) - (n.done ?? 0));
  const what = n.group_name ? `${n.group_name} ends tonight` : 'Your challenge ends tonight';
  const got = n.needs > 0 ? ` ${n.done} of ${n.needs} days done` : '';
  return short === 1 && n.done > 0
    ? `${what} —${got}, one more and it counts. ${hrs(h)} left.`
    : `${what} —${got}. ${hrs(h)} left.`;
}

/**
 * For somebody who has not opened the app in three days. It replaces the window one rather
 * than arriving beside it: two notifications in a day is what somebody who has stopped
 * caring uninstalls over.
 */
export function lapsedFor(n: Notice): string {
  if (!n.group_name) return 'Your group has been going without you.';
  return n.others > 0
    ? `${n.group_name} posted without you today. Three days since your last one.`
    : `${n.group_name} is still going. Your spot is still there.`;
}

// Title and tag per kind. The tag is what makes today's replace yesterday's rather than
// stacking up on the lock screen.
export const NOTICE_META: Record<Notice['kind'], { title: string; tag: string }> = {
  open: { title: 'Your window is open', tag: 'day-open' },
  lastcall: { title: 'Last call', tag: 'day-last' },
  lapsed: { title: 'Quota', tag: 'day-open' },     // the one it stands in for
  challenge: { title: 'Last call', tag: 'day-last' },   // likewise: it takes last call's place
};

export function noticeBody(n: Notice): string {
  return n.kind === 'open' ? windowFor(n)
    : n.kind === 'challenge' ? challengeFor(n)
    : n.kind === 'lastcall' ? lastCallFor(n)
    : lapsedFor(n);
}

// Clearing out yesterday's stories.
//
// This was two deletes in a pg_cron job. Supabase now refuses direct deletion from
// storage.objects, and because pg_cron runs a job body as a single transaction the second
// statement's error rolled back the first — so nothing expired at all. It was failing 24
// times out of 24 runs, with ten stories still sitting there when it was found, and
// nothing anywhere said so.
//
// Deleting a file is the storage API's job, so it belongs in the function that already
// runs on this beat and already holds the service key.
//
// Kept apart from index.ts, like message.ts and push.ts, so it can be run and checked
// without a Deno runtime or any of the secrets.

export type StoryRow = { id: number; media_path: string | null };

export type SweepDeps = {
  // Expired rows, oldest first, at most `limit` of them.
  list: (cutoff: string, limit: number) => Promise<StoryRow[]>;
  // Remove these files from the stories bucket. Resolves false if the bucket said no.
  removeFiles: (paths: string[]) => Promise<boolean>;
  // Drop these rows.
  removeRows: (ids: number[]) => Promise<void>;
  now?: () => number;
};

export const STORY_HOURS = 24;
export const SWEEP_MAX = 100;            // an hourly job has no business clearing a year at once

/**
 * Files first, then rows.
 *
 * The row is the only thing that knows where the file is, so deleting it first would
 * strand the file with nothing left pointing at it — which is the one outcome worse than
 * leaving both alone. If the bucket refuses, nothing is deleted and the whole lot comes
 * round again next hour.
 *
 * A text story has no file, so it is only ever a row. A sweep of nothing but text stories
 * must still delete them, and must not call the storage API to do it.
 */
export async function sweepStories(d: SweepDeps) {
  const now = d.now ? d.now() : Date.now();
  const cutoff = new Date(now - STORY_HOURS * 3600e3).toISOString();
  const old = await d.list(cutoff, SWEEP_MAX);
  if (!old.length) return { rows: 0, files: 0, held: false };

  const paths = old.map(s => s.media_path).filter((p): p is string => !!p);
  if (paths.length && !(await d.removeFiles(paths))) {
    // Held rather than half-done: the rows stay, so next hour finds the same files again.
    return { rows: 0, files: 0, held: true };
  }
  await d.removeRows(old.map(s => s.id));
  return { rows: old.length, files: paths.length, held: false };
}

// Telling somebody when the machinery itself has stopped.
//
// stories-expire failed 24 times out of 24 runs and nothing said so. That is the whole
// problem with work that happens on a timer: when it stops, nothing happens — which looks
// exactly like nothing needing to happen. No error in the app, nothing in the logs anybody
// reads, no user complaint, because the thing that broke is the thing nobody watches.
//
// So the hourly function that is already running checks whether any of its siblings have
// been failing, and if so pushes once to whoever owns the project. Once a day, not once an
// hour: an alarm that goes off every hour is an alarm that gets silenced.
//
// Kept apart from index.ts, like message.ts and sweep.ts, so it can be run and checked
// without a Deno runtime or any of the secrets.

export type CronFail = { jobname: string; failures: number; last_message: string | null };

// A cron job that runs every ten minutes will rack up a lot of failures, and one that runs
// daily may only have the one. Both matter, so the count is reported rather than used as a
// threshold — anything that failed at all in the last day is worth knowing about.
export function cronAlertBody(rows: CronFail[]): string {
  const real = rows.filter(r => r.failures > 0);
  if (!real.length) return '';
  const worst = real[0];
  const why = (worst.last_message ?? '').split('\n')[0].trim().slice(0, 90);
  const head = real.length === 1
    ? `${worst.jobname} has failed ${worst.failures} ${worst.failures === 1 ? 'time' : 'times'} in the last day.`
    : `${real.length} scheduled jobs are failing — worst is ${worst.jobname}, ${worst.failures} times.`;
  return why ? `${head} ${why}` : head;
}

// Nothing is sent when nothing is wrong, which is the only way the one that does arrive
// means anything.
export const cronAlertDue = (rows: CronFail[]) => rows.some(r => r.failures > 0);

// Tell people it is wheel spin day.
//
// Everything else the app pushes happens because someone did something. This one has to
// happen at a time, and "morning" is a different moment for each person, so pg_cron calls
// this once an hour and public.wheel_due_now() works out whose morning it is. That
// function also claims each reminder as it returns it, so an overlapping run or a retried
// call cannot wake the same person twice for the same spin.

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
