'use strict';

/* =========================================================
 * 식단기록 PWA - service worker
 * - 앱 셸(HTML/CSS/JS/Chart.js/아이콘)은 캐시 우선
 * - foods.json은 있으면 캐시 (없어도 설치 실패하지 않음)
 * - 프록시(다른 도메인) 요청은 건드리지 않음 → 항상 네트워크
 * 파일을 바꿔 배포할 때는 CACHE_VERSION을 올려야 기기에 반영된다.
 * ========================================================= */
const CACHE_VERSION = 'v12';
const CACHE_NAME = `diet-log-${CACHE_VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './config.js',
  './manifest.webmanifest',
  './vendor/chart.umd.min.js',
  './js/app.js',
  './js/util.js',
  './js/db.js',
  './js/db-idb.js',
  './js/db-cloud.js',
  './js/parse.js',
  './js/lookup.js',
  './js/calendar.js',
  './js/day-table.js',
  './js/day-charts.js',
  './js/profile.js',
  './js/stats.js',
  './js/evaluate.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];
const OPTIONAL = ['./foods.json'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL.map((url) => new Request(url, { cache: 'reload' })));
    await Promise.all(OPTIONAL.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('diet-log-') && k !== CACHE_NAME).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 프록시 등 외부 요청

  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html')
        .then((cached) => cached || fetch(req))
        .catch(() => caches.match('./'))
    );
    return;
  }

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      });
    })
  );
});
