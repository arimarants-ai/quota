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
