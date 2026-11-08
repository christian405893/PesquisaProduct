// OCR offline (PaddleOCR PP-OCR em ONNX): detector DB + reconhecedor CTC latino (pt-BR).
// Funciona no navegador (onnxruntime-web) e no Node - recebe o `ort` pronto.
// Antes de ler, endireita a foto sozinho: gira (foto de lado / de cabeça para baixo) e corrige a inclinação.
(function (root) {
  const DET_MAX_SIDE = 1920, DET_THRESH = 0.3, BOX_THRESH = 0.5, UNCLIP = 1.6, REC_H = 48;
  const TOL_LINHA = 0.7; // tolerância (x altura mediana do texto) para juntar pedaços numa mesma linha

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
  // devolve o mapa de probabilidade (prob, w x h) e, se pedido, as caixas de texto
  async function detectar(ort, sess, img, comCaixas = true) {
    const k = Math.min(1, DET_MAX_SIDE / Math.max(img.width, img.height));
    const w = Math.max(32, Math.round(img.width * k / 32) * 32), h = Math.max(32, Math.round(img.height * k / 32) * 32);
    const small = resizeBilinear(img, w, h);
    const out = await sess.run({ [sess.inputNames[0]]: toTensor(ort, small, [.485, .456, .406], [.229, .224, .225]) });
    const prob = out[sess.outputNames[0]].data; // [1,1,h,w]
    const res = { prob, w, h, boxes: [] };
    if (!comCaixas) return res;
    // binariza + componentes conexos (4-vizinhança)
    const lab = new Uint8Array(w * h), boxes = res.boxes, stack = [];
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
    return res;
  }

  // ---- orientação e inclinação ----
  // pontos (metade da resolução) onde o detector achou texto
  function pontosDoMapa(prob, w, h) {
    const hw = w >> 1, hh = h >> 1, xs = [], ys = [];
    for (let y = 0; y < hh; y++) for (let x = 0; x < hw; x++) {
      const i = 2 * y * w + 2 * x;
      if ((prob[i] > DET_THRESH) + (prob[i + 1] > DET_THRESH) + (prob[i + w] > DET_THRESH) + (prob[i + w + 1] > DET_THRESH) >= 2) { xs.push(x); ys.push(y); }
    }
    return { xs: Float32Array.from(xs), ys: Float32Array.from(ys), w: hw, h: hh };
  }
  // quanto as linhas de texto ficam "separadas" se a foto for girada `graus` (anti-horário):
  // linhas bem horizontais dão um perfil de linhas/espaços com muito contraste
  function pontuacao(P, graus) {
    const r = graus * Math.PI / 180, s = Math.sin(r), c = Math.cos(r), { xs, ys, w, h } = P;
    const cantos = [0, -w * s, h * c, -w * s + h * c], vmin = Math.min(...cantos), vmax = Math.max(...cantos);
    const bins = new Float64Array(Math.ceil(vmax - vmin) + 3);
    for (let i = 0; i < xs.length; i++) bins[(-xs[i] * s + ys[i] * c - vmin) | 0]++;
    let sc = 0;
    for (let j = 1; j < bins.length; j++) { const d = bins[j] - bins[j - 1]; sc += d * d; }
    return sc;
  }
  // ângulo (graus, anti-horário) para deixar o texto na horizontal: 0 = já está reto, ~90 = foto de lado
  function achar_angulo(P) {
    if (P.xs.length < 50) return 0;
    const base = pontuacao(P, 90) > pontuacao(P, 0) ? 90 : 0;
    let melhor = base, ms = -1;
    for (let d = -30; d <= 30; d++) { const a = base + d * 0.5, s = pontuacao(P, a); if (s > ms) { ms = s; melhor = a; } }
    const centro = melhor;
    for (let d = -1; d <= 1; d += 0.25) { const a = centro + d, s = pontuacao(P, a); if (s > ms) { ms = s; melhor = a; } }
    return melhor;
  }

  // gira a imagem `graus` no sentido anti-horário, aumentando a tela para não cortar (fundo branco)
  function girar(img, graus) {
    const r = graus * Math.PI / 180, c = Math.cos(r), s = Math.sin(r), w = img.width, h = img.height;
    const nw = Math.ceil(Math.abs(w * c) + Math.abs(h * s) - 1e-6), nh = Math.ceil(Math.abs(w * s) + Math.abs(h * c) - 1e-6);
    const out = new Uint8ClampedArray(nw * nh * 4).fill(255), S = img.data;
    const cx = (w - 1) / 2, cy = (h - 1) / 2, ncx = (nw - 1) / 2, ncy = (nh - 1) / 2;
    for (let y = 0; y < nh; y++) {
      const dy = y - ncy;
      for (let x = 0; x < nw; x++) {
        const dx = x - ncx, sx = dx * c - dy * s + cx, sy = dx * s + dy * c + cy;
        if (sx < 0 || sy < 0 || sx > w - 1 || sy > h - 1) continue;
        const x0 = sx | 0, y0 = sy | 0, x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1), wx = sx - x0, wy = sy - y0;
        const a = (y0 * w + x0) * 4, b = (y0 * w + x1) * 4, d = (y1 * w + x0) * 4, e = (y1 * w + x1) * 4, o = (y * nw + x) * 4;
        for (let k = 0; k < 3; k++)
          out[o + k] = (S[a + k] * (1 - wx) + S[b + k] * wx) * (1 - wy) + (S[d + k] * (1 - wx) + S[e + k] * wx) * wy;
      }
    }
    return { data: out, width: nw, height: nh };
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
  function girar180(img) {
    const n = img.width * img.height, out = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) { const j = (n - 1 - i) * 4; out[j] = img.data[i * 4]; out[j + 1] = img.data[i * 4 + 1]; out[j + 2] = img.data[i * 4 + 2]; out[j + 3] = 255; }
    return { data: out, width: img.width, height: img.height };
  }

  async function reconhecer(ort, sess, dict, crop) {
    const w = Math.min(2400, Math.max(16, Math.round(crop.width * REC_H / crop.height)));
    const r = resizeBilinear(crop, w, REC_H);
    const out = await sess.run({ [sess.inputNames[0]]: toTensor(ort, r, [.5, .5, .5], [.5, .5, .5]) });
    const o = out[sess.outputNames[0]], T = o.dims[1], C = o.dims[2], d = o.data;
    let txt = '', last = 0, conf = 0, n = 0;
    const confs = []; // confiança (0 a 1) de cada caractere lido, na mesma ordem do texto
    for (let t = 0; t < T; t++) {
      let best = 0, bv = -1;
      for (let c = 0; c < C; c++) { const v = d[t * C + c]; if (v > bv) { bv = v; best = c; } }
      if (best !== 0 && best !== last) {
        const ch = dict[best - 1] ?? '';
        txt += ch; for (let k = 0; k < ch.length; k++) confs.push(bv);
        conf += bv; n++;
      }
      last = best;
    }
    return { text: txt, conf: n ? conf / n : 0, confs };
  }

  // a foto está de cabeça para baixo? compara a leitura de algumas linhas compridas de frente e invertidas
  async function estaInvertida(ort, rec, dict, img, boxes) {
    const alvo = boxes.filter(b => b.x1 - b.x0 > 5 * (b.y1 - b.y0) && b.y1 - b.y0 >= 8)
      .sort((a, b) => (b.x1 - b.x0) - (a.x1 - a.x0)).slice(0, 10);
    if (alvo.length < 3) return false;
    let normal = 0, invertido = 0;
    for (const b of alvo) {
      const crop = recortar(img, b);
      normal += (await reconhecer(ort, rec, dict, crop)).conf;
      invertido += (await reconhecer(ort, rec, dict, girar180(crop))).conf;
    }
    return invertido > normal;
  }

  // agrupa fragmentos em linhas, da esquerda para a direita, seguindo a leve inclinação de cada linha
  function montarLinhas(frags) {
    if (!frags.length) return [];
    const hs = frags.map(f => f.b.y1 - f.b.y0).sort((a, b) => a - b), tol = TOL_LINHA * hs[hs.length >> 1];
    const linhas = [];
    for (const f of frags.slice().sort((a, b) => a.b.x0 - b.b.x0)) {
      const cx = (f.b.x0 + f.b.x1) / 2, cy = (f.b.y0 + f.b.y1) / 2;
      let melhor = null, md = 1e9;
      for (const l of linhas) {
        const d = Math.abs(l.cy + l.slope * (cx - l.cx) - cy);
        if (d < tol && d < md) { melhor = l; md = d; }
      }
      if (melhor) {
        if (cx - melhor.cx0 > 300) melhor.slope = Math.max(-.08, Math.min(.08, (cy - melhor.cy0) / (cx - melhor.cx0)));
        melhor.cx = cx; melhor.cy = cy; melhor.f.push(f);
      } else linhas.push({ cx, cy, cx0: cx, cy0: cy, slope: 0, f: [f] });
    }
    // pedaços soltos (ex.: um preço que ficou numa linha sozinho, no lado direito da folha)
    // voltam para a linha mais próxima que ainda não tem nada naquela coluna
    const maxX = Math.max(...frags.map(f => f.b.x1));
    const solta = l => l.f.length <= 2 && l.f[0].b.x0 > 0.55 * maxX;
    const soltas = linhas.filter(solta), fixas = linhas.filter(l => !solta(l));
    for (const o of soltas) {
      for (const f of o.f.slice()) {
        const cx = (f.b.x0 + f.b.x1) / 2, cy = (f.b.y0 + f.b.y1) / 2;
        let melhor = null, md = 1.3 * tol;
        for (const l of fixas) {
          if (l.f.some(g => g.b.x0 < f.b.x1 && g.b.x1 > f.b.x0)) continue; // coluna já ocupada
          const d = Math.abs(l.cy + l.slope * (cx - l.cx) - cy);
          if (d < md) { melhor = l; md = d; }
        }
        if (melhor) { melhor.f.push(f); o.f = o.f.filter(g => g !== f); }
      }
    }
    const final = linhas.filter(l => l.f.length);
    final.sort((a, b) => a.cy0 - b.cy0);
    const textos = [], meta = [];
    for (const l of final) {
      let texto = '', confs = [], somaCy = 0;
      for (const f of l.f.sort((a, b) => a.b.x0 - b.b.x0)) {
        const t = f.text, ini = t.length - t.trimStart().length, tt = t.trim();
        if (!tt) continue;
        if (texto) { texto += '  '; confs.push(1, 1); }
        texto += tt;
        const cs = f.confs || [];
        for (let k = 0; k < tt.length; k++) confs.push(cs.length ? (cs[ini + k] ?? 1) : 1);
        somaCy += (f.b.y0 + f.b.y1) / 2;
      }
      textos.push(texto); meta.push({ cy: somaCy / l.f.length, confs });
    }
    textos.meta = meta;
    return textos;
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
        const prog = f => onProgress && onProgress(Math.min(1, f));
        // 1) endireita a foto: gira se estiver de lado e corrige a inclinação
        let d = await detectar(ort, det, img, false);
        prog(0.1);
        const angulo = achar_angulo(pontosDoMapa(d.prob, d.w, d.h));
        let im = img;
        if (Math.abs(angulo) > 0.3) im = girar(img, angulo);
        d = await detectar(ort, det, im, true);
        prog(0.2);
        let boxes = d.boxes;
        // 2) de cabeça para baixo?
        const invertida = await estaInvertida(ort, rec, dict, im, boxes);
        if (invertida) {
          const W = im.width, H = im.height;
          im = girar(im, 180);
          boxes = boxes.map(b => ({ x0: W - b.x1, y0: H - b.y1, x1: W - b.x0, y1: H - b.y0 }));
        }
        // 3) lê cada pedaço de texto
        const frags = [];
        for (let i = 0; i < boxes.length; i++) {
          const crop = recortar(im, boxes[i]);
          if (crop.width >= 2 && crop.height >= 2) {
            const r = await reconhecer(ort, rec, dict, crop);
            if (r.text.trim()) frags.push({ b: boxes[i], text: r.text, conf: r.conf, confs: r.confs });
          }
          prog(0.2 + 0.8 * (i + 1) / boxes.length);
        }
        const linhas = montarLinhas(frags);
        linhas.info = { angulo, invertida };
        linhas.meta = linhas.meta; // posição vertical e confiança de cada caractere, por linha
        linhas.frags = frags; // (para testes)
        return linhas;
      }
    };
  }

  const api = { criar, montarLinhas, achar_angulo, pontosDoMapa, girar };
  if (typeof module !== 'undefined') module.exports = api; else root.Paddle = api;
})(typeof self !== 'undefined' ? self : this);
