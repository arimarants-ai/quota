// Quota service worker.
// Static assets are cached. Everything from Supabase (auth, database, video upload,
// signed video URLs) is deliberately left alone so it always hits the network.
// Bump on every change to a precached file, or installed apps keep serving the old one from cache.
const VERSION = 'quota-v29';
// supabase.js is in here on purpose: every line of the app depends on it, so if it is
// missing on a cold launch the page cannot start at all. Precached, that cannot happen.
const PRECACHE = ['/', '/manifest.json', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png',
  '/vendor/supabase-js-2.49.4/supabase.js', '/vendor/supabase-js-2.49.4/591.supabase.js'];
const STATIC_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

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
      await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
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
  if (url.origin === self.location.origin && url.pathname === '/sw.js') return; // let the browser manage its own updates

  // The page itself: network first, so a deploy shows up straight away.
  // The cached copy is only a fallback for when there is no connection.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(res => { if (res && res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put('/', copy)); } return res; })
        .catch(() => caches.match('/').then(hit => hit || new Response('Offline', {status: 503, headers: {'content-type': 'text/plain'}})))
    );
    return;
  }

  // Fonts and icons: cache first, they are versioned or static.
  const sameOrigin = url.origin === self.location.origin;
  const isStatic = STATIC_HOSTS.includes(url.hostname) ||
    (sameOrigin && /\.(png|svg|ico|css|js|json|woff2?)$/i.test(url.pathname));
  if (!isStatic) return;

  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res && (res.ok || res.type === 'opaque')) {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(req, copy));
      }
      return res;
    }))
  );
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
