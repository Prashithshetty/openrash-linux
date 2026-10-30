// Installable-app service worker. It has no fetch handler and caches nothing, so every visit loads the current build.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
