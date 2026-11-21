// Minimal service worker so Chrome offers "Install". It caches nothing: the app always loads fresh from the network,
// because stock and prices must be live and a stale cached copy of the app would be worse than no offline mode.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
