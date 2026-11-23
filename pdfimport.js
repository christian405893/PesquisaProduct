// Importação de PDF (Adobe Scan etc.): tira as fotos das páginas de dentro do PDF e junta as leituras
// de páginas repetidas (a mesma folha fotografada 2 ou 4 vezes) numa tabela só.
(function (root) {
  /* ---------- 1) fotos dentro do PDF ---------- */
  // PDFs de scanner guardam cada página como uma imagem JPEG (DCTDecode). Procura esses blocos sem precisar de biblioteca.
  function achar(b, txt, de) {
    const n = txt.length;
    for (let i = de; i <= b.length - n; i++) {
      if (b[i] !== txt.charCodeAt(0)) continue;
      let ok = true; for (let k = 1; k < n; k++) if (b[i + k] !== txt.charCodeAt(k)) { ok = false; break; }
      if (ok) return i;
    }
    return -1;
  }
  function extrairImagens(buf, minBytes) {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf), out = [];
    let pos = 0;
    for (;;) {
      const s = achar(b, 'stream', pos); if (s < 0) break;
      let ini = s + 6; if (b[ini] === 13) ini++; if (b[ini] === 10) ini++;
      const e = achar(b, 'endstream', ini); if (e < 0) break;
      pos = e + 9;
      if (b[ini] !== 0xff || b[ini + 1] !== 0xd8 || b[ini + 2] !== 0xff) continue; // não é JPEG
      let fim = e; while (fim > ini && (b[fim - 1] === 10 || b[fim - 1] === 13)) fim--;
      if (fim - ini >= (minBytes || 40000)) out.push(b.slice(ini, fim));
    }
    return out;
  }

  /* ---------- 2) juntar leituras repetidas ---------- */
  const LIM = 0.8;
  const hamming = (a, b) => { if (a.length !== b.length) return 99; let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d; };
  const num = t => parseFloat(String(t).replace(/\./g, '').replace(',', '.'));
  const dinheiro = v => (Math.round(v * 100) / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const ok6 = s => /^\d{6}$/.test(String(s || ''));

  // paginas: [{ tipo:'produtos'|'seguro', itens:[...] }]  -> { produtos:[], seguros:[], info }
  function juntar(paginas, Parser) {
    const info = { paginas: paginas.length, linhas: 0, semNce: 0, repetidas: 0 };
    const res = {};
    for (const tipo of ['produtos', 'seguro']) {
      const campos = tipo === 'produtos' ? ['qtd', 'preco'] : ['g1', 'g2'];
      const cands = [];
      paginas.filter(p => p.tipo === tipo).forEach((p, pi) => p.itens.forEach(it => { info.linhas++; cands.push({ ...it, _p: pi, _conf: it.conf || {} }); }));
      // grupos: uma chave por NCE bem lido; leituras duvidosas entram no grupo do NCE parecido (1 dígito de diferença + nome parecido)
      const grupos = new Map();
      const seguras = cands.filter(c => ok6(c.nce) && (c._conf.nce === undefined || c._conf.nce >= LIM));
      const duvid = cands.filter(c => !seguras.includes(c));
      seguras.forEach(c => { if (!grupos.has(c.nce)) grupos.set(c.nce, []); grupos.get(c.nce).push(c); });
      const chaves = [...grupos.keys()];
      for (const c of duvid) {
        if (!ok6(c.nce)) { info.semNce++; continue; }
        let k = c.nce;
        if (!grupos.has(k)) {
          const par = chaves.filter(x => hamming(x, c.nce) <= 1 && (!c.nome || Parser.similaridade(c.nome, grupos.get(x)[0].nome) >= 0.6));
          if (par.length === 1) k = par[0];
        }
        if (!grupos.has(k)) { grupos.set(k, []); }
        grupos.get(k).push(c);
      }
      const itens = [];
      for (const [nce, lista] of grupos) {
        const paginasDistintas = new Set(lista.map(c => c._p)).size;
        if (paginasDistintas > 1) info.repetidas++;
        const conf = { nce: lista.some(c => c.nce === nce && (c._conf.nce === undefined || c._conf.nce >= LIM)) ? 1 : 0 };
        const out = { tipo, nce, conf, leituras: lista.length, raw: lista[0].raw };
        // nome e cor: o texto mais parecido com os demais (consenso); em empate, o mais completo
        const consenso = f => {
          const v = lista.map(c => String(c[f] || '').trim()).filter(Boolean); if (!v.length) return '';
          let best = v[0], bs = -1;
          for (const a of v) { const s = v.reduce((t, b) => t + (a === b ? 1 : Parser.similaridade(a, b) || 0), 0) + a.length / 1000; if (s > bs) { bs = s; best = a; } }
          return best;
        };
        out.nome = consenso('nome'); if (tipo === 'produtos') out.cor = consenso('cor');
        // campos de números: o valor lido com mais certeza; duas leituras iguais confirmam uma à outra.
        // O leitor às vezes perde o 1º dígito na ponta direita da folha ("6,00" em vez de "96,00"): um valor que é só o fim de outro lido em outra foto conta como o mais longo.
        out.alternativas = {};
        const digs = x => x.replace(/\D/g, '');
        const votos = f => {
          const v = lista.filter(c => String(c[f] || '').trim()).map(c => ({ v: String(c[f]).trim(), c: c._conf[f] === undefined ? 0 : c._conf[f] }));
          const por = new Map();
          v.forEach(x => { const e = por.get(x.v) || { v: x.v, n: 0, max: 0, soma: 0 }; e.n++; e.max = Math.max(e.max, x.c); e.soma += x.c; por.set(x.v, e); });
          const es = [...por.values()];
          for (const a of es) for (const b2 of es) if (a !== b2 && digs(b2.v).length > digs(a.v).length && digs(b2.v).endsWith(digs(a.v)) && a.v.split(',')[1] === b2.v.split(',')[1]) { b2.n += a.n; b2.soma += a.soma; a.n = 0; }
          return es.filter(e => e.n > 0).sort((x, y) => (y.max >= LIM) - (x.max >= LIM) || y.n - x.n || y.max - x.max);
        };
        const conferencia = (ord, m) => {
          let c = m.max;
          if (m.n >= 2 && m.soma / m.n >= 0.5) c = Math.max(c, LIM); // duas fotos concordam
          const forte = ord.filter(x => x !== m && x.max >= LIM);
          if (forte.length && m.max >= LIM && m.n === forte[0].n) c = 0; // leituras boas que discordam: confere à mão
          return c;
        };
        if (tipo === 'produtos') {
          for (const f of campos) {
            const ord = votos(f);
            if (!ord.length) { out[f] = ''; conf[f] = 0; continue; }
            out[f] = ord[0].v; conf[f] = conferencia(ord, ord[0]);
            if (ord.length > 1) out.alternativas[f] = ord.map(x => x.v);
          }
        } else {
          // seguro: 1 ano e 2 anos são escolhidos juntos; só vale o par que obedece à regra (2 anos ~ 1,6 x 1 ano)
          const o1 = votos('g1'), o2 = votos('g2'), pares = [];
          for (const x of o1) for (const y of o2) if (Parser.razaoOk(x.v, y.v)) pares.push({ g1: x, g2: y, n: Math.min(x.n, y.n) + x.n + y.n, ok: Math.min(x.max, y.max) });
          pares.sort((p, q) => q.n - p.n || q.ok - p.ok);
          if (pares.length) {
            const p = pares[0]; out.g1 = p.g1.v; out.g2 = p.g2.v;
            conf.g1 = Math.max(p.g1.max, p.g1.n >= 2 ? LIM : 0); conf.g2 = Math.max(p.g2.max, p.g2.n >= 2 ? LIM : 0);
            if (pares.length > 1 && pares[1].n === p.n) conf.g1 = conf.g2 = 0; // dois pares possíveis, empate
          } else {
            // nenhum par bate: tenta completar um dígito perdido no começo (6,00 / 53,60 -> 96,00 / 153,60)
            const reparos = new Set(), a1 = o1.map(x => x.v), a2 = o2.map(x => x.v);
            const com = v => [v].concat(['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(d => (v.includes('.') ? v.replace(/^(\d+)/, d + '$1') : d + v)));
            for (const g1 of a1.slice(0, 2)) for (const g2 of a2.slice(0, 2)) for (const x of com(g1)) for (const y of com(g2)) if ((x !== g1 || y !== g2) && Parser.razaoOk(x, y)) reparos.add(x + '|' + y);
            if (reparos.size === 1) { const [x, y] = [...reparos][0].split('|'); out.g1 = x; out.g2 = y; conf.g1 = conf.g2 = 0.5; out.reparado = true; }
            else if (a1[0] && !a2[0]) { // só o de 1 ano foi lido: o de 2 anos fica ~1,6x (aproximado, em vermelho para conferir)
              out.g1 = a1[0]; conf.g1 = o1[0].n >= 2 ? LIM : Math.min(o1[0].max, 0.7); out.g2 = dinheiro(num(a1[0]) * 1.6); conf.g2 = 0.3; out.calculado = true;
            } else if (a2[0] && !a1[0]) {
              out.g2 = a2[0]; conf.g2 = o2[0].n >= 2 ? LIM : Math.min(o2[0].max, 0.7); out.g1 = dinheiro(num(a2[0]) / 1.6); conf.g1 = 0.3; out.calculado = true;
            } else { out.g1 = a1[0] || ''; out.g2 = a2[0] || ''; conf.g1 = conf.g2 = 0; }
          }
        }
        out.duvida = !out.nome || [...campos].some(f => !out[f] || conf[f] < LIM) || conf.nce < LIM;
        itens.push(out);
      }
      itens.sort((a, b) => (b.duvida - a.duvida) || a.nce.localeCompare(b.nce)); // o que precisa de conferência vem primeiro
      res[tipo] = itens;
    }
    return { produtos: res.produtos, seguros: res.seguro, info };
  }

  const api = { extrairImagens, juntar, LIM };
  if (typeof module !== 'undefined') module.exports = api; else root.PdfImport = api;
})(typeof self !== 'undefined' ? self : this);
