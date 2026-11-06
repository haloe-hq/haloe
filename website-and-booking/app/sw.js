// haloe app service worker — caches the app SHELL only (page, fonts, logo,
// icons, the Supabase client library). It never touches Supabase or any
// cross-origin data request, so client health data is never written to disk
// by the cache. Bump CACHE when the shell changes.
const CACHE = 'haloe-app-v59';
const SHELL = [
  '/app/',
  '/app/manifest.webmanifest',
  '/app/icons/icon-192.png',
  '/app/icons/icon-512.png',
  '/app/app-base.css',
  '/fonts/TAN-ASHFORD.woff2',
  '/haloe-logo-flower.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // Supabase/CDN: network only
  if (req.headers && req.headers.has('Authorization')) return;              // anything carrying a user token is never cached
  const path = url.pathname;

  // The page itself: network first, shell copy when offline.
  if (req.mode === 'navigate' && (path === '/app' || path.startsWith('/app/'))) {
    e.respondWith(fetch(req).catch(() => caches.match('/app/')));
    return;
  }
  // Shell assets: cache first, refresh in the background.
  if (SHELL.includes(path)) {
    e.respondWith(
      caches.match(req).then((hit) => {
        const net = fetch(req).then((res) => {
          if (res.ok && res.type !== 'opaque') caches.open(CACHE).then((c) => c.put(req, res.clone()));
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
  }
});

// ---- Admin alerts (web push) -------------------------------------------------------------------------
// The payload is only a fixed title + a short line like "Reschedule accepted · Tue 13 Oct, 6:30pm" + an in-app
// URL — it shows on a lock screen, so it never carries a name, treatment or clinical detail. Nothing here
// touches the cache, and nothing signed-in is ever stored.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = {}; }
  const title = (typeof d.title === 'string' && d.title.slice(0, 60)) || 'haloe';
  const body = (typeof d.body === 'string' && d.body.slice(0, 120)) || 'You have an update';
  const url = typeof d.url === 'string' && d.url.startsWith('/app/') ? d.url : '/app/';
  e.waitUntil(self.registration.showNotification(title, {
    body,
    tag: typeof d.tag === 'string' ? d.tag.slice(0, 60) : 'haloe',
    icon: '/app/icons/icon-192.png',
    badge: '/app/icons/icon-192.png',
    data: { url },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/app/';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      const u = new URL(w.url);
      if (u.origin === self.location.origin && u.pathname.startsWith('/app')) {
        await w.focus();
        w.postMessage({ type: 'open', url });      // the app moves to that booking without reloading
        return;
      }
    }
    await self.clients.openWindow(url);             // cold start: opens straight onto the booking
  })());
});
