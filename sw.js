/* Service worker de la Matrice d'Eisenhower.
   - Précache la « coquille » de l'appli pour un fonctionnement hors-ligne.
   - Ne met JAMAIS en cache l'API /api/state (toujours réseau).
   Incrémente CACHE_VERSION à chaque changement de fichier statique. */
const CACHE_VERSION = "eisenhower-v4";
const SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // L'API n'est jamais servie depuis le cache.
  if (url.pathname.startsWith("/api/")) return;
  if (request.method !== "GET") return;

  // Coquille statique : réseau d'abord (fraîcheur garantie après chaque
  // déploiement), cache en secours pour le hors-ligne. Évite les pages
  // « mélangées » (nouveau HTML + vieux CSS) après une mise à jour.
  event.respondWith(
    fetch(request)
      .then((resp) => {
        if (resp && resp.status === 200 && resp.type === "basic") {
          const copy = resp.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(request, copy));
        }
        return resp;
      })
      .catch(() =>
        caches.match(request).then(
          (cached) =>
            cached ||
            (request.mode === "navigate"
              ? caches.match("./index.html")
              : Response.error())
        )
      )
  );
});
