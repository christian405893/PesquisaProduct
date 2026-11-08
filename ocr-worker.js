'use strict';
// Roda o OCR fora da thread principal, para a tela não travar enquanto lê as fotos.
importScripts('ocr/ort/ort.wasm.min.js', 'paddle.js');

let motor = null;

async function criarMotor() {
  ort.env.wasm.wasmPaths = new URL('ocr/ort/', self.location.href).href;
  ort.env.wasm.numThreads = 1;
  const buf = async f => (await fetch('ocr/paddle/' + f)).arrayBuffer();
  const [det, rec, dict] = await Promise.all([
    buf('det.onnx'), buf('rec.onnx'), fetch('ocr/paddle/dict.txt').then(r => r.text())
  ]);
  return Paddle.criar(ort, new Uint8Array(det), new Uint8Array(rec), dict, { sessionOptions: { executionProviders: ['wasm'] } });
}

self.onmessage = async e => {
  const { id, buffer, width, height } = e.data;
  try {
    if (!motor) {
      self.postMessage({ id, tipo: 'prog', f: 0.05, txt: 'Carregando leitor offline (1ª vez demora um pouco)…' });
      motor = await criarMotor();
    }
    const img = { data: new Uint8ClampedArray(buffer), width, height };
    let ultimo = 0;
    const linhas = await motor.ler(img, f => {
      const agora = Date.now();
      if (agora - ultimo > 120 || f >= 1) { ultimo = agora; self.postMessage({ id, tipo: 'prog', f }); }
    });
    self.postMessage({ id, tipo: 'ok', linhas: Array.from(linhas), meta: linhas.meta, info: linhas.info });
  } catch (err) {
    self.postMessage({ id, tipo: 'erro', msg: String((err && err.message) || err) });
  }
};
