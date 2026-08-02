const CACHE_NAME = 'peptideos-v27';
const APP_VERSION = 'v20260802-units';
const FRESH_URL = '/?_v=' + APP_VERSION;
const SHELL_URLS = ['/', '/index.html', '/manifest.json', '/mini.svg'];
const DB_NAME = 'peptideos_offline';
const STORE_NAME = 'queue';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => e.target.result.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = reject;
  });
}

async function enqueue(entry) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).add(entry);
    tx.oncomplete = resolve;
    tx.onerror = reject;
  });
}

async function dequeueAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const all = [];
    store.openCursor().onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { all.push(cursor.value); store.delete(cursor.primaryKey); cursor.continue(); }
      else resolve(all);
    };
    tx.onerror = reject;
  });
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(SHELL_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .then(clients => clients.forEach(client => {
        // Navigate every tab not already on the CURRENT version to the fresh URL —
        // a tab parked on an old _v= URL must be refreshed too, or it keeps the stale shell
        if (!client.url.includes('_v=' + APP_VERSION)) client.navigate(FRESH_URL);
      }))
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Redirect bare root requests to versioned URL so CDN cache can't serve stale HTML
  if (url.pathname === '/' && !url.searchParams.has('_v') && e.request.mode === 'navigate') {
    e.respondWith(Response.redirect(FRESH_URL, 302));
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    const method = e.request.method;
    if (method === 'GET') {
      e.respondWith(
        fetch(e.request).catch(() =>
          new Response(JSON.stringify({ error: 'offline' }), {
            status: 503, headers: { 'Content-Type': 'application/json' }
          })
        )
      );
    } else if (['POST', 'PUT', 'DELETE'].includes(method)) {
      e.respondWith(
        fetch(e.request.clone()).catch(async () => {
          const body = await e.request.text().catch(() => '');
          await enqueue({
            url: e.request.url, method,
            headers: Object.fromEntries(e.request.headers),
            body, timestamp: Date.now()
          });
          return new Response(JSON.stringify({ queued: true }), {
            status: 202, headers: { 'Content-Type': 'application/json' }
          });
        })
      );
    }
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached =>
      cached || fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        return res;
      })
    )
  );
});

self.addEventListener('sync', (e) => {
  if (e.tag === 'flush-queue') e.waitUntil(flushQueue());
});

async function flushQueue() {
  const entries = await dequeueAll();
  for (const entry of entries) {
    try {
      await fetch(entry.url, {
        method: entry.method,
        headers: entry.headers,
        body: entry.body || undefined
      });
    } catch {
      await enqueue(entry);
    }
  }
}

self.addEventListener('push', (e) => {
  const data = e.data?.json() || { title: 'PeptideOS', body: 'Dose reminder' };
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon || '/mini.svg',
      badge: '/mini.svg',
      data: { url: '/' }
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(clients.openWindow(e.notification.data?.url || '/'));
});
