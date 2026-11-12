// SPDX-License-Identifier: MIT
//
// Service worker for MarkItDown Web.
//
// Strategy:
//   * At install, precache the full application shell + the entire WASM
//     engine (pyodide runtime & packages, vendored wheels, onnxruntime,
//     magika model). After the first successful install the app is 100%
//     functional with no network ("works offline").
//   * Runtime requests go cache-first with a background revalidate, so
//     weekly engine updates appear on the second load.
//   * The precache manifest is generated at build time by
//     scripts/build-site.sh (PRECACHE_URLS below) and stamped with the
//     build id, so each weekly build swaps the cache atomically.

const VERSION = "__BUILD_ID__";
const APP_SHELL = [
  "./",
  "index.html",
  "app.js",
  "magika.js",
  "ort-setup.js",
  "styles.css",
  "manifest.webmanifest",
  "python/api.py",
  "wheels/wheels.json",
  "icons/icon-64.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/maskable-512.png",
];

// Engine assets (pyodide runtime, wasm packages, wheels, ort wasm, model)
// are appended at build time; together with APP_SHELL they make up the
// complete offline bundle.
const ENGINE_URLS = __PRECACHE_URLS__;

const CACHE = `markitdown-web-${VERSION}`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // addAll fails the whole install on any 404 — that's what we want:
      // a partially-cached engine is not "works offline".
      await cache.addAll([...APP_SHELL, ...ENGINE_URLS]);
      self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith("markitdown-web-") && k !== CACHE).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;
  if (event.request.method !== "GET") return;

  // Same-origin navigations → app shell.
  if (event.request.mode === "navigate") {
    event.respondWith(
      caches.match("index.html").then(
        (hit) =>
          hit ||
          fetch(event.request).then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put("index.html", copy));
            return res;
          })
      )
    );
    return;
  }

  // Everything else: cache-first + background revalidate.
  event.respondWith(
    caches.match(event.request).then((hit) => {
      const fetching = fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(event.request, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || fetching;
    })
  );
});

// Allow the page to trigger an immediate update check (used after installs).
self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});
