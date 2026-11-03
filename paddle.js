// OCR offline (PaddleOCR PP-OCR em ONNX): detector DB + reconhecedor CTC latino (pt-BR).
// Funciona no navegador (onnxruntime-web) e no Node (onnxruntime-node) - recebe o `ort` pronto.
(function (root) {
  const DET_MAX_SIDE = 1920, DET_THRESH = 0.3, BOX_THRESH = 0.5, UNCLIP = 1.6, REC_H = 48;

  // imagem = { data: Uint8ClampedArray RGBA, width, height }
  function resizeBilinear(img, w, h) {
    const out = new Uint8ClampedArray(w * h * 4), sx = img.width / w, sy = img.height / h, S = img.data, W = img.width;
    for (let y = 0; y < h; y++) {
      const fy = Math.max(0, (y + .5) * sy - .5), y0 = Math.floor(fy), y1 = Math.min(img.height - 1, y0 + 1), wy = fy - y0;
      for (let x = 0; x < w; x++) {
        const fx = Math.max(0, (x + .5) * sx - .5), x0 = Math.floor(fx), x1 = Math.min(W - 1, x0 + 1), wx = fx - x0;
        const a = (y0 * W + x0) * 4, b = (y0 * W + x1) * 4, c = (y1 * W + x0) * 4, d = (y1 * W + x1) * 4, o = (y * w + x) * 4;
        for (let k = 0; k < 3; k++)
          out[o + k] = (S[a + k] * (1 - wx) + S[b + k] * wx) * (1 - wy) + (S[c + k] * (1 - wx) + S[d + k] * wx) * wy;
        out[o + 3] = 255;
      }
    }
    return { data: out, width: w, height: h };
  }

  function toTensor(ort, img, mean, std) {
    const { data, width: w, height: h } = img, n = w * h, f = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) f[k * n + i] = (data[i * 4 + k] / 255 - mean[k]) / std[k];
    return new ort.Tensor('float32', f, [1, 3, h, w]);
  }

  // ---- detecção ----
  async function detectar(ort, sess, img) {
    const k = Math.min(1, DET_MAX_SIDE / Math.max(img.width, img.height));
    const w = Math.max(32, Math.round(img.width * k / 32) * 32), h = Math.max(32, Math.round(img.height * k / 32) * 32);
    const small = resizeBilinear(img, w, h);
    const out = await sess.run({ [sess.inputNames[0]]: toTensor(ort, small, [.485, .456, .406], [.229, .224, .225]) });
    const prob = out[sess.outputNames[0]].data; // [1,1,h,w]
    // binariza + componentes conexos (4-vizinhança)
    const lab = new Uint8Array(w * h), boxes = [], stack = [];
    for (let i = 0; i < w * h; i++) {
      if (prob[i] <= DET_THRESH || lab[i]) continue;
      let x0 = w, y0 = h, x1 = 0, y1 = 0, cnt = 0, sum = 0;
      stack.push(i); lab[i] = 1;
      while (stack.length) {
        const p = stack.pop(), x = p % w, y = (p - x) / w;
        cnt++; sum += prob[p];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && !lab[p - 1] && prob[p - 1] > DET_THRESH) { lab[p - 1] = 1; stack.push(p - 1); }
        if (x < w - 1 && !lab[p + 1] && prob[p + 1] > DET_THRESH) { lab[p + 1] = 1; stack.push(p + 1); }
        if (y > 0 && !lab[p - w] && prob[p - w] > DET_THRESH) { lab[p - w] = 1; stack.push(p - w); }
        if (y < h - 1 && !lab[p + w] && prob[p + w] > DET_THRESH) { lab[p + w] = 1; stack.push(p + w); }
      }
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      if (bw < 3 || bh < 3 || sum / cnt < BOX_THRESH) continue;
      // "unclip": o mapa é a região encolhida do texto, expande de volta
      const d = (bw * bh * UNCLIP) / (2 * (bw + bh));
      boxes.push({
        x0: Math.max(0, (x0 - d) / k), y0: Math.max(0, (y0 - d * .6) / k),
        x1: Math.min(img.width, (x1 + 1 + d) / k), y1: Math.min(img.height, (y1 + 1 + d * .6) / k)
      });
    }
    return boxes;
  }

  // ---- reconhecimento ----
  function recortar(img, b) {
    const x0 = Math.floor(b.x0), y0 = Math.floor(b.y0), w = Math.ceil(b.x1) - x0, h = Math.ceil(b.y1) - y0;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      const s = ((y0 + y) * img.width + x0) * 4;
      out.set(img.data.subarray(s, s + w * 4), y * w * 4);
    }
    return { data: out, width: w, height: h };
  }

  async function reconhecer(ort, sess, dict, crop) {
    const w = Math.min(2400, Math.max(16, Math.round(crop.width * REC_H / crop.height)));
    const r = resizeBilinear(crop, w, REC_H);
    const out = await sess.run({ [sess.inputNames[0]]: toTensor(ort, r, [.5, .5, .5], [.5, .5, .5]) });
    const o = out[sess.outputNames[0]], T = o.dims[1], C = o.dims[2], d = o.data;
    let txt = '', last = 0, conf = 0, n = 0;
    for (let t = 0; t < T; t++) {
      let best = 0, bv = -1;
      for (let c = 0; c < C; c++) { const v = d[t * C + c]; if (v > bv) { bv = v; best = c; } }
      if (best !== 0 && best !== last) { txt += dict[best - 1] ?? ''; conf += bv; n++; }
      last = best;
    }
    return { text: txt, conf: n ? conf / n : 0 };
  }

  // agrupa fragmentos em linhas e ordena da esquerda p/ direita
  function montarLinhas(frags) {
    frags.sort((a, b) => (a.b.y0 + a.b.y1) - (b.b.y0 + b.b.y1));
    const linhas = [];
    for (const f of frags) {
      const cy = (f.b.y0 + f.b.y1) / 2, h = f.b.y1 - f.b.y0;
      const l = linhas.find(l => Math.abs(l.cy - cy) < Math.max(l.h, h) * .45);
      if (l) { l.f.push(f); l.cy = (l.cy * (l.f.length - 1) + cy) / l.f.length; l.h = Math.max(l.h, h); }
      else linhas.push({ cy, h, f: [f] });
    }
    linhas.sort((a, b) => a.cy - b.cy);
    return linhas.map(l => l.f.sort((a, b) => a.b.x0 - b.b.x0).map(f => f.text.trim()).filter(Boolean).join('  '));
  }

  async function criar(ort, detBuf, recBuf, dictText, opts = {}) {
    const so = opts.sessionOptions || {};
    const det = await ort.InferenceSession.create(detBuf, so);
    const rec = await ort.InferenceSession.create(recBuf, so);
    const dict = dictText.split('\n').map(s => s.replace(/\r$/, ''));
    if (dict[dict.length - 1] === '') dict.pop();
    dict.push(' ');
    return {
      async ler(img, onProgress) {
        const boxes = await detectar(ort, det, img);
        const frags = [];
        for (let i = 0; i < boxes.length; i++) {
          const crop = recortar(img, boxes[i]);
          const r = await reconhecer(ort, rec, dict, crop);
          if (r.text.trim()) frags.push({ b: boxes[i], text: r.text, conf: r.conf });
          if (onProgress) onProgress((i + 1) / boxes.length);
        }
        return montarLinhas(frags);
      }
    };
  }

  const api = { criar };
  if (typeof module !== 'undefined') module.exports = api; else root.Paddle = api;
})(typeof self !== 'undefined' ? self : this);
