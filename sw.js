/* Service worker.
 *
 * Strategy:
 *   Same-origin (HTML / CSS / our JS):   NETWORK-FIRST with cache fallback.
 *     → Every refresh online sees the freshest build. Cache only acts
 *       as offline-resilience. This stops new deployments from being
 *       hidden by a stale cache.
 *   CDN-hosted libraries (zxing-wasm, bwip-js, transitive .wasm):
 *     stale-while-revalidate — fast first paint, updates on next refresh.
 */

const VERSION = "v3";
const SHELL_CACHE = `dm-scanner-shell-${VERSION}`;
const CDN_CACHE   = `dm-scanner-cdn-${VERSION}`;

const SHELL_FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./worker.js",
  "./manifest.json",
];

const CDN_HOSTS = new Set([
  "esm.sh",
  "cdn.esm.sh",
  "cdn.jsdelivr.net",
  "unpkg.com",
]);

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Best-effort pre-cache — failures here don't block install.
    await cache.addAll(SHELL_FILES).catch(() => undefined);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, CDN_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.filter((n) => !keep.has(n)).map((n) => caches.delete(n)));
    await self.clients.claim();
    // Tell any open tab it should reload to pick up the new shell.
    const clients = await self.clients.matchAll({ type: "window" });
    for (const c of clients) c.postMessage({ type: "sw-activated", version: VERSION });
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(req, SHELL_CACHE));
    return;
  }
  if (CDN_HOSTS.has(url.host)) {
    event.respondWith(staleWhileRevalidate(req, CDN_CACHE));
    return;
  }
  // Other origins (none expected) — passthrough.
});

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req, { cache: "no-store" });
    if (res && res.ok) cache.put(req, res.clone()).catch(() => undefined);
    return res;
  } catch (_err) {
    const hit = await cache.match(req, { ignoreSearch: false });
    if (hit) return hit;
    if (req.mode === "navigate") {
      const shell = await cache.match("./index.html");
      if (shell) return shell;
    }
    return Response.error();
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone()).catch(() => undefined);
      return res;
    })
    .catch(() => undefined);
  return cached ?? (await network) ?? Response.error();
}

// Manual cache-bust hook from the page.
self.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg) return;
  if (msg.type === "skipWaiting") self.skipWaiting();
  if (msg.type === "purge") {
    event.waitUntil((async () => {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
    })());
  }
});
