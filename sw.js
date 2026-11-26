// Offline cache: after the first visit the app works without internet.
// Online the files come from the site (so updates show at once); offline they come from the saved copy.
const CACHE = 'viz-v3'; // change on every release so phones refresh the cache
const FILES = [
    './',
    './index.html',
    './auth.html',
    './config.js',
    './manifest.webmanifest',
    './icon.svg',
    './icon-192.png',
    './icon-512.png',
    './css/app.css',
    './vendor/jszip.min.js',
    './vendor/mp4-muxer.min.js',
    './js/app.js',
    './js/device.js',
    './js/editor.js',
    './js/en.js',
    './js/exporter.js',
    './js/geom.js',
    './js/i18n.js',
    './js/icons.js',
    './js/imageops.js',
    './js/infocard.js',
    './js/media.js',
    './js/mobile.js',
    './js/model.js',
    './js/onedrive.js',
    './js/project.js',
    './js/quote.js',
    './js/renderer.js',
    './js/store.js',
    './js/ui.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return; // OneDrive etc. go to the network
  // online: fresh files (and refresh the saved copy); offline or very slow network: the saved copy
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const net = fetch(req, { cache: 'no-cache' }).then((r) => { if (r.ok) c.put(req, r.clone()); return r; });
    const timeout = new Promise((res) => setTimeout(res, 4000));
    try {
      const r = await Promise.race([net, timeout]);
      if (r) return r;
    } catch { /* offline */ }
    return (await c.match(req, { ignoreSearch: true })) || (await c.match('./index.html')) || net;
  }));
});
