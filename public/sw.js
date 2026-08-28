// Service worker — uses RELATIVE paths so it works on GitHub Pages
// under https://<user>.github.io/<repo>/ subpaths as well as at the root.
// Bump CACHE_NAME whenever you change the frontend so phones download the new version.
const CACHE_NAME = 'attendance-pwa-v5';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './manifest.webmanifest',
  './offline.html',
  './icons/icon-192.svg',
  './icons/icon-512.svg',
  'https://cdn.jsdelivr.net/npm/qrcode@1/build/qrcode.min.js',
  'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('./offline.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        return response;
      }).catch(() => caches.match('./offline.html'));
    })
  );
});
