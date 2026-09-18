// 오프라인 지원: 캐시를 먼저 보여 주고 백그라운드에서 최신 파일로 갱신한다(stale-while-revalidate).
// 배포 후 변경 사항은 앱을 한 번 열었다 닫은 뒤 다음 실행부터 반영된다.
const CACHE = 'flashcards-v5';
const FONT_CACHE = 'flashcards-fonts';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './xlsx.full.min.js',
  './manifest.json',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', e => {
  // 브라우저 HTTP 캐시에 남은 옛 파일을 받지 않도록 서버에 재확인한다.
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'no-cache' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== FONT_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 웹 폰트: 한 번 받으면 캐시에서만 제공(오프라인에서도 같은 글꼴 유지)
  if (url.hostname === 'cdn.jsdelivr.net' && url.pathname.includes('/pretendard')) {
    e.respondWith(caches.open(FONT_CACHE).then(async cache => {
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
        return res;
      } catch { return Response.error(); }
    }));
    return;
  }

  if (url.origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const hit = await cache.match(req, { ignoreSearch: true });
    const net = fetch(req.mode === 'navigate' ? req : new Request(req, { cache: 'no-cache' }))
      .then(res => { if (res.ok) cache.put(req, res.clone()); return res; })
      .catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    const res = await net;
    if (res) return res;
    if (req.mode === 'navigate') return cache.match('./index.html');
    return Response.error();
  }));
});
