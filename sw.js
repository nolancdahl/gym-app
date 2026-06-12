// Minimal service worker — enough for Chrome to treat the app as installable.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', () => {
  // No-op: let the network handle requests. Presence of a fetch handler is what
  // satisfies the installability requirement.
})
