const CACHE = "nce-v13";
const FILES = [
  "./", "index.html", "app.js", "ocr-worker.js", "rec-worker.js", "simulador.js", "parser.js", "paddle.js", "style.css", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png",
  "ocr/ort/ort.wasm.min.js", "ocr/ort/ort-wasm-simd-threaded.mjs", "ocr/ort/ort-wasm-simd-threaded.wasm",
  "ocr/paddle/det.onnx", "ocr/paddle/rec.onnx", "ocr/paddle/dict.txt"
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request)));
});
