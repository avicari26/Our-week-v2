// Service worker: makes the app installable and quick to launch.
// Update policy: every launch checks for a new version, and if one exists it
// takes over immediately and the page reloads once. Nobody clears a cache.
// The version string below changes with every release.
const VERSION = "2026-09-18.3";
const CACHE = "our-week-" + VERSION;
const SHELL = ["/", "/index.html", "/styles.css", "/app.js", "/config.js", "/manifest.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("message", (e) => { if (e.data === "SKIP_WAITING") self.skipWaiting(); });
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== "GET" || url.pathname.startsWith("/api/")) return;
  // Always go to the network. The cache is only used when the network is down.
  e.respondWith(
    fetch(e.request, { cache: "no-store" }).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request))
  );
});
