const CACHE_NAME = 'chatible-shell-v2';
const SHELL_URLS = ['/', '/index.html', '/manifest.json', '/favicon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((key) => key.startsWith('chatible-shell-') && key !== CACHE_NAME)
        .map((key) => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('Authorization')) return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/socket.io' || url.pathname.startsWith('/socket.io/')) return;

  const isNavigation = request.mode === 'navigate';
  const isShellDocument = url.pathname === '/' || url.pathname === '/index.html';
  const isShellAsset = url.pathname === '/manifest.json' || url.pathname === '/favicon.svg';
  const isBundledAsset = url.pathname.startsWith('/assets/') &&
    ['script', 'style', 'font'].includes(request.destination);
  if (!isNavigation && !isShellDocument && !isShellAsset && !isBundledAsset) return;

  if (isNavigation || isShellDocument || isShellAsset) {
    event.respondWith(
      fetch(request).then(async (response) => {
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          const cacheKey = isNavigation || isShellDocument
            ? new Request(new URL('/index.html', self.location.origin))
            : request;
          await cache.put(cacheKey, response.clone());
        }
        return response;
      }).catch(async () => {
        const cached = isNavigation || isShellDocument
          ? await caches.match('/index.html') || await caches.match(request)
          : await caches.match(request);
        return cached || new Response('Offline', { status: 503, statusText: 'Offline' });
      })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          return caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, response.clone());
            return response;
          });
        }
        return response;
      });
    })
  );
});
