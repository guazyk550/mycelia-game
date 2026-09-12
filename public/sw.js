/**
 * Service Worker：让游戏离线可玩。
 *
 * 策略很朴素，但对增量游戏是对的：
 *   · 应用外壳（HTML/JS/CSS/图标）——**预缓存**，之后完全离线可用；
 *   · 其他请求 —— 先走网络，失败时回落缓存。
 * 增量游戏的存档在 IndexedDB / localStorage，不经过 SW，所以清理缓存不会丢档。
 */
const CACHE = 'mycelia-v1';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req)
        .then((res) => {
          // 只缓存同源资源，避免把第三方请求也塞进来
          if (res.ok && new URL(req.url).origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match('./index.html'));
    }),
  );
});
