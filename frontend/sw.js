const CACHE_NAME = "levelup-shell-v25";
const APP_SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/plans.css",
  "/app.js",
  "/config.js",
  "/manifest.json",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
];
const APP_SHELL_PATHS = new Set(APP_SHELL);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith("levelup-shell-") && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      ),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname === "/api" ||
    url.pathname.startsWith("/api/")
  ) {
    return;
  }

  const isNavigation = request.mode === "navigate";
  if (!isNavigation && !APP_SHELL_PATHS.has(url.pathname)) {
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cacheKey = isNavigation ? "/index.html" : url.pathname;
      const cached = await cache.match(cacheKey);

      if (!isNavigation && url.pathname !== "/config.js" && cached) {
        return cached;
      }

      try {
        const response = await fetch(request);
        if (response.ok && response.type === "basic") {
          await cache.put(cacheKey, response.clone());
        }
        return response;
      } catch (error) {
        if (cached) {
          return cached;
        }
        throw error;
      }
    }),
  );
});
