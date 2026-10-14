// Quota service worker.
// Static assets are cached. Everything from Supabase (auth, database, video upload,
// signed video URLs) is deliberately left alone so it always hits the network. A clip from
// R2 that somebody actually played is kept, by its path, so watching it again is free.
// Bump on every change to a precached file, or installed apps keep serving the old one from cache.
const VERSION = 'quota-v135';
// supabase.js is in here on purpose: every line of the app depends on it, so if it is
// missing on a cold launch the page cannot start at all. Precached, that cannot happen.
const PRECACHE = ['/', '/manifest.json', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png',
  '/icon-maskable-192.png', '/icon-maskable-512.png',
  '/vendor/supabase-js-2.49.4/supabase.js', '/vendor/supabase-js-2.49.4/591.supabase.js'];
const STATIC_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const NAV_WAIT = 3000;                   // ms the network gets to answer for the page before the kept copy is used

// ---- clips you have watched
// A signed URL is different every half hour, so the browser's own cache never sees the
// same clip twice and a rewatch downloaded the whole thing again. Kept here instead, under
// the object's path on R2 — which is the same whatever the signature on the URL — in a
// cache of its own that outlives app versions, holding the most recent MEDIA_MAX.
//
// Only clips, only from R2, and only once somebody pressed play: a <video> asks for
// nothing before then. Anything that goes wrong here falls straight through to the network
// exactly as if this did not exist, because a clip that will not play is the one failure
// this must never cause.
const MEDIA = 'quota-media';
const MEDIA_MAX = 40;
const MEDIA_BIG = 30 * 1048576;            // anything bigger is streamed, not kept
const R2_CLIP = url => /\.r2\.cloudflarestorage\.com$/.test(url.hostname) && /\.(mp4|mov|m4v|webm)$/i.test(url.pathname);
const mediaKey = url => `${self.location.origin}/__media${url.pathname}`;   // a name in the cache, never an address

// "bytes=a-b", "bytes=a-" or "bytes=-n" as [first, last] inside a file of `size` bytes.
// null is no range at all (the whole file); 'bad' is one that cannot be satisfied.
function rangeOf(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let a, b;
  if (m[1] === '') { a = Math.max(0, size - +m[2]); b = size - 1; }
  else { a = +m[1]; b = m[2] === '' ? size - 1 : Math.min(+m[2], size - 1); }
  return a > b || a >= size ? 'bad' : [a, b];
}
// Safari will not play a clip served whole when it asked for a part: it opens every clip by
// asking for its first two bytes and wants exactly those, as a 206, back.
async function served(res, range) {
  const blob = await res.blob(), size = blob.size;
  const type = res.headers.get('content-type') || 'video/mp4';
  const r = rangeOf(range, size);
  if (r === 'bad') return new Response(null, {status: 416, headers: {'Content-Range': `bytes */${size}`}});
  if (!r) return new Response(blob, {status: 200, headers: {'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes'}});
  return new Response(blob.slice(r[0], r[1] + 1), {status: 206, headers: {'Content-Type': type, 'Accept-Ranges': 'bytes',
    'Content-Range': `bytes ${r[0]}-${r[1]}/${size}`, 'Content-Length': String(r[1] - r[0] + 1)}});
}
const fetching = new Map();
async function watched(req, url) {
  const cache = await caches.open(MEDIA), key = mediaKey(url);
  let hit = await cache.match(key);
  if (!hit) {
    // A player asks for several ranges of the same clip at once. One download serves them.
    if (!fetching.has(key)) fetching.set(key, (async () => {
      const res = await fetch(url.href, {mode: 'cors', credentials: 'omit'});
      if (!res.ok || res.status !== 200 || +(res.headers.get('content-length') || MEDIA_BIG + 1) > MEDIA_BIG) {
        try { await res.body?.cancel(); } catch (e) {}   // or it carries on downloading beside the fallback
        throw new Error('not kept');
      }
      // Room first, so a full cache still takes the new clip rather than refusing it forever.
      const keys = await cache.keys();       // oldest first
      for (const k of keys.slice(0, Math.max(0, keys.length - MEDIA_MAX + 1))) await cache.delete(k);
      await cache.put(key, res);
    })().finally(() => fetching.delete(key)));
    await fetching.get(key);
    hit = await cache.match(key);
    if (!hit) throw new Error('not kept');
  }
  return served(hit, req.headers.get('range'));
}

self.addEventListener('install', e => {
  self.skipWaiting();
  // addAll is all-or-nothing, so one bad entry used to leave the app with no cache at
  // all and nothing to fall back on offline. Take whatever we can get instead.
  e.waitUntil(caches.open(VERSION).then(c => Promise.all(PRECACHE.map(u => c.add(u).catch(() => {})))));
});

// Everything this version needs is actually in its cache.
const stocked = async cache => {
  for (const u of PRECACHE) if (!await cache.match(u)) return false;
  return true;
};

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // install takes whatever it can get rather than failing outright, so a bad moment on
    // the network leaves this version short. Try the gaps once more here.
    await Promise.all(PRECACHE.map(u => cache.match(u).then(hit => hit || cache.add(u).catch(() => {}))));
    // And only let go of the previous version once this one can stand on its own.
    // Deleting it while this one is incomplete is how an installed app ends up with no
    // copy of the library at all and nothing to fall back on: the page loads, the import
    // it cannot start without is not there, and all anyone sees is "Load failed".
    if (await stocked(cache)) {
      const keys = await caches.keys();
      await Promise.all(keys.filter(k => k !== VERSION && k !== MEDIA).map(k => caches.delete(k)));
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;                      // uploads, sign-in, inserts: never touched
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (url.hostname.endsWith('supabase.co')) return;      // API, auth and signed video URLs: never cached
  if (R2_CLIP(url)) { e.respondWith(watched(req, url).catch(() => fetch(req))); return; }
  if (url.origin === self.location.origin && url.pathname === '/sw.js') return; // let the browser manage its own updates

  // The page itself: network first, so a deploy shows up straight away — but only for a
  // few seconds. A slow connection does not fail, it crawls, and waiting on it was a blank
  // screen for as long as it took. Past NAV_WAIT the copy already here is used, and the
  // network answer, whenever it comes, is kept for next time.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const net = fetch(req).then(res => {
        if (res && res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put('/', copy)); }
        return res;
      });
      const kept = await caches.match('/');
      if (!kept) return net.catch(() => new Response('Offline', {status: 503, headers: {'content-type': 'text/plain'}}));
      const first = await Promise.race([net.catch(() => null), new Promise(r => setTimeout(() => r(null), NAV_WAIT))]);
      if (first && first.ok) return first;
      e.waitUntil(net.catch(() => {}));
      return kept;
    })());
    return;
  }

  // Fonts and icons: cache first, they are versioned or static.
  const sameOrigin = url.origin === self.location.origin;
  const isStatic = STATIC_HOSTS.includes(url.hostname) ||
    (sameOrigin && /\.(png|svg|ico|css|js|json|woff2?)$/i.test(url.pathname));
  if (!isStatic) return;

  // This version's cache first, then the network, and only then anything an older version
  // left behind. caches.match() searches every cache there is, so asking it outright can
  // answer with a copy from a version that has been superseded — for a file whose name
  // does not change between releases, that is a stale asset served indefinitely. An old
  // cache is still worth having as the last word when there is no network at all.
  e.respondWith((async () => {
    const mine = await caches.open(VERSION);
    const hit = await mine.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res && (res.ok || res.type === 'opaque')) mine.put(req, res.clone());
      return res;
    } catch (err) {
      return (await caches.match(req)) || Response.error();
    }
  })());
});

// ---- push notifications
self.addEventListener('push', e => {
  // iOS requires every push to show something, so fall back rather than throw.
  let d = { title: 'Quota', body: 'Someone posted proof.', url: '/' };
  try { if (e.data) d = { ...d, ...e.data.json() }; } catch (err) { /* not JSON: keep the fallback */ }
  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: d.tag,            // same tag replaces the previous one instead of stacking
    data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  // Keep only the path. The sender names one site, but the app can be installed from
  // any of its origins, and sending iOS to a different one opens a signed-out browser view.
  const sent = new URL(e.notification.data?.url || '/', self.location.origin);
  const url = self.location.origin + sent.pathname + sent.search;
  e.waitUntil((async () => {
    // Focus whatever window is already open, whichever tab it happens to be showing.
    for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
      if (!('focus' in c)) continue;
      await c.focus();
      if ('navigate' in c && c.url !== url) await c.navigate(url).catch(() => {});
      return;
    }
    // iOS opens the home screen app itself; calling openWindow there gets you an
    // in-app browser view instead, signed out and wearing Safari's chrome.
    if (!/iPad|iPhone|iPod/.test(navigator.userAgent)) await self.clients.openWindow(url);
  })());
});
