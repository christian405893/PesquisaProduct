// Converte o texto lido pelo OCR (linhas) em registros. Entende as duas folhas que a loja imprime:
//  - "produtos": Grupo | N.C.E. | Cor | Nome da Cor | Descrição | Saldo | Cubagem | Pco Venda
//      -> { nce, nome, cor, qtd (= Saldo), preco }
//  - "seguro":   Alm | Grupo | N.C.E. | Descrição | SubGru | Cod.AON | SEGURO 1ANO | SEGURO 2ANOS
//      -> { nce, nome, g1 (= seguro 1 ano), g2 (= seguro 2 anos) }
(function (root) {
  const RAZAO = [1.55, 1.66]; // seguro 2 anos / seguro 1 ano é sempre ~1,60 nas folhas da loja
  const CUB = /(?<![\d.,])0[.,]\d{4,6}(?!\d)/;                        // cubagem (0.09208)
  const DIN = /(\d{1,3}(?:\.\d{3})+,\d{2}|\d+[.,]\d{2})\d{0,2}(?!\d)/g; // 173.00 | 1.279,00 (tolera lixo no fim)
  const norm = s => String(s ?? '').replace(/\s+/g, ' ').trim();
  const norm2 = s => String(s ?? '').replace(/[ \t]+/g, m => m.length > 1 ? '  ' : ' ').trim(); // mantém "2 espaços" = separador de colunas

  // igual a norm2, mas devolve também, para cada caractere do resultado, a posição dele no texto original
  // (é por essa posição que a confiança de cada caractere lido pelo OCR é associada ao campo certo)
  function norm2m(s) {
    s = String(s ?? ''); let t = '', map = [], i = 0;
    while (i < s.length) {
      if (/[ \t]/.test(s[i])) {
        let j = i; while (j < s.length && /[ \t]/.test(s[j])) j++;
        if (t.length) { t += j - i > 1 ? '  ' : ' '; map.push(i); if (j - i > 1) map.push(i + 1); }
        i = j;
      } else { t += s[i]; map.push(i); i++; }
    }
    while (t.endsWith(' ')) { t = t.slice(0, -1); map.pop(); }
    return { t, map };
  }
  function prep(linha, confs) {
    if (!confs) return { l: norm2(linha), cf: null };
    const r = norm2m(linha);
    return { l: r.t, cf: r.map.map(i => confs[i] ?? 1) };
  }
  const minConf = (cf, a, b) => cf ? Math.min(1, ...cf.slice(a, b)) : 1;
  const spanM = (base, m) => [base + m.i, base + m.i + m.n]; // intervalo (no texto normalizado) do valor em dinheiro

  const fixDigits = s => s.replace(/[Oo]/g, '0').replace(/[lIi|]/g, '1').replace(/S/g, '5').replace(/B/g, '8');
  // 135OW -> 1350W, 12OOW -> 1200W
  function limpaNome(s) {
    s = norm(s).replace(/[|_\[\]{}]+/g, ' ');
    let ant;
    do { ant = s; s = s.replace(/(\d)O(?=[\dOWVL]|\b)/g, '$10'); } while (s !== ant);
    s = s.replace(/(?<=[A-Z])0(?=[A-Z])/g, 'O'); // B0SCH -> BOSCH
    return norm(s);
  }

  function achaCodigo(linha) {
    let m = linha.match(/(?<![0-9A-Za-z.,])(\d{6})(?![0-9A-Za-z]|[.,]\d)/);
    if (m) return { code: m[1], fim: m.index + m[1].length, duvida: false };
    m = linha.match(/(?<![0-9A-Za-z.,])([0-9OolISB]{6})(?![0-9A-Za-z])/);
    if (m && (m[1].match(/\d/g) || []).length >= 4) return { code: fixDigits(m[1]), fim: m.index + m[1].length, duvida: true };
    return null;
  }

  // "173.00" -> "173,00"; "1.279,00" fica igual
  function dinheiro(t) {
    t = String(t);
    return /,\d{2}$/.test(t) ? t : t.replace(/\.(\d{2})$/, ',$1');
  }
  const valor = t => parseFloat(dinheiro(t).replace(/\./g, '').replace(',', '.'));
  function moedas(texto) {
    const out = [];
    for (const m of texto.matchAll(DIN)) if (valor(m[1]) >= 1) out.push({ t: dinheiro(m[1]), i: m.index, n: m[1].length, fim: m.index + m[0].length });
    return out;
  }
  const saldoTexto = t => { const v = valor(t); return isFinite(v) ? String(Math.round(v)) : ''; };

  // ---------- folha de produtos (estoque) ----------
  function parseProduto(linha, confs) {
    const { l, cf } = prep(linha, confs); linha = l;
    const c = achaCodigo(linha); if (!c) return null;
    const resto = linha.slice(c.fim);
    const cm = resto.match(CUB);
    let antes = resto, preco = '', saldo = '', saldoBruto = '', cortaEm = resto.length, spP = null, spS = null;
    if (cm) {
      antes = resto.slice(0, cm.index);
      const baseD = c.fim + cm.index + cm[0].length;
      const depois = moedas(resto.slice(cm.index + cm[0].length));
      if (depois.length) { preco = depois[0].t; spP = spanM(baseD, depois[0]); }
      const a = moedas(antes);
      if (a.length) { const u = a[a.length - 1]; saldo = saldoTexto(u.t); saldoBruto = u.t; cortaEm = u.i; spS = spanM(c.fim, u); }
    } else {
      const m = moedas(resto);
      if (m.length) { preco = m[m.length - 1].t; cortaEm = m[m.length - 1].i; spP = spanM(c.fim, m[m.length - 1]); }
      if (m.length >= 2) { const u = m[m.length - 2]; saldo = saldoTexto(u.t); saldoBruto = u.t; cortaEm = u.i; spS = spanM(c.fim, u); }
    }
    // nome = o que sobra entre o código e o saldo, sem o código da cor nem o nome da cor
    let partes = resto.slice(0, cortaEm).split(/\s{2,}/).map(s => s.trim()).filter(Boolean);
    while (partes.length && /^[\d\s]+$/.test(partes[0])) partes.shift();
    if (partes.length) partes[0] = partes[0].replace(/^[\d\s]+(?=[A-Za-z])/, '');
    let cor = '';
    if (partes.length >= 2 && /^[A-Z\/ ]{2,20}$/.test(partes[0])) cor = partes.shift();
    const nome = limpaNome(partes.join(' '));
    const conf = {
      nce: c.duvida ? 0 : minConf(cf, c.fim - 6, c.fim),
      qtd: spS ? minConf(cf, spS[0], spS[1]) : 0,
      preco: spP ? minConf(cf, spP[0], spP[1]) : 0
    };
    return { tipo: 'produtos', nce: c.code, nome, cor, qtd: saldo, qtdBruto: saldoBruto, preco, conf, duvida: c.duvida || !nome || !saldo || !preco, raw: linha };
  }

  // ---------- foto só da parte ESQUERDA da tabela: NCE | Cor | Nome da Cor | Descrição ----------
  function parseEsq(linha, confs) {
    const r = parseProduto(linha, confs); if (!r) return null;
    return { tipo: 'esq', nce: r.nce, nome: r.nome, cor: r.cor, conf: { nce: r.conf.nce }, duvida: r.duvida || !r.nome, raw: r.raw };
  }

  // ---------- foto só da parte DIREITA: Descrição | Saldo | Cubagem | Pco Venda (sem NCE) ----------
  function parseDir(linha, confs) {
    const { l, cf } = prep(linha, confs); linha = l;
    const cm = linha.match(CUB); if (!cm) return null;
    const antes = linha.slice(0, cm.index), baseD = cm.index + cm[0].length;
    const depois = moedas(linha.slice(baseD)), a = moedas(antes);
    let preco = '', saldo = '', saldoBruto = '', spP = null, spS = null, corta = antes.length;
    if (depois.length) { preco = depois[0].t; spP = spanM(baseD, depois[0]); }
    if (a.length) { const u = a[a.length - 1]; saldo = saldoTexto(u.t); saldoBruto = u.t; spS = spanM(0, u); corta = u.i; }
    const nome = limpaNome(antes.slice(0, corta));
    const conf = { qtd: spS ? minConf(cf, spS[0], spS[1]) : 0, preco: spP ? minConf(cf, spP[0], spP[1]) : 0 };
    return { tipo: 'dir', nce: '', nome, qtd: saldo, qtdBruto: saldoBruto, preco, conf, duvida: !nome || !saldo || !preco, raw: linha };
  }

  // ---------- junta a foto da esquerda com a da direita ----------
  // As duas fotos têm a coluna "Descrição" em comum. Cada linha da esquerda é ligada à linha da direita
  // com descrição parecida, respeitando a ordem de cima para baixo. Ligação duvidosa = foto recusada.
  const canon = s => String(s || '').toUpperCase().replace(/[OQD]/g, '0').replace(/[IL|!]/g, '1').replace(/S/g, '5').replace(/B/g, '8').replace(/Z/g, '2').replace(/[^A-Z0-9]/g, '');
  function distSub(s, t) { // menor nº de erros para achar s dentro de t (começo e fim livres)
    const m = s.length, n = t.length; let prev = new Array(n + 1).fill(0);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
      prev = cur;
    }
    return Math.min(...prev);
  }
  function similaridade(a, b) {
    const A = canon(a), B = canon(b), [s, t] = A.length <= B.length ? [A, B] : [B, A];
    if (s.length < 6) return 0;
    return Math.max(0, 1 - distSub(s, t) / s.length);
  }
  const SIM_MIN = 0.6, SIM_BOA = 0.8;
  function juntarPartes(esq, dir) {
    const n = esq.length, m = dir.length, S = [];
    for (let i = 0; i < n; i++) { S.push([]); for (let j = 0; j < m; j++) S[i].push(similaridade(esq[i].nome, dir[j].nome)); }
    const W = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
      const sim = S[i - 1][j - 1];
      W[i][j] = Math.max(W[i - 1][j], W[i][j - 1], sim >= SIM_MIN ? W[i - 1][j - 1] + sim : -1);
    }
    const par = new Array(n).fill(-1), usadaD = new Array(m).fill(false);
    for (let i = n, j = m; i > 0 && j > 0;) {
      const sim = S[i - 1][j - 1];
      if (sim >= SIM_MIN && Math.abs(W[i][j] - (W[i - 1][j - 1] + sim)) < 1e-9) { par[i - 1] = j - 1; usadaD[j - 1] = true; i--; j--; }
      else if (W[i][j] === W[i - 1][j]) i--; else j--;
    }
    // linhas sem descrição legível (cortada na borda da foto): se entre duas ligações seguras sobraram
    // exatamente as mesmas quantidades dos dois lados, a ordem de cima para baixo decide
    const ancoras = [[-1, -1]];
    par.forEach((j, i) => { if (j >= 0) ancoras.push([i, j]); });
    ancoras.push([n, m]);
    const posicional = new Array(n).fill(false);
    for (let k = 1; k < ancoras.length; k++) {
      const [i0, j0] = ancoras[k - 1], [i1, j1] = ancoras[k], li = [], lj = [];
      for (let i = i0 + 1; i < i1; i++) if (par[i] < 0) li.push(i);
      for (let j = j0 + 1; j < j1; j++) if (!usadaD[j]) lj.push(j);
      if (li.length && li.length === lj.length && li.every((i, q) => canon(dir[lj[q]].nome).length < 6 || S[i][lj[q]] >= 0.45))
        li.forEach((i, q) => { par[i] = lj[q]; usadaD[lj[q]] = true; posicional[i] = true; });
    }
    const out = [];
    esq.forEach((e, i) => {
      const d = par[i] >= 0 ? dir[par[i]] : null;
      const nome = d && d.nome.length > e.nome.length ? d.nome : e.nome; // o mais completo
      out.push({
        tipo: 'produtos', nce: e.nce, nome, cor: e.cor || '', qtd: d ? d.qtd : '', qtdBruto: d ? d.qtdBruto : '', preco: d ? d.preco : '',
        conf: { nce: e.conf.nce, qtd: d ? d.conf.qtd : 0, preco: d ? d.conf.preco : 0 },
        sim: d ? (posicional[i] ? SIM_BOA : S[i][par[i]]) : 0, posicional: posicional[i], semPar: d ? '' : 'dir', duvida: !d || posicional[i] || S[i][par[i]] < SIM_BOA, raw: e.raw + ' || ' + (d ? d.raw : '')
      });
    });
    dir.forEach((d, j) => {
      if (usadaD[j]) return;
      out.push({ tipo: 'produtos', nce: '', nome: d.nome, cor: '', qtd: d.qtd, qtdBruto: d.qtdBruto, preco: d.preco, conf: { nce: 0, qtd: d.conf.qtd, preco: d.conf.preco }, sim: 0, semPar: 'esq', duvida: true, raw: d.raw });
    });
    return out;
  }

  // ---------- folha de seguro (garantia) ----------
  function parseSeguro(linha, confs) {
    const { l, cf } = prep(linha, confs); linha = l;
    const c = achaCodigo(linha); if (!c) return null;
    const resto = linha.slice(c.fim), m = moedas(resto);
    let g1 = '', g2 = '', duvida = c.duvida, s1 = null, s2 = null;
    if (m.length >= 2) { g1 = m[m.length - 2].t; g2 = m[m.length - 1].t; s1 = spanM(c.fim, m[m.length - 2]); s2 = spanM(c.fim, m[m.length - 1]); }
    else if (m.length === 1) { g1 = m[0].t; s1 = spanM(c.fim, m[0]); duvida = true; }
    else duvida = true;
    // o seguro de 2 anos custa ~1,6x o de 1 ano; se fugir muito disso, o OCR provavelmente errou um dígito
    if (g1 && g2) { const r = valor(g2) / valor(g1); if (!(r > RAZAO[0] && r < RAZAO[1])) duvida = true; }
    // nome (a folha de produtos tem o nome completo; aqui ele vem cortado)
    let nomeTxt = m.length >= 2 ? resto.slice(0, m[m.length - 2].i) : resto;
    nomeTxt = nomeTxt.replace(/(\s+\d{1,4}){1,3}\s*$/, '');
    const partes = nomeTxt.split(/\s{2,}/).map(s => s.trim()).filter(Boolean);
    while (partes.length > 1 && partes[0].length <= 2) partes.shift();
    const nome = limpaNome(partes.join(' '));
    const conf = {
      nce: c.duvida ? 0 : minConf(cf, c.fim - 6, c.fim),
      g1: s1 ? minConf(cf, s1[0], s1[1]) : 0,
      g2: s2 ? minConf(cf, s2[0], s2[1]) : 0
    };
    return { tipo: 'seguro', nce: c.code, nome, g1, g2, conf, duvida: duvida || !nome, raw: linha };
  }

  // ---------- qual das duas folhas é? ----------
  function detectarTipo(linhas) {
    let prod = 0, seg = 0, cheia = 0, esq = 0, dir = 0;
    for (const l of linhas) {
      const temCod = /(?<![\d.,])\d{6}(?![\d.,])/.test(l), temCub = CUB.test(l);
      if (temCod && temCub) cheia++;
      else if (temCub) dir++;
      else if (temCod && !/\d+[.,]\d{2}\s+\d+[.,]\d{2}\s*$/.test(l) && (l.match(/[A-Za-z]/g) || []).length >= 8) esq++;
      if (/saldo|cubagem|pco\s*venda|mercadorias|nome\s*da\s*cor/i.test(l)) prod += 3;
      if (/seguro|\baon\b|subgru/i.test(l)) seg += 3;
      if (CUB.test(l)) prod++;
      else if (/\d+[.,]\d{2}\s+\d+[.,]\d{2}\s*$/.test(l) && /(?<![\d.,])\d{6}(?![\d.,])/.test(l)) seg++;
    }
    if (seg > prod) return 'seguro';
    // foto de só um lado da tabela: parte da direita (sem NCE) ou da esquerda (sem saldo/preço)
    if (dir >= 3 && dir > 2 * cheia) return 'dir';
    if (esq >= 3 && esq > 2 * cheia && dir * 3 < esq) return 'esq';
    return 'produtos';
  }

  const CABECALHO = /c[oó]d|produto|descri|\bqtd|quant|pre[cç]o|valor|folha|p[aá]gina|saldo|cubagem|seguro|grupo|almox|situa|relac|\bpag\b|\bcor\b|loja/i;

  function parsePagina(linhas, tipo, meta) {
    tipo = tipo || detectarTipo(linhas);
    const parse = tipo === 'seguro' ? parseSeguro : tipo === 'esq' ? parseEsq : tipo === 'dir' ? parseDir : parseProduto, out = [];
    out.sobras = []; // linhas com número/código que não consegui encaixar em nenhum produto
    for (let li = 0; li < linhas.length; li++) {
      const l = linhas[li];
      const r = parse(l, meta && meta[li] && meta[li].confs);
      if (r) { r.li = li; out.push(r); continue; }
      const t = norm(l), prev = out[out.length - 1], antesN = out.length, nomeAntes = prev && prev.nome;
      if (tipo === 'produtos') {
        // linha sem código mas com cubagem/preço: completa a anterior (se faltar) ou vira linha para corrigir à mão
        if (CUB.test(t)) {
          const cm = t.match(CUB), m = moedas(t.slice(cm.index + cm[0].length)), a = moedas(t.slice(0, cm.index));
          const preco = m.length ? m[0].t : '', saldo = a.length ? saldoTexto(a[a.length - 1].t) : '';
          if (prev && !prev.preco && preco) {
            prev.preco = preco; if (!prev.qtd) prev.qtd = saldo;
            prev.conf = { ...prev.conf, preco: 0, qtd: 0 }; prev.partida = true; // linha lida partida em duas: não é confiável
            const resto = limpaNome(t.slice(0, a.length ? a[a.length - 1].i : cm.index));
            if (resto && !prev.nome.includes(resto)) prev.nome = norm(prev.nome + ' ' + resto);
            prev.duvida = !prev.nome || !prev.qtd || !prev.preco;
          } else out.push({ li, conf: {}, tipo, nce: '', nome: limpaNome(t.slice(0, a.length ? a[a.length - 1].i : cm.index)), cor: '', qtd: saldo, preco, duvida: true, raw: t });
          continue;
        }
      } else if (tipo === 'seguro') {
        const m = moedas(t);
        if (m.length >= 2 && /[A-Za-z]{3,}/.test(t) && !CABECALHO.test(t)) {
          out.push({ li, conf: {}, tipo, nce: '', nome: limpaNome(t.slice(0, m[m.length - 2].i).replace(/(\s+\d{1,4}){1,3}\s*$/, '')), g1: m[m.length - 2].t, g2: m[m.length - 1].t, duvida: true, raw: t });
          continue;
        }
      }
      // continuação do nome do produto anterior
      if (prev && /[A-Za-zÀ-ú]{3,}/.test(t) && !/\d{4,}/.test(t) && t.length < 60 && !CABECALHO.test(t) && !/[=*]{3,}/.test(t)) {
        prev.nome = norm(prev.nome + ' ' + limpaNome(t));
        continue;
      }
      if (out.length && (moedas(t).length || /(?<![\d.,])\d{6}(?![\d.,])/.test(t)) && !CABECALHO.test(t) && out.length === antesN) out.sobras.push({ li, texto: t });
    }
    return out;
  }

  // ---------- a foto está boa o bastante para guardar sem erro? ----------
  // Devolve a lista de motivos para RECUSAR a foto (vazia = pode aceitar).
  const LIM = 0.8;        // confiança mínima de cada caractere nos campos que valem dinheiro (NCE, qtd, preço, seguros)
  const mediana = a => { const b = [...a].sort((x, y) => x - y); return b.length ? b[b.length >> 1] : 0; };
  function problemasDaPagina(itens, tipo, meta) {
    const P = [], rot = { nce: 'NCE', qtd: 'quantidade', preco: 'preço', g1: 'seguro 1 ano', g2: 'seguro 2 anos' };
    const campos = tipo === 'seguro' ? ['nce', 'g1', 'g2'] : tipo === 'esq' ? ['nce'] : tipo === 'dir' ? ['qtd', 'preco'] : ['nce', 'qtd', 'preco'];
    if (!itens.length) return ['Não achei nenhuma linha de produto nesta foto.'];
    const vistos = new Map(), ruins = new Set();
    for (const it of itens) {
      const antes = P.length;
      const id = it.nce ? 'NCE ' + it.nce : 'linha "' + (it.nome || it.raw || '?').slice(0, 28) + '"';
      if (it.semPar) { P.push(id + (it.semPar === 'dir' ? ': não achei a linha dele na foto da direita.' : ': linha da foto da direita sem par na foto da esquerda.')); ruins.add(it); continue; }
      if (it.sim !== undefined && it.sim < SIM_BOA) P.push(id + ': ligação entre as duas fotos duvidosa (a descrição não bate direito).');
      if (tipo !== 'dir' && !/^\d{6}$/.test(it.nce || '')) { P.push(id + ': NCE não lido por completo.'); ruins.add(it); continue; }
      if (it.partida) P.push(id + ': a linha saiu partida em duas (foto torta ou tremida).');
      for (const f of campos) {
        const v = String(it[f] ?? '').trim();
        if (!v) { P.push(id + ': ' + rot[f] + ' não foi lido.'); continue; }
        if ((it.conf && it.conf[f] !== undefined ? it.conf[f] : 0) < LIM) P.push(id + ': ' + rot[f] + ' com caractere duvidoso (' + v + ').');
      }
      if ((tipo === 'produtos' || tipo === 'dir') && it.qtdBruto && !/,00$/.test(it.qtdBruto)) P.push(id + ': quantidade ' + it.qtdBruto + ' não é número inteiro.');
      if (tipo === 'seguro' && it.g1 && it.g2) {
        const r = valor(it.g2) / valor(it.g1);
        if (!(r > RAZAO[0] && r < RAZAO[1])) P.push(id + ': seguro 2 anos (' + it.g2 + ') não bate com o de 1 ano (' + it.g1 + ').');
      }
      if (it.nce) { if (vistos.has(it.nce)) P.push(id + ': aparece duas vezes na mesma foto.'); else vistos.set(it.nce, 1); }
      if (P.length > antes) ruins.add(it);
    }
    for (const sb of itens.sobras || []) P.push('Linha com número que não consegui ligar a um produto: "' + sb.texto.slice(0, 40) + '".');
    // falta de linha: espaço vertical muito maior que o normal entre dois produtos seguidos
    if (meta) {
      const com = itens.filter(i => i.li !== undefined && meta[i.li] && (i.nce || tipo === 'dir'));
      const d = [];
      for (let k = 1; k < com.length; k++) d.push(meta[com[k].li].cy - meta[com[k - 1].li].cy);
      const med = mediana(d);
      if (med > 0) for (let k = 1; k < com.length; k++) {
        const g = meta[com[k].li].cy - meta[com[k - 1].li].cy;
        if (g > med * 1.8 && com[k].li - com[k - 1].li === 1) P.push('Parece faltar uma linha entre NCE ' + com[k - 1].nce + ' e NCE ' + com[k].nce + '.');
      }
    }
    P.total = itens.length; P.ruins = ruins.size; // linhas lidas / linhas com algum problema
    return P;
  }

  const api = { parseProduto, parseSeguro, parseEsq, parseDir, juntarPartes, similaridade, parsePagina, problemasDaPagina, detectarTipo, LIM, parseLines: ls => parsePagina(ls) };
  if (typeof module !== 'undefined') module.exports = api; else root.Parser = api;
})(typeof self !== 'undefined' ? self : this);
