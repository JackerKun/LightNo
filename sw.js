/**
 * LIGHTNO · Service Worker
 * 静态资源离线缓存（cache-first + 后台更新），导航请求失败时回退 index.html。
 *
 * 修改任何前端文件后，请把 VERSION 加一，确保用户拿到新版本。
 */
const VERSION = 'lightno-v1.1.0';

const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/theme.css',
  './css/layout.css',
  './css/components.css',
  './js/main.js',
  './js/pwa.js',
  './js/core/state.js',
  './js/core/exposure.js',
  './js/core/sampler.js',
  './js/core/camera.js',
  './js/core/capture.js',
  './js/core/exif.js',
  './js/core/store.js',
  './js/core/demo.js',
  './js/core/wake.js',
  './js/ui/dom.js',
  './js/ui/toast.js',
  './js/ui/sheet.js',
  './js/ui/haptic.js',
  './js/ui/gestures.js',
  './js/ui/pickers.js',
  './js/ui/meter.js',
  './js/ui/photoMeter.js',
  './js/ui/history.js',
  './js/ui/settings.js',
  './assets/icons/favicon.svg',
  './assets/icons/icon-180.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
      .catch((err) => {
        console.warn('[LIGHTNO] precache failed', err);
      })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        fetch(request)
          .then((response) => {
            if (response && response.ok) {
              caches.open(VERSION).then((cache) => cache.put(request, response.clone())).catch(() => {});
            }
          })
          .catch(() => {});
        return cached;
      }
      return fetch(request)
        .then((response) => {
          if (response && response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});