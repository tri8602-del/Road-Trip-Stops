// Keeps the app itself available with a weak signal. Maps, routes and searches always use the network.
const VERSION = 'rts-v1.1.0';
const SHELL = ['./', './index.html', './styles.css', './manifest.webmanifest', './vendor/leaflet.js', './vendor/leaflet.css',
  './js/app.js', './js/geo.js', './js/search.js', './js/pipeline.js', './js/services.js', './js/hours.js', './js/apple.js', './js/saved.js',
  './icons/apple-touch-icon.png', './icons/icon-192.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  // network first so updates show up, cache when offline
  e.respondWith(fetch(e.request).then((r) => {
    const copy = r.clone();
    caches.open(VERSION).then((c) => c.put(e.request, copy));
    return r;
  }).catch(() => caches.match(e.request)));
});
