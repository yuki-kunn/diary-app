/* ひだまり日記 Service Worker */
const CACHE_NAME = 'hidamari-v1';
const APP_SHELL = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/app.js',
  '/js/db.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// アプリシェルはキャッシュ優先、APIはネットワークのみ
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: url.pathname === '/' }).then(cached => {
      const fetched = fetch(e.request).then(res => {
        if (res.ok && url.origin === location.origin) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || fetched;
    })
  );
});

// ---- プッシュ通知 ----
// 22時のリマインド: IndexedDBを見て今日の日記があれば表示しない
function hasEntryToday(dateStr) {
  return new Promise((resolve) => {
    const req = indexedDB.open('hidamari-diary');
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('entries')) { resolve(false); return; }
      const get = db.transaction('entries').objectStore('entries').get(dateStr);
      get.onsuccess = () => resolve(!!get.result);
      get.onerror = () => resolve(false);
    };
    req.onerror = () => resolve(false);
  });
}

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data.json(); } catch { data = { title: 'ひだまり日記', body: e.data ? e.data.text() : '' }; }

  const show = () => self.registration.showNotification(data.title || 'ひだまり日記', {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.type === 'reminder' ? 'daily-reminder' : undefined,
    data: { url: data.type === 'reminder' ? '/?write=1' : '/' },
  });

  if (data.type === 'reminder' && data.date) {
    e.waitUntil(
      hasEntryToday(data.date).then(exists => {
        if (!exists) return show();
        // すでに書いていた場合も控えめな通知(Chromeの userVisibleOnly 制約のため)
        return self.registration.showNotification('ひだまり日記', {
          body: '今日の日記は登録済みです。おやすみなさい 🌙',
          icon: '/icons/icon-192.png',
          tag: 'daily-reminder',
          silent: true,
        });
      })
    );
  } else {
    e.waitUntil(show());
  }
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if ('focus' in client) { client.navigate(url); return client.focus(); }
      }
      return self.clients.openWindow(url);
    })
  );
});
