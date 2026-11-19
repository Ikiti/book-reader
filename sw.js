// Service worker: offline app shell + Android share target.
// Bump VERSION when you deploy changes so clients pick up the new files.
const VERSION = 'br-v8';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/db.js',
  './js/ui.js',
  './js/settings.js',
  './js/library.js',
  './js/progress.js',
  './js/reader.js',
  './js/notes/notes.js',
  './js/notes/providers.js',
  './js/pdf/pdfjs.js',
  './js/pdf/extract.js',
  './js/pdf/analyze.js',
  './js/pdf/regions.js',
  './js/pdf/layout.js',
  './js/pdf/geometry.js',
  './js/pdf/title.js',
  './js/epub/epub.js',
  './js/epub/zip.js',
  './js/epub/export.js',
  './js/epub/unzip.js',
  './js/epub/import.js',
  './js/epub/load.js',
  './js/ocr/provider.js',
  './js/ocr/raster.js',
  './js/ocr/page.js',
  './js/ocr/skew.js',
  './vendor/tesseract/tesseract.esm.min.js',
  './vendor/tesseract/worker.min.js',
  './vendor/pdfjs/pdf.min.mjs',
  './vendor/pdfjs/pdf.worker.min.mjs',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-192.png',
  './icons/maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(SHELL);
    // pdf.js fonts and image decoders (JPEG 2000 / JBIG2 in scanned books), so imports work offline.
    try {
      const list = await (await fetch('./vendor/pdfjs/files.json')).json();
      await cache.addAll(list);
    } catch (err) { console.warn('optional precache failed', err); }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION && k !== 'share-inbox').map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  // Android share sheet → "Book Reader": stash the PDFs, then open the app which imports them.
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      const form = await e.request.formData();
      const cache = await caches.open('share-inbox');
      let n = 0;
      for (const f of form.getAll('file')) {
        if (!(f instanceof File)) continue;
        await cache.put(`./__inbox/${Date.now()}-${n++}`, new Response(f, {
          headers: { 'content-type': f.type || 'application/pdf', 'x-name': encodeURIComponent(f.name || 'shared.pdf') },
        }));
      }
      return Response.redirect('./#/inbox', 303);
    })());
    return;
  }

  if (e.request.method !== 'GET') return;
  // Cache first, then network (and refresh the cache in the background).
  // Vendored libraries never change under the same name: no refresh (the OCR engine is ~4 MB).
  const immutable = url.pathname.includes('/vendor/');
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(e.request, { ignoreSearch: true });
    if (cached && immutable) return cached;
    const network = fetch(e.request).then((res) => {
      if (res.ok && res.type === 'basic') cache.put(e.request, res.clone());
      return res;
    }).catch(() => null);
    if (cached) { e.waitUntil(network); return cached; }
    const res = await network;
    return res || (e.request.mode === 'navigate' ? cache.match('./index.html') : Response.error());
  })());
});
