// Self-check for push.ts. Run: node --experimental-strip-types push.test.ts
import { encrypt, vapidHeader, b64u, unb64u, send, jwt, apnsBody, fcmBody } from './push.ts';

const subtle = crypto.subtle;
const dec = new TextDecoder();
const enc = new TextEncoder();
const ok = (cond: unknown, msg: string) => { if (!cond) throw new Error('FAIL: ' + msg); console.log('  ok  ' + msg); };

const cat = (...p: Uint8Array[]) => {
  const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o;
};
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) {
  const k = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}

// Stand in for a real subscriber: a P-256 keypair plus a 16-byte auth secret.
const ua = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const uaPublic = new Uint8Array(await subtle.exportKey('raw', ua.publicKey));
const authSecret = crypto.getRandomValues(new Uint8Array(16));

const message = 'John did 30 pushups';
const body = await encrypt(message, b64u(uaPublic), b64u(authSecret));

// --- wire format, RFC 8188 section 2
const salt = body.subarray(0, 16);
const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
const idlen = body[20];
const asPublic = body.subarray(21, 21 + idlen);
const ct = body.subarray(21 + idlen);
ok(body.length === 16 + 4 + 1 + 65 + message.length + 1 + 16, 'body length = header + plaintext + delimiter + GCM tag');
ok(rs === 4096, 'record size is 4096');
ok(idlen === 65, 'key id is a 65-byte public key');
ok(asPublic[0] === 0x04, 'sender key is an uncompressed point');

// --- decrypt as the subscriber would
const shared = new Uint8Array(await subtle.deriveBits(
  { name: 'ECDH', public: await subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []) },
  ua.privateKey, 256));
const ikm = await hkdf(authSecret, shared, cat(enc.encode('WebPush: info'), new Uint8Array([0]), uaPublic, asPublic), 32);
const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
const key = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, ct));
ok(plain[plain.length - 1] === 2, 'plaintext ends with the 0x02 last-record delimiter');
ok(dec.decode(plain.subarray(0, -1)) === message, 'round-trips to the original message');

// --- a different subscriber must not be able to decrypt it
const other = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const otherShared = new Uint8Array(await subtle.deriveBits(
  { name: 'ECDH', public: await subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []) },
  other.privateKey, 256));
const otherIkm = await hkdf(authSecret, otherShared, cat(enc.encode('WebPush: info'), new Uint8Array([0]), uaPublic, asPublic), 32);
const otherCek = await hkdf(salt, otherIkm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
const otherKey = await subtle.importKey('raw', otherCek, 'AES-GCM', false, ['decrypt']);
let rejected = false;
try { await subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, otherKey, ct); } catch { rejected = true; }
ok(rejected, 'a different key cannot decrypt it');

// --- two encryptions of the same message must differ (fresh salt and sender key)
const again = await encrypt(message, b64u(uaPublic), b64u(authSecret));
ok(b64u(again) !== b64u(body), 'each message gets a fresh salt and sender key');

// --- VAPID JWT verifies against the public key and carries the right audience
const PUB = 'BPaw2UJU9VQ17Onx8bqve-CpoYzsoE1mTs8CaEZB34dvyT76nszZdXf-7hJS2EEUJVj_2sIO5cfDZ8Wki8Lsdv4';
const PRIV = 'j72yRrTHcm6TS314aBI21L8mZOozMX82bj_8rIhTLzo';
const header = await vapidHeader('https://web.push.apple.com/abc123', PUB, PRIV, 'mailto:a@b.c');
const [, t, k] = header.match(/^vapid t=([^,]+), k=(.+)$/)!;
ok(k === PUB, 'header advertises the VAPID public key');
const [h, p, s] = t.split('.');
const claims = JSON.parse(dec.decode(unb64u(p)));
ok(JSON.parse(dec.decode(unb64u(h))).alg === 'ES256', 'JWT alg is ES256');
ok(claims.aud === 'https://web.push.apple.com', 'aud is the endpoint origin, not the full URL');
ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 12 * 3600 + 5, 'exp is within 12h');
const raw = unb64u(PUB);
const verifyKey = await subtle.importKey('jwk',
  { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33, 65)) },
  { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
ok(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifyKey, unb64u(s), enc.encode(`${h}.${p}`)),
   'JWT signature verifies against the public key');

// --- the native app: APNs and FCM, told apart by the endpoint's prefix
const pem = (der: ArrayBuffer) => `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(der)))}\n-----END PRIVATE KEY-----`;
const ec = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const rsa = await subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const ecPem = pem(await subtle.exportKey('pkcs8', ec.privateKey)), rsaPem = pem(await subtle.exportKey('pkcs8', rsa.privateKey));
const verifies = async (tok: string, key: CryptoKey, algo: any) => {
  const [h2, p2, s2] = tok.split('.');
  return subtle.verify(algo, key, unb64u(s2), enc.encode(`${h2}.${p2}`));
};
ok(await verifies(await jwt({ alg: 'ES256', kid: 'K' }, { iss: 'T' }, ecPem, 'ES256'), ec.publicKey, { name: 'ECDSA', hash: 'SHA-256' }),
  'an APNs provider token signed from a .p8 verifies');
ok(await verifies(await jwt({ alg: 'RS256' }, { iss: 'x' }, rsaPem, 'RS256'), rsa.publicKey, 'RSASSA-PKCS1-v1_5'),
  'an FCM assertion signed from a service account key verifies');

const note = { title: 'Mornings', body: 'Sam posted 30 pushups', url: 'https://app.hitquota.app/#post-7', tag: 'post-7' };
const a = JSON.parse(apnsBody(note));
ok(a.aps.alert.title === 'Mornings' && a.aps.alert.body === note.body && a.url === note.url, 'APNs payload carries the words and the address');
const f = JSON.parse(fcmBody('tok', note));
ok(f.message.token === 'tok' && f.message.data.url === note.url && f.message.notification.body === note.body, 'FCM payload carries the words and the address');

process.env.APNS_KEY = ecPem; process.env.APNS_KEY_ID = 'KEYID'; process.env.APNS_TEAM_ID = 'TEAM';
process.env.FCM_SERVICE_ACCOUNT = JSON.stringify({ project_id: 'quota-x', client_email: 'q@x', private_key: rsaPem });
const seen: { url: string; headers: any; body: string }[] = [];
let answer = (url: string) => new Response('{}', { status: 200 });
(globalThis as any).fetch = async (url: string, init: any) => { seen.push({ url, headers: init.headers, body: init.body }); return answer(url); };
const vapid = { publicKey: '', privateKey: '', subject: '' };

ok(await send({ endpoint: 'apns:abc', p256dh: '', auth: '' }, JSON.stringify(note), vapid) === 200, 'an apns: row goes to Apple');
ok(seen[0].url === 'https://api.push.apple.com/3/device/abc' && seen[0].headers['apns-topic'] === 'app.hitquota.quota'
  && /^bearer /.test(seen[0].headers.authorization), '  at the production host, for the app, with a provider token');
seen.length = 0;
answer = url => new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: /sandbox/.test(url) ? 200 : 400 });
ok(await send({ endpoint: 'apns:dev', p256dh: '', auth: '' }, JSON.stringify(note), vapid) === 200 && /sandbox/.test(seen[1].url),
  '  a token production does not know is tried on the sandbox, for builds run from Xcode');
answer = () => new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 });
ok(await send({ endpoint: 'apns:gone', p256dh: '', auth: '' }, JSON.stringify(note), vapid) === 410, '  and one neither knows is reported as gone, so it is pruned');
answer = () => new Response(JSON.stringify({ reason: 'Unregistered' }), { status: 410 });
ok(await send({ endpoint: 'apns:old', p256dh: '', auth: '' }, JSON.stringify(note), vapid) === 410, '  as is an uninstalled app');

seen.length = 0;
answer = url => /oauth2/.test(url) ? Response.json({ access_token: 'AT' }) : new Response('{}', { status: 200 });
ok(await send({ endpoint: 'fcm:xyz', p256dh: '', auth: '' }, JSON.stringify(note), vapid) === 200, 'an fcm: row goes to Google');
ok(seen[0].url === 'https://oauth2.googleapis.com/token' && seen[1].url === 'https://fcm.googleapis.com/v1/projects/quota-x/messages:send'
  && seen[1].headers.Authorization === 'Bearer AT' && JSON.parse(seen[1].body).message.token === 'xyz', '  signed in as the service account, to the project');
answer = url => /oauth2/.test(url) ? Response.json({ access_token: 'AT' }) : new Response('{}', { status: 404 });
ok(await send({ endpoint: 'fcm:gone', p256dh: '', auth: '' }, JSON.stringify(note), vapid) === 410, '  and an unregistered token is reported as gone');

console.log('\nall push.ts checks passed');
