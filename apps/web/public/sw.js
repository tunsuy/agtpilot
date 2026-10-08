/* AgtPilot PWA Service Worker
 *
 * 缓存策略（为服务端渲染 + SSE 实时流应用量身定制）：
 * - 导航请求：网络优先；失败回落缓存的最近页面；再无则内联离线页。
 *   绝不缓存登录态/动态 HTML 为"新鲜"，只在断网时兜底，避免展示过期数据。
 * - 静态资源（/_next/static/、/icons/、favicon）：缓存优先 + 后台更新。
 * - /api/* 与 EventSource(SSE)：完全透传，绝不拦截，保证实时流不被 SW 破坏。
 * - push 事件：展示系统通知；notificationclick：聚焦/打开对应页面。
 */

const CACHE_NAME = 'agtpilot-static-v1';
const NAV_CACHE = 'agtpilot-nav-v1';
const PRECACHE = [
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE_NAME && k !== NAV_CACHE).map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

function offlineResponse() {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#fbfbfd"><title>AgtPilot</title>
<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
background:#fbfbfd;color:#18181b;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
padding:24px;box-sizing:border-box;text-align:center}
.logo{width:56px;height:56px;border-radius:16px;background:#18181b;color:#fff;display:flex;
align-items:center;justify-content:center;font-size:24px;font-weight:700;margin:0 auto 18px}
h1{font-size:18px;margin:0 0 8px}p{font-size:14px;color:#71717a;line-height:1.7;margin:0}</style></head>
<body><div><div class="logo">A</div><h1>当前离线</h1>
<p>你的智能体仍在服务器待命。<br>恢复网络后下拉刷新即可继续。</p></div></body></html>`;
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // API / SSE 实时流：完全透传
  if (url.pathname.startsWith('/api/')) return;

  // 导航请求：网络优先 → 缓存兜底 → 离线页
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // 缓存成功的导航响应，供断网兜底
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(NAV_CACHE).then((c) => c.put(req, clone));
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(req).catch(() => null);
          if (cached) return cached;
          const anyNav = await caches.open(NAV_CACHE).then((c) => c.match(req)).catch(() => null);
          if (anyNav) return anyNav;
          return offlineResponse();
        })
    );
    return;
  }

  // 静态资源：缓存优先 + 后台更新
  if (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/favicon.ico' ||
    url.pathname === '/favicon.png' ||
    url.pathname === '/favicon.svg'
  ) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const fetched = fetch(req)
          .then((res) => {
            if (res && res.ok) {
              const clone = res.clone();
              caches.open(CACHE_NAME).then((c) => c.put(req, clone));
            }
            return res;
          })
          .catch(() => cached);
        return cached || fetched;
      })
    );
  }
});

/* ============ Web Push ============ */

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'AgtPilot', body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'AgtPilot';
  const options = {
    body: payload.body || '',
    tag: payload.tag || 'agtpilot',
    icon: payload.icon || '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: payload.url || '/' },
    // 需要用户注意的审批类通知保持常驻
    renotify: Boolean(payload.tag && payload.tag.startsWith('approval')),
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // 优先聚焦已打开的页面并跳转
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(targetUrl).catch(() => {});
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
