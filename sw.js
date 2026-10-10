"use strict";

/* RISHI MUSIC - SERVICE WORKER
   Repository: spiderman1
   Cache version: v10
*/

const CACHE_NAME = "rishi-music-v10";

const APP_SHELL = [
  "/spiderman1/",
  "/spiderman1/index.html",
  "/spiderman1/style.css",
  "/spiderman1/app.js",
  "/spiderman1/manifest.json"
];

self.addEventListener("install", event => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);

      await Promise.all(
        APP_SHELL.map(async path => {
          try {
            const response = await fetch(path, {
              cache: "reload"
            });

            if (response.ok) {
              await cache.put(path, response);
            }
          } catch (error) {
            console.warn("Could not cache:", path, error);
          }
        })
      );

      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();

      await Promise.all(
        keys.map(async key => {
          if (
            key.startsWith("rishi-music-") &&
            key !== CACHE_NAME
          ) {
            await caches.delete(key);
          }
        })
      );

      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;

  // Do not interfere with audio range requests.
  if (
    request.headers.has("range") ||
    url.pathname.includes("/songs/")
  ) {
    return;
  }

  if (!url.pathname.startsWith("/spiderman1/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);

          if (response.ok) {
            const cache = await caches.open(CACHE_NAME);

            await cache.put(
              "/spiderman1/index.html",
              response.clone()
            );
          }

          return response;
        } catch (error) {
          const cache = await caches.open(CACHE_NAME);

          const cachedPage =
            await cache.match("/spiderman1/index.html") ||
            await cache.match("/spiderman1/");

          return cachedPage || new Response(
            "Rishi Music is unavailable offline. Open it online once.",
            {
              status: 503,
              headers: {
                "Content-Type": "text/plain; charset=utf-8"
              }
            }
          );
        }
      })()
    );

    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);

      const update = fetch(request).then(async response => {
        if (response.ok) {
          await cache.put(request, response.clone());
        }

        return response;
      });

      if (cached) {
        event.waitUntil(update.catch(() => undefined));
        return cached;
      }

      try {
        return await update;
      } catch (error) {
        return new Response("File unavailable offline.", {
          status: 503,
          headers: {
            "Content-Type": "text/plain; charset=utf-8"
          }
        });
      }
    })()
  );
});