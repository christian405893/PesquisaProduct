'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- Banco local (IndexedDB) ---------- */
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('pesquisa-nce', 1);
    r.onupgradeneeded = () => {
      const s = r.result.createObjectStore('itens', { keyPath: 'id', autoIncrement: true });
      s.createIndex('nce', 'nce');
      s.createIndex('folha', 'folha');
    };
    r.onsuccess = () => { db = r.result; res(); };
    r.onerror = () => rej(r.error);
  });
}
const tx = (mode = 'readonly') => db.transaction('itens', mode).objectStore('itens');
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const todos = () => req(tx().getAll());

// Mescla pelo NCE: a folha de produtos traz nome/estoque/preço; a folha de garantia (seguro) traz g1/g2.
// Cada uma só mexe nos seus campos; o que o vendedor anotou (quebrados) é mantido.
async function salvarItens(itens) {
  const all = await todos();
  const folha = all.reduce((m, i) => Math.max(m, i.folha || 0), 0);
  const porNce = {};
  all.forEach(i => { porNce[i.nce] = i; });
  const t = db.transaction('itens', 'readwrite'), s = t.objectStore('itens');
  const mantidos = new Set(Object.values(porNce));
  all.filter(i => !mantidos.has(i)).forEach(i => s.delete(i.id)); // repetidos antigos do mesmo NCE
  const tocados = new Set();
  itens.forEach(it => {
    const r = porNce[it.nce] || { nce: it.nce, nome: '', qtd: '', preco: '', g1: '', g2: '', defeito: 0, folha: 0 };
    if (it.tipo === 'seguro') {
      if (it.g1) r.g1 = it.g1; // não apaga um seguro que já existia se este veio em branco
      if (it.g2) r.g2 = it.g2;
      if (!r.nome) r.nome = it.nome;
    } else {
      r.nome = it.nome || r.nome; r.qtd = it.qtd; r.preco = it.preco; r.cor = it.cor || r.cor || '';
      r.folha = folha + it.pagina; r.raw = it.raw;
    }
    porNce[it.nce] = r; tocados.add(r);
  });
  tocados.forEach(r => (r.id === undefined ? s.add(r) : s.put(r)));
  await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
}

/* ---------- Navegação ---------- */
document.querySelectorAll('nav button').forEach(b => b.onclick = () => {
  document.querySelectorAll('nav button').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
  if (b.dataset.tab === 'tabela') renderTabela();
  if (b.dataset.tab === 'busca') { buscar(); $('#q').focus(); }
});
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2800);
}

/* ---------- Busca ---------- */
const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const numInt = v => { const n = parseInt(v, 10); return isNaN(n) ? null : n; };
const disponivel = i => { const q = numInt(i.qtd); return q === null ? null : Math.max(0, q - (i.defeito || 0)); };
function cardHTML(i) {
  const disp = disponivel(i);
  return `<div class="card click" data-id="${i.id}"><div class="nce">NCE: ${esc(i.nce)}</div>
    <div class="nome">${esc(i.nome) || '<i>(sem descrição)</i>'}</div>
    <div class="meta"><div>Estoque<b>${esc(i.qtd) || '—'}</b></div>
      <div>Quebrados<b class="${i.defeito ? 'bad' : ''}">${i.defeito || 0}</b></div>
      <div>Disponível<b class="${disp === 0 ? 'bad' : 'ok'}">${disp ?? '—'}</b></div>
      <div>Preço<b>${i.preco ? 'R$ ' + esc(i.preco) : '—'}</b></div></div>
    ${i.g1 || i.g2 ? `<div class="gar">Seguro: 1 ano <b>${i.g1 ? 'R$ ' + esc(i.g1) : '—'}</b> · 2 anos <b>${i.g2 ? 'R$ ' + esc(i.g2) : '—'}</b></div>` : ''}
    <div class="src">${i.folha ? 'Folha ' + esc(i.folha) : i.manual ? 'Cadastro manual' : 'Só seguro'} · toque para ver e simular ›</div></div>`;
}
$('#resultados').addEventListener('click', e => {
  const c = e.target.closest('.card[data-id]');
  if (c) abrirProduto(+c.dataset.id);
});
async function buscar() {
  const raw = $('#q').value.trim();
  const itens = await todos();
  $('#total').textContent = itens.length ? itens.length + ' produtos' : '';
  const box = $('#resultados');
  if (!itens.length) { box.innerHTML = '<div class="empty">Nenhum produto ainda.<br>Vá em <b>Escanear</b> e fotografe as folhas.</div>'; return; }
  if (!raw) { box.innerHTML = '<div class="empty">Digite o código NCE ou o nome do produto.</div>'; return; }

  let res;
  const digits = raw.replace(/^nce\W*/i, '').replace(/\s/g, '');
  if (/^\d+$/.test(digits)) {
    res = itens.filter(i => i.nce.includes(digits));
    res.sort((a, b) => (b.nce === digits) - (a.nce === digits) || a.nce.localeCompare(b.nce));
  } else {
    const words = norm(raw).split(/\s+/).filter(Boolean);
    res = itens.filter(i => { const n = norm(i.nome); return words.every(w => n.includes(w)); });
  }
  box.innerHTML = res.length ? res.slice(0, 60).map(cardHTML).join('') : '<div class="empty">Nada encontrado.</div>';
  return { res, digits };
}
// digitou os 6 números de um NCE e só existe esse produto: abre direto a tela dele
$('#q').addEventListener('input', async () => {
  const r = await buscar();
  if (r && r.digits.length === 6 && r.res.length === 1 && r.res[0].nce === r.digits) abrirProduto(r.res[0].id);
});

/* ---------- Escanear (OCR offline - PaddleOCR) ---------- */
let lote = []; // lote: [{pagina, itens:[...]}]
let pendentes = { esq: [], dir: [] }; // partes da tabela já lidas, esperando a outra metade
let recusadas = []; // fotos recusadas por ter caractere duvidoso: [{pagina, tipo, itens, problemas}]

// O OCR roda num Web Worker (ocr-worker.js) para não travar a tela do celular.
let worker = null, seq = 0;
const pend = new Map(); // id -> { res, rej, onProg }

function falharPendentes(err) {
  pend.forEach(p => p.rej(err));
  pend.clear();
}
function getWorker() {
  if (worker) return worker;
  worker = new Worker('ocr-worker.js');
  worker.onmessage = e => {
    const { id, tipo } = e.data, p = pend.get(id);
    if (!p) return;
    if (tipo === 'prog') return p.onProg && p.onProg(e.data.f, e.data.txt);
    pend.delete(id);
    if (tipo === 'ok') p.res({ linhas: e.data.linhas, meta: e.data.meta, info: e.data.info });
    else { const er = new Error(e.data.msg); er.prep = !!e.data.prep; p.rej(er); }
  };
  worker.onerror = ev => {
    const w = worker; worker = null; w.terminate(); // próximo uso recria o leitor
    falharPendentes(new Error(ev.message || 'falha no leitor de OCR'));
  };
  return worker;
}
// Entrada: { file } (o worker decodifica a foto) ou { data, width, height } (já decodificada)
function lerNoWorker(img, onProg) {
  return new Promise((res, rej) => {
    const id = ++seq;
    pend.set(id, { res, rej, onProg });
    if (img.file) getWorker().postMessage({ id, file: img.file });
    else getWorker().postMessage({ id, buffer: img.data.buffer, width: img.width, height: img.height }, [img.data.buffer]); // transfere sem copiar
  });
}
function cancelarLeitura() {
  if (worker) { worker.terminate(); worker = null; }
  falharPendentes(new Error('cancelado'));
}
// miniatura pequena da foto (decodifica já reduzida: barato mesmo em foto de 50 MP)
async function miniatura(file) {
  try {
    const b = await createImageBitmap(file, { imageOrientation: 'from-image', resizeWidth: 64, resizeQuality: 'low' });
    const t = document.createElement('canvas'); t.width = 64; t.height = Math.max(1, Math.round(64 * b.height / b.width));
    t.getContext('2d').drawImage(b, 0, 0, t.width, t.height); b.close();
    return t.toDataURL('image/jpeg', .6);
  } catch { return ''; }
}

async function prepararImagem(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const MAX = 2800, k = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(bmp, 0, 0, c.width, c.height);
  const d = g.getImageData(0, 0, c.width, c.height);
  const t = document.createElement('canvas'); t.width = 64; t.height = 84;
  t.getContext('2d').drawImage(c, 0, 0, 64, 84);
  return { img: { data: d.data, width: c.width, height: c.height }, thumb: t.toDataURL('image/jpeg', .6) };
}

let progTxt = '', progT0 = 0, progTimer = null;
function mostraTxt() { $('#ptxt').textContent = progTxt + ' · ' + Math.round((Date.now() - progT0) / 1000) + 's'; }
function setProg(f, txt) {
  $('#progresso').hidden = false; $('#cancelar').hidden = false;
  $('#barra').style.width = Math.max(2, Math.round(f * 100)) + '%';
  if (txt) progTxt = txt;
  if (!progTimer) { progT0 = Date.now(); progTimer = setInterval(mostraTxt, 1000); }
  mostraTxt();
}
function fimProg() { $('#progresso').hidden = true; $('#cancelar').hidden = true; clearInterval(progTimer); progTimer = null; }
$('#cancelar').onclick = cancelarLeitura;

let ocupado = false;
async function processar(files) {
  files = [...files].filter(f => f.type.startsWith('image/'));
  if (!files.length) return;
  if (ocupado) return toast('Aguarde: ainda lendo as fotos anteriores');
  ocupado = true;
  try {
    for (let n = 0; n < files.length; n++) {
      const rot = `Lendo foto ${n + 1} de ${files.length}…`;
      setProg(0.01, rot + ' (no celular leva alguns minutos)');
      const thumb = await miniatura(files[n]);
      if (thumb) $('#fila').insertAdjacentHTML('beforeend', `<img class="thumb" src="${thumb}">`);
      const onp = (f, txt) => setProg(f, txt || rot);
      let lido;
      if (typeof OffscreenCanvas !== 'undefined') {
        try { lido = await lerNoWorker({ file: files[n] }, onp); }
        catch (e) { if (!e.prep) throw e; } // o worker não conseguiu decodificar: tenta pelo jeito antigo
      }
      if (!lido) { const { img } = await prepararImagem(files[n]); lido = await lerNoWorker(img, onp); }
      const { linhas, meta } = lido;
      const tipo = Parser.detectarTipo(linhas), itens = Parser.parsePagina(linhas, tipo, meta);
      const problemas = Parser.problemasDaPagina(itens, tipo, meta);
      const pg = { pagina: lote.length + recusadas.length + 1, tipo, linhas, meta, itens, problemas };
      const r = registrarPagina(pg, `Foto ${n + 1}`);
      if (r === 'recusada') { const fila = $('#fila'); if (fila.lastElementChild) fila.lastElementChild.remove(); }
    }
    fimProg();
    renderPartes(); renderRecusa(); renderRevisao();
  } catch (e) {
    console.error(e); toast(e.message === 'cancelado' ? 'Leitura cancelada' : 'Erro ao ler a imagem: ' + (e.message || e));
    fimProg();
  } finally { ocupado = false; }
}
// Qualquer dúvida: a página é recusada e o vendedor tira outra foto (ou copia o texto de novo)
function registrarPagina(pg, nome) {
  const { tipo, itens, problemas } = pg;
  if (problemas.length) { recusadas.push(pg); toast(`${nome} recusado: veja o aviso`); return 'recusada'; }
  if (tipo === 'esq' || tipo === 'dir') {
    pendentes[tipo].push(pg);
    toast(`${nome}: parte ${tipo === 'esq' ? 'esquerda' : 'direita'} lida (${itens.length} linhas)`);
    tentarJuntar(); return 'parte';
  }
  lote.push(pg);
  toast(`${nome}: folha de ${tipo === 'seguro' ? 'seguro' : 'produtos'}, ${itens.length} linhas`);
  return 'ok';
}
// Texto copiado (Google Lens, outro app de OCR, IA) e colado no app
$('#lerColado').onclick = () => {
  const texto = $('#colado').value;
  if (!texto.trim()) return toast('Cole o texto primeiro');
  const r = Parser.parseTextoColado(texto);
  const problemas = Parser.problemasDaPagina(r.itens, r.tipo, null).concat(r.avisos);
  const pg = { pagina: lote.length + recusadas.length + 1, tipo: r.tipo, linhas: r.linhas, meta: null, itens: r.itens, problemas, colado: true };
  const res = registrarPagina(pg, 'Texto colado');
  if (res !== 'recusada') $('#colado').value = '';
  renderPartes(); renderRecusa(); renderRevisao();
};
$('#cam').onchange = e => { processar(e.target.files); e.target.value = ''; };
$('#gal').onchange = e => { processar(e.target.files); e.target.value = ''; };

// Junta a foto da esquerda com a da direita (na ordem em que foram lidas) assim que as duas existirem
function tentarJuntar() {
  while (pendentes.esq.length && pendentes.dir.length) {
    const e = pendentes.esq.shift(), d = pendentes.dir.shift();
    const itens = Parser.juntarPartes(e.itens, d.itens), problemas = Parser.problemasDaPagina(itens, 'produtos');
    const pg = { pagina: lote.length + recusadas.length + 1, tipo: 'produtos', partes: true, linhas: [], meta: null, itens, problemas };
    if (problemas.length) recusadas.push(pg); else lote.push(pg);
  }
}
function renderPartes() {
  const box = $('#partes'), e = pendentes.esq.length, d = pendentes.dir.length;
  if (!e && !d) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  const falta = e ? 'direita (da Descrição até o Preço)' : 'esquerda (do NCE até a Descrição)';
  box.innerHTML = `Parte ${e ? 'esquerda' : 'direita'} lida ✔ — agora tire a foto da parte <b>${falta}</b>. <button class="mini" data-descartar-partes>descartar</button>`;
}
$('#partes').addEventListener('click', e => {
  if (e.target.matches && e.target.matches('[data-descartar-partes]')) { pendentes = { esq: [], dir: [] }; renderPartes(); }
});

function renderRecusa() {
  const box = $('#recusa');
  if (!recusadas.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = '<h2>⚠️ Foto recusada — tire outra</h2>' + recusadas.map((pg, ri) => {
    const podeForcar = pg.tipo === 'produtos' || pg.tipo === 'seguro';
    const nomeFoto = pg.colado ? 'Texto colado' : pg.partes ? 'Fotos da esquerda + direita' : `Foto ${pg.pagina}${pg.tipo === 'esq' ? ' (parte esquerda)' : pg.tipo === 'dir' ? ' (parte direita)' : ''}`;
    const max = 5, mot = pg.problemas.slice(0, max).map(m => `<li>${esc(m)}</li>`).join('');
    const resumo = pg.problemas.total ? `${pg.problemas.total} linhas lidas, ${pg.problemas.ruins} com dúvida.` : `${pg.problemas.length} ${pg.problemas.length === 1 ? 'ponto' : 'pontos'} sem certeza.`;
    return `<div class="rec"><b>${nomeFoto}</b> · ${resumo}<ul>${mot}</ul>`
      + (pg.problemas.length > max ? `<p class="hint">… e mais ${pg.problemas.length - max}. (Dá para ver tudo em "Corrigir à mão".)</p>` : '')
      + (podeForcar ? `<button class="btn" data-forcar="${ri}">✏️ Corrigir à mão (revisar mesmo assim)</button>` : '') + '</div>';
  }).join('') + '<div class="row"><label class="btn primary" for="cam">📷 Tirar outra foto</label><label class="btn" for="gal">🖼️ Escolher fotos</label></div><p class="hint">Dicas: folha bem esticada e de frente, boa luz, sem sombra nem reflexo, foto nítida (sem tremer). Depois é só tirar outra foto da mesma folha.</p>';
}
$('#recusa').addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('[data-forcar]'); if (!b) return;
  const pg = recusadas.splice(Number(b.dataset.forcar), 1)[0];
  if (pg) lote.push(pg);
  renderRecusa(); renderRevisao();
});

const CAMPOS = {
  produtos: [['nce', 'numeric', 'NCE'], ['nome', 'text', 'produto'], ['qtd', 'numeric', 'qtd'], ['preco', 'decimal', 'R$']],
  seguro: [['nce', 'numeric', 'NCE'], ['nome', 'text', 'produto'], ['g1', 'decimal', '1 ano'], ['g2', 'decimal', '2 anos']]
};
function renderRevisao() {
  const box = $('#linhas');
  if (!lote.length) { $('#revisao').hidden = true; return; }
  $('#revisao').hidden = false;
  box.innerHTML = lote.map((pg, pi) => {
    const sel = t => (pg.tipo === t ? ' selected' : '');
    const cab = pg.colado ? `<div class="pg">Texto colado · ${pg.itens.length} linhas</div>` : pg.partes ? `<div class="pg">Fotos esquerda + direita, juntas · ${pg.itens.length} linhas</div>` : `<div class="pg">Foto ${pg.pagina} · <select data-tipo data-p="${pi}"><option value="produtos"${sel('produtos')}>Folha de produtos</option><option value="seguro"${sel('seguro')}>Folha de seguro</option></select> · ${pg.itens.length} linhas</div>`
      + (pg.tipo === 'seguro' ? '<p class="hint">Seguro: só atualiza os valores de seguro de 1 ano e 2 anos dos produtos. Campos em vermelho ou laranja: confira.</p>' : '');
    const linhas = pg.itens.map((it, ii) => `<div class="ln${pg.tipo === 'seguro' ? ' seg' : ''}" data-p="${pi}" data-i="${ii}">` +
      CAMPOS[pg.tipo].map(([f, modo, ph]) => {
        let cls = '';
        if (it.conf && it.conf[f] !== undefined && it.conf[f] < Parser.LIM) cls = 'bad';
        else if (f === 'nce') cls = /^\d{6}$/.test(it.nce) ? (it.duvida ? 'warn' : '') : 'bad';
        else if (pg.tipo === 'seguro') cls = it.duvida && f !== 'nome' ? 'warn' : '';
        else cls = String(it[f] ?? '').trim() ? '' : 'warn';
        return `<input data-f="${f}" inputmode="${modo}" value="${esc(it[f])}" placeholder="${ph}" class="${cls}">`;
      }).join('') + '<button data-del title="Apagar">✕</button></div>').join('');
    return cab + linhas + (pg.itens.length ? '' : '<p class="hint">Nenhum código lido nesta foto. Tente de novo com mais luz e a folha reta.</p>');
  }).join('');
}
$('#linhas').addEventListener('input', e => {
  const ln = e.target.closest('.ln'); if (!ln) return;
  const it = lote[ln.dataset.p].itens[ln.dataset.i]; it[e.target.dataset.f] = e.target.value;
  if (it.conf) it.conf[e.target.dataset.f] = 1; // corrigido à mão
});
$('#linhas').addEventListener('change', e => {
  if (!e.target.matches('[data-tipo]')) return;
  const pg = lote[e.target.dataset.p];
  pg.tipo = e.target.value; pg.itens = Parser.parsePagina(pg.linhas, pg.tipo, pg.meta); // lê a mesma foto como o outro tipo de folha
  renderRevisao();
});
$('#linhas').addEventListener('click', e => {
  if (!e.target.matches('[data-del]')) return;
  const ln = e.target.closest('.ln');
  lote[ln.dataset.p].itens.splice(ln.dataset.i, 1);
  renderRevisao();
});
$('#salvar').onclick = async () => {
  const itens = [], t = v => String(v ?? '').trim();
  let folhaN = 0;
  lote.forEach(pg => {
    if (pg.tipo === 'produtos') folhaN++;
    pg.itens.forEach(it => {
      const nce = t(it.nce).replace(/\D/g, '');
      if (nce) itens.push({ tipo: pg.tipo, nce, nome: t(it.nome), cor: it.cor || '', qtd: t(it.qtd), preco: t(it.preco), g1: t(it.g1), g2: t(it.g2), pagina: folhaN, raw: it.raw });
    });
  });
  if (!itens.length) return toast('Nada para salvar');
  await salvarItens(itens);
  const ns = itens.filter(i => i.tipo === 'seguro').length, np = itens.length - ns;
  toast([np && `${np} produtos`, ns && `${ns} seguros`].filter(Boolean).join(' e ') + ' salvos');
  limparLote(); buscar();
};
$('#descartar').onclick = limparLote;
function limparLote() { lote = []; recusadas = []; pendentes = { esq: [], dir: [] }; renderPartes(); renderRecusa(); $('#fila').innerHTML = ''; $('#revisao').hidden = true; $('#linhas').innerHTML = ''; }

/* ---------- Tabela / backup ---------- */
async function renderTabela() {
  const itens = await todos();
  const por = {};
  itens.forEach(i => (por[i.folha] ||= []).push(i));
  const ks = Object.keys(por).sort((a, b) => b - a);
  $('#folhas').innerHTML = ks.length ? ks.map(k => `<details class="card"><summary class="folha">${k == 0 ? 'Sem folha de produtos (só seguro ou cadastro manual)' : 'Folha ' + k} · ${por[k].length} itens</summary>
    <button data-delf="${k}" style="border:0;background:none;color:var(--bad)">Apagar esta folha</button>
    <table><tr><th>NCE</th><th>Produto</th><th>Qtd</th><th>R$</th><th>G1</th><th>G2</th></tr>${por[k].map(i => `<tr><td>${esc(i.nce)}</td><td>${esc(i.nome)}</td><td>${esc(i.qtd)}</td><td>${esc(i.preco)}</td><td>${esc(i.g1)}</td><td>${esc(i.g2)}</td></tr>`).join('')}</table></details>`).join('')
    : '<div class="empty">Tabela vazia.</div>';
}
$('#folhas').addEventListener('click', async e => {
  const k = e.target.dataset.delf; if (!k || !confirm(`Apagar a folha ${k}?`)) return;
  const t = db.transaction('itens', 'readwrite'), s = t.objectStore('itens');
  (await todos()).filter(i => i.folha == k).forEach(i => s.delete(i.id));
  t.oncomplete = () => { renderTabela(); buscar(); };
});
function baixar(nome, texto, tipo) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([texto], { type: tipo })); a.download = nome; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
$('#csv').onclick = async () => {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const l = (await todos()).map(i => [i.nce, i.nome, i.qtd, i.defeito || 0, i.preco, i.g1, i.g2, i.folha].map(q).join(';'));
  baixar('produtos-nce.csv', '﻿NCE;Produto;Qtd;Quebrados;Preço;Seguro 1 ano;Seguro 2 anos;Folha\n' + l.join('\n'), 'text/csv');
};
$('#backup').onclick = async () => baixar('backup-nce.json', JSON.stringify(await todos()), 'application/json');
$('#restore').onchange = async e => {
  try {
    const arr = JSON.parse(await e.target.files[0].text());
    const t = db.transaction('itens', 'readwrite'), s = t.objectStore('itens');
    arr.forEach(({ id, ...r }) => s.add(r));
    t.oncomplete = () => { toast('Backup restaurado'); renderTabela(); buscar(); };
  } catch { toast('Arquivo inválido'); }
  e.target.value = '';
};

/* ---------- Produto: estoque, quebrados e simulação ---------- */
const Sim = Simulador;
let atual = null, sim = { tipo: 'crediario', gar: '' }, tSalvar;

function salvarAtual() { clearTimeout(tSalvar); tSalvar = setTimeout(salvarAgora, 400); }
async function salvarAgora() {
  clearTimeout(tSalvar);
  if (atual) await req(tx('readwrite').put(atual));
}

async function abrirProduto(id) {
  atual = (await todos()).find(i => i.id === id);
  if (!atual) return;
  sim = { tipo: 'crediario', gar: '' };
  $('#shNce').textContent = 'NCE: ' + atual.nce;
  $('#shNome').textContent = atual.nome || '(sem descrição)';
  $('#fPreco').value = atual.preco || '';
  $('#fG1').value = atual.g1 || '';
  $('#fG2').value = atual.g2 || '';
  $('#entrada').value = '';
  $('#simBox').hidden = true; $('#simBtn').hidden = false;
  renderEstoque();
  $('#estCard').hidden = !atual.qtd && !atual.defeito; // produto só da folha de seguro não tem estoque
  $('#sheet').hidden = false; $('#sheet').scrollTop = 0;
  document.body.style.overflow = 'hidden';
  history.pushState({ sheet: 1 }, ''); // o botão "voltar" do celular fecha a tela do produto
  if (document.activeElement) document.activeElement.blur();
  if (!atual.preco) setTimeout(() => $('#fPreco').focus(), 200); // sem preço na tabela: já cai no campo para digitar
}
async function fecharSheet() {
  if ($('#sheet').hidden) return;
  await salvarAgora();
  $('#sheet').hidden = true; document.body.style.overflow = ''; atual = null;
  buscar();
}
$('#sheetFechar').onclick = () => history.back();
addEventListener('popstate', () => {
  if (!$('#novo').hidden) { $('#novo').hidden = true; document.body.style.overflow = ''; }
  if (abrirDepois !== null) { const id = abrirDepois; abrirDepois = null; abrirProduto(id); return; }
  fecharSheet();
});

/* ---------- Adicionar produto manualmente ---------- */
let abrirDepois = null, avisouRazao = false, todosNovo = [];
const fmtDin = c => { const s = String(Math.round(c)).padStart(3, '0'); return s.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + s.slice(-2); };
const dinStr = v => { const c = Sim.cents(v); return c > 0 ? fmtDin(c) : ''; };
function novoMsg(t, erro) { const m = $('#nMsg'); m.textContent = t || ''; m.className = 'hint' + (erro ? ' erro' : ''); }
async function abrirNovo() {
  todosNovo = await todos(); avisouRazao = false;
  const q = $('#q').value.replace(/\D/g, '');
  ['#nNce', '#nCor', '#nNome', '#nPreco', '#nG1', '#nG2'].forEach(s => { $(s).value = ''; });
  if (q.length === 6) $('#nNce').value = q;
  novoMsg(''); $('#novoAviso').textContent = '';
  novoNceMudou();
  $('#novo').hidden = false; $('#novo').scrollTop = 0; document.body.style.overflow = 'hidden';
  history.pushState({ novo: 1 }, '');
  setTimeout(() => $(($('#nNce').value.length === 6 ? '#nNome' : '#nNce')).focus(), 200);
}
function novoNceMudou() {
  const nce = $('#nNce').value.replace(/\D/g, '');
  if ($('#nNce').value !== nce) $('#nNce').value = nce;
  const ex = nce.length === 6 && todosNovo.find(i => i.nce === nce);
  $('#novoAviso').textContent = ex ? 'Já existe: salvar atualiza este produto' : '';
  if (ex) { // traz o que já está guardado, sem apagar o que você já digitou
    if (!$('#nCor').value) $('#nCor').value = ex.cor || '';
    if (!$('#nNome').value) $('#nNome').value = ex.nome || '';
    if (!$('#nPreco').value) $('#nPreco').value = ex.preco || '';
    if (!$('#nG1').value) $('#nG1').value = ex.g1 || '';
    if (!$('#nG2').value) $('#nG2').value = ex.g2 || '';
  }
}
async function salvarNovo() {
  const nce = $('#nNce').value.replace(/\D/g, ''), nome = $('#nNome').value.trim().replace(/\s+/g, ' '), cor = $('#nCor').value.trim();
  if (!/^\d{6}$/.test(nce)) return novoMsg('O NCE precisa ter 6 números.', true);
  if (!nome) return novoMsg('Digite a descrição do produto.', true);
  const val = {};
  for (const [k, s, rot] of [['preco', '#nPreco', 'preço'], ['g1', '#nG1', 'seguro de 1 ano'], ['g2', '#nG2', 'seguro de 2 anos']]) {
    const bruto = $(s).value.trim();
    val[k] = dinStr(bruto);
    if (bruto && !val[k]) return novoMsg('Valor do ' + rot + ' inválido.', true);
  }
  if (val.g1 && val.g2 && !avisouRazao) {
    const r = Sim.cents(val.g2) / Sim.cents(val.g1);
    if (!(r > 1.55 && r < 1.66)) { avisouRazao = true; return novoMsg('Confira: o seguro de 2 anos costuma ser ~1,6× o de 1 ano. Se estiver certo, toque em Salvar de novo.', true); }
  }
  const all = await todos(); let r = all.find(i => i.nce === nce), id;
  if (r) { Object.assign(r, { nome, cor, preco: val.preco, g1: val.g1, g2: val.g2 }); await req(tx('readwrite').put(r)); id = r.id; }
  else { id = await req(tx('readwrite').add({ nce, nome, cor, qtd: '', preco: val.preco, g1: val.g1, g2: val.g2, defeito: 0, folha: 0, manual: true })); }
  toast('Produto ' + nce + ' salvo');
  abrirDepois = id; history.back(); // fecha o formulário e abre a tela do produto
}
$('#novoBtn').onclick = abrirNovo;
$('#novoFechar').onclick = () => history.back();
$('#nNce').addEventListener('input', novoNceMudou);
$('#nSalvar').onclick = salvarNovo;

function renderEstoque() {
  const d = disponivel(atual);
  $('#eQtd').textContent = atual.qtd || '—';
  $('#eDef').textContent = atual.defeito || 0;
  const el = $('#eDisp'); el.textContent = d ?? '—'; el.className = d === 0 ? 'bad' : 'ok';
}
function mudarDef(d) {
  const q = numInt(atual.qtd);
  let v = Math.max(0, (atual.defeito || 0) + d);
  if (q !== null) v = Math.min(q, v);
  atual.defeito = v; salvarAtual(); renderEstoque();
}
$('#defMenos').onclick = () => mudarDef(-1);
$('#defMais').onclick = () => mudarDef(1);

[['#fPreco', 'preco'], ['#fG1', 'g1'], ['#fG2', 'g2']].forEach(([sel, campo]) =>
  $(sel).addEventListener('input', e => {
    atual[campo] = e.target.value.trim(); salvarAtual(); renderGarantias(); renderSim();
  }));
$('#entrada').addEventListener('input', renderSim);

$('#simBtn').onclick = () => { $('#simBtn').hidden = true; $('#simBox').hidden = false; renderGarantias(); renderSim(); };
$('#simTipo').addEventListener('click', e => {
  const b = e.target.closest('[data-tipo]'); if (!b) return;
  sim.tipo = b.dataset.tipo;
  if (sim.tipo === 'cartao' && !sim.gar) sim.gar = 'nenhuma';          // no cartão a garantia é opcional
  if (sim.tipo === 'crediario' && sim.gar === 'nenhuma') sim.gar = ''; // no crediário é obrigatória
  renderGarantias(); renderSim();
});
$('#simGar').addEventListener('click', e => {
  const b = e.target.closest('[data-gar]'); if (!b) return;
  sim.gar = b.dataset.gar; renderGarantias(); renderSim();
});

function renderGarantias() {
  document.querySelectorAll('#simTipo [data-tipo]').forEach(b => b.classList.toggle('on', b.dataset.tipo === sim.tipo));
  const v = k => { const c = Sim.cents(atual[k]); return c ? ' · ' + Sim.brl(c) : ' · informe o valor'; };
  const op = [['g1', 'Seguro 1 ano' + v('g1')], ['g2', 'Seguro 2 anos' + v('g2')]];
  if (sim.tipo === 'cartao') op.unshift(['nenhuma', 'Sem seguro']);
  $('#simGar').innerHTML = op.map(([k, t]) => `<button class="btn chip${sim.gar === k ? ' on' : ''}" data-gar="${k}">${t}</button>`).join('') +
    // crediário sem seguro: botão discreto, só para quando o cliente desiste
    (sim.tipo === 'crediario' ? `<button class="mini${sim.gar === 'nenhuma' ? ' on' : ''}" data-gar="nenhuma">cliente não vai comprar</button>` : '');
}

function renderSim() {
  if ($('#simBox').hidden) return;
  const box = $('#simRes'), msg = t => { box.innerHTML = `<div class="empty">${t}</div>`; };
  const cred = sim.tipo === 'crediario';
  const preco = Sim.cents(atual.preco);
  if (!preco) return msg('Informe o preço à vista do produto.');
  if (!sim.gar) return msg('Escolha o seguro: no crediário ele é obrigatório.');
  let garantia = 0;
  if (sim.gar !== 'nenhuma') {
    garantia = Sim.cents(atual[sim.gar]);
    if (!garantia) return msg('Informe o valor desse seguro no campo acima.');
  }
  const entrada = Sim.cents($('#entrada').value);
  const r = (cred ? Sim.crediario : Sim.cartao)({ preco, garantia, entrada });
  if (r.financiado <= 0) return msg('A entrada cobre o valor total.');
  box.innerHTML =
    `<p class="hint">A parcelar: <b>${Sim.brl(r.financiado)}</b> (${Sim.brl(preco)}${garantia ? ' + seguro ' + Sim.brl(garantia) : ''}${entrada ? ' − entrada ' + Sim.brl(entrada) : ''})</p>` +
    r.lista.map(l => l.semTaxa ? `<div class="par"><span>${l.n}x</span><small class="tot">taxa ainda não cadastrada</small><span></span><span></span></div>` : `<div class="par"><span>${l.n}x de</span><b>${Sim.brl(l.parcela)}</b>
      <small class="tot">total ${Sim.brl(l.total)}</small>${l.semJuros ? '<small class="sj">(SEM JUROS)</small>' : '<span></span>'}</div>`).join('') +
    (cred && entrada > 0 ? '<p class="hint">Com entrada, o crediário vai até 11x.</p>' : '') +
    (!cred && r.faltaTaxa ? '<p class="hint">7x a 12x com juros: taxa ainda não cadastrada no app.</p>' : '');
}

/* ---------- Início ---------- */
openDB().then(buscar);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
