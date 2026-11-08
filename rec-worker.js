'use strict';
// Ajudante do leitor: só reconhece texto (recortes) enviados pelo ocr-worker.js. Vários rodam ao mesmo tempo.
importScripts('ocr/ort/ort.wasm.min.js', 'paddle.js');
let ctx = null;
async function iniciar() {
  ort.env.wasm.wasmPaths = new URL('ocr/ort/', self.location.href).href;
  ort.env.wasm.numThreads = 1;
  const [rec, dict] = await Promise.all([
    fetch('ocr/paddle/rec.onnx').then(r => r.arrayBuffer()), fetch('ocr/paddle/dict.txt').then(r => r.text())
  ]);
  const sess = await ort.InferenceSession.create(new Uint8Array(rec), { executionProviders: ['wasm'] });
  return { sess, dict: Paddle.prepararDict(dict) };
}
self.onmessage = async e => {
  const m = e.data;
  try {
    if (!ctx) ctx = await iniciar();
    if (m.tipo === 'init') return self.postMessage({ id: m.id, pronto: true });
    const crop = { data: new Uint8ClampedArray(m.buffer), width: m.width, height: m.height };
    self.postMessage({ id: m.id, r: await Paddle.reconhecer(ort, ctx.sess, ctx.dict, crop) });
  } catch (err) { self.postMessage({ id: m.id, erro: String((err && err.message) || err) }); }
};
