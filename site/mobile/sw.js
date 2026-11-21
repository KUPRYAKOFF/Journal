'use strict';

const CACHE = 'journal-mobile-shell-v2';
const HOME = new URL('./', self.location.href).href;
const ASSETS = [
  './', './index.html', './manifest.webmanifest', './styles.css?v=2', './storage.js', './sync.js', './app.js?v=2',
  './icons/icon-192.png', './icons/icon-512.png', '../config.js?v=3', '../auth.js?v=1', '../loader.css?v=1', '../loader.js?v=1'
].map(path => new URL(path, HOME).href);

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache =>
    cache.addAll(ASSETS.map(url => new Request(url, { cache: 'reload' }))).then(() => self.skipWaiting())
  ));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(key => key.startsWith('journal-mobile-shell-') && key !== CACHE).map(key => caches.delete(key)))
  ).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  // Cache only the interface. Google login, journal data and queued writes never pass through this cache.
  const url = new URL(request.url);
  if (request.mode === 'navigate' && url.origin === self.location.origin &&
      [HOME, new URL('index.html', HOME).href].includes(url.origin + url.pathname)) {
    event.respondWith(fetch(request).catch(() => caches.match(HOME)));
  } else if (ASSETS.includes(request.url)) {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
  }
});
