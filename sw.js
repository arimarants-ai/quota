// Quota service worker.
// Static assets are cached. Everything from Supabase (auth, database, video upload,
// signed video URLs) is deliberately left alone so it always hits the network.
// Bump on every change to a precached file, or installed apps keep serving the old one from cache.
const VERSION = 'quota-v3';
const PRECACHE = ['/', '/manifest.json', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];
const STATIC_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(PRECACHE)).catch(() => {}));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
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

  // Fonts, the Supabase library and icons: cache first, they are versioned or static.
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
