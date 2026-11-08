'use strict';
// Roda o OCR fora da thread principal, para a tela não travar enquanto lê as fotos.
importScripts('ocr/ort/ort.wasm.min.js', 'paddle.js');

let motor = null;

// Ajudantes: threads extras que só reconhecem texto, para a leitura terminar bem mais rápido.
// Cada um é um "worker" separado (sem precisar de nenhum recurso especial do navegador).
const helpers = [];
let helperSeq = 0;
function novoHelper() {
  const w = new Worker('rec-worker.js'), pend = new Map(), h = { w, morto: false, pend };
  w.onmessage = e => { const p = pend.get(e.data.id); if (!p) return; pend.delete(e.data.id); e.data.erro ? p.rej(new Error(e.data.erro)) : p.res(e.data); };
  w.onerror = () => { h.morto = true; pend.forEach(p => p.rej(new Error('ajudante caiu'))); pend.clear(); };
  h.chamar = (msg, transfer) => new Promise((res, rej) => { const id = ++helperSeq; pend.set(id, { res, rej }); w.postMessage({ id, ...msg }, transfer || []); });
  h.pronto = h.chamar({ tipo: 'init' }).catch(() => { h.morto = true; });
  return h;
}
function iniciarHelpers() {
  if (typeof Worker === 'undefined' || helpers.length) return;
  const n = Math.max(0, Math.min(3, ((self.navigator && self.navigator.hardwareConcurrency) || 4) - 2));
  for (let i = 0; i < n; i++) { try { helpers.push(novoHelper()); } catch (e) { break; } }
}
const pool = {
  async map(crops, onProg, local) {
    const n = crops.length, out = new Array(n); let next = 0, feitos = 0;
    const fila = [], pega = () => (fila.length ? fila.pop() : next < n ? next++ : -1);
    const tarefaLocal = async () => { for (let i; (i = pega()) >= 0;) { out[i] = await local(i); onProg(++feitos); } };
    const tarefaHelper = async h => {
      await h.pronto; if (h.morto) return;
      for (let i; (i = pega()) >= 0;) {
        try {
          const c = crops[i], copia = c.data.slice();
          out[i] = (await h.chamar({ tipo: 'rec', buffer: copia.buffer, width: c.width, height: c.height }, [copia.buffer])).r;
          onProg(++feitos);
        } catch (e) { h.morto = true; fila.push(i); return; } // devolve o item para outro leitor
      }
    };
    await Promise.all([tarefaLocal(), ...helpers.map(tarefaHelper)]);
    for (let i = 0; i < n; i++) if (out[i] === undefined) { out[i] = await local(i); onProg(++feitos); } // sobras de algum ajudante que caiu
    return out;
  }
};

async function criarMotor() {
  ort.env.wasm.wasmPaths = new URL('ocr/ort/', self.location.href).href;
  ort.env.wasm.numThreads = 1;
  const buf = async f => (await fetch('ocr/paddle/' + f)).arrayBuffer();
  const [det, rec, dict] = await Promise.all([
    buf('det.onnx'), buf('rec.onnx'), fetch('ocr/paddle/dict.txt').then(r => r.text())
  ]);
  return Paddle.criar(ort, new Uint8Array(det), new Uint8Array(rec), dict, { sessionOptions: { executionProviders: ['wasm'] }, pool });
}

// Decodifica e reduz a foto AQUI no worker (fotos de 50 MP travavam a tela quando isso era feito na thread principal)
async function prepararFoto(file) {
  const MAX = 2800;
  const sonda = await createImageBitmap(file, { imageOrientation: 'from-image', resizeWidth: 256, resizeQuality: 'low' });
  const paisagem = sonda.width >= sonda.height; sonda.close();
  // só um lado é informado: o navegador calcula o outro mantendo a proporção exata
  const bmp = await createImageBitmap(file, paisagem
    ? { imageOrientation: 'from-image', resizeWidth: MAX, resizeQuality: 'medium' }
    : { imageOrientation: 'from-image', resizeHeight: MAX, resizeQuality: 'medium' });
  const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0); bmp.close();
  const d = g.getImageData(0, 0, c.width, c.height);
  return { data: d.data, width: d.width, height: d.height };
}

self.onmessage = async e => {
  const { id, buffer, width, height, file } = e.data;
  try {
    let img;
    if (file) {
      self.postMessage({ id, tipo: 'prog', f: 0.02, txt: 'Preparando a foto…' });
      try { img = await prepararFoto(file); }
      catch (err) { self.postMessage({ id, tipo: 'erro', prep: true, msg: String((err && err.message) || err) }); return; }
    } else img = { data: new Uint8ClampedArray(buffer), width, height };
    iniciarHelpers(); // já começam a carregar enquanto a foto é preparada e a tabela detectada
    if (!motor) {
      self.postMessage({ id, tipo: 'prog', f: 0.05, txt: 'Carregando leitor offline (1ª vez demora um pouco)…' });
      motor = await criarMotor();
    }
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
