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

async function salvarItens(itens) {
  const all = await todos();
  const folha = all.reduce((m, i) => Math.max(m, i.folha || 0), 0);
  const t = db.transaction('itens', 'readwrite');
  const s = t.objectStore('itens');
  const nces = new Set(itens.map(i => i.nce));
  all.filter(i => nces.has(i.nce)).forEach(i => s.delete(i.id)); // nova leitura substitui a antiga do mesmo NCE
  itens.forEach(i => s.add({ ...i, folha: folha + i.pagina }));
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
function cardHTML(i) {
  return `<div class="card"><div class="nce">NCE: ${esc(i.nce)}</div>
    <div class="nome">${esc(i.nome) || '<i>(sem descrição)</i>'}</div>
    <div class="meta"><div>Qtd<b>${esc(i.qtd) || '—'}</b></div><div>Preço<b>${i.preco ? 'R$ ' + esc(i.preco) : '—'}</b></div></div>
    <div class="src">Folha ${esc(i.folha)}</div></div>`;
}
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
}
$('#q').addEventListener('input', buscar);

/* ---------- Escanear (OCR offline - PaddleOCR) ---------- */
let motor, lote = []; // lote: [{pagina, itens:[...]}]

async function getMotor() {
  if (motor) return motor;
  setProg(0.05, 'Carregando leitor offline (1ª vez demora um pouco)…');
  ort.env.wasm.wasmPaths = new URL('ocr/ort/', location.href).href;
  ort.env.wasm.numThreads = 1;
  const buf = async f => (await fetch('ocr/paddle/' + f)).arrayBuffer();
  const [det, rec, dict] = await Promise.all([buf('det.onnx'), buf('rec.onnx'), fetch('ocr/paddle/dict.txt').then(r => r.text())]);
  motor = await Paddle.criar(ort, new Uint8Array(det), new Uint8Array(rec), dict, { sessionOptions: { executionProviders: ['wasm'] } });
  return motor;
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

function setProg(f, txt) {
  $('#progresso').hidden = false;
  $('#barra').style.width = Math.round(f * 100) + '%';
  if (txt) $('#ptxt').textContent = txt;
}

let ocupado = false;
async function processar(files) {
  files = [...files].filter(f => f.type.startsWith('image/'));
  if (!files.length || ocupado) return;
  ocupado = true;
  try {
    const m = await getMotor();
    for (let n = 0; n < files.length; n++) {
      const rot = `Lendo foto ${n + 1} de ${files.length}…`;
      setProg(0, rot);
      const { img, thumb } = await prepararImagem(files[n]);
      $('#fila').insertAdjacentHTML('beforeend', `<img class="thumb" src="${thumb}">`);
      await new Promise(r => setTimeout(r, 30)); // deixa a tela atualizar
      const linhas = await m.ler(img, f => setProg(f, rot));
      const itens = Parser.parseLines(linhas);
      lote.push({ pagina: lote.length + 1, itens });
      toast(`Foto ${n + 1}: ${itens.length} produtos encontrados`);
    }
    $('#progresso').hidden = true;
    renderRevisao();
  } catch (e) {
    console.error(e); toast('Erro ao ler a imagem: ' + (e.message || e));
    $('#progresso').hidden = true;
  } finally { ocupado = false; }
}
$('#cam').onchange = e => { processar(e.target.files); e.target.value = ''; };
$('#gal').onchange = e => { processar(e.target.files); e.target.value = ''; };

function renderRevisao() {
  const box = $('#linhas');
  if (!lote.length) { $('#revisao').hidden = true; return; }
  $('#revisao').hidden = false;
  box.innerHTML = lote.map((pg, pi) => `<div class="pg">Foto ${pg.pagina} — ${pg.itens.length} produtos</div>` +
    pg.itens.map((it, ii) => `<div class="ln" data-p="${pi}" data-i="${ii}">
      <input data-f="nce" inputmode="numeric" value="${esc(it.nce)}" class="${/^\d{6}$/.test(it.nce) ? (it.duvida ? 'warn' : '') : 'bad'}">
      <input data-f="nome" value="${esc(it.nome)}" class="${it.duvida ? 'warn' : ''}">
      <input data-f="qtd" inputmode="numeric" value="${esc(it.qtd)}" placeholder="qtd">
      <input data-f="preco" inputmode="decimal" value="${esc(it.preco)}" placeholder="R$">
      <button data-del title="Apagar">✕</button></div>`).join('') +
    (pg.itens.length ? '' : '<p class="hint">Nenhum código lido nesta foto. Tente de novo com mais luz e a folha reta.</p>')).join('');
}
$('#linhas').addEventListener('input', e => {
  const ln = e.target.closest('.ln'); if (!ln) return;
  lote[ln.dataset.p].itens[ln.dataset.i][e.target.dataset.f] = e.target.value;
});
$('#linhas').addEventListener('click', e => {
  if (!e.target.matches('[data-del]')) return;
  const ln = e.target.closest('.ln');
  lote[ln.dataset.p].itens.splice(ln.dataset.i, 1);
  renderRevisao();
});
$('#salvar').onclick = async () => {
  const itens = [];
  lote.forEach(pg => pg.itens.forEach(it => {
    if (it.nce && String(it.nce).trim()) itens.push({ nce: String(it.nce).replace(/\D/g, ''), nome: it.nome.trim(), qtd: String(it.qtd).trim(), preco: String(it.preco).trim(), pagina: pg.pagina, raw: it.raw });
  }));
  if (!itens.length) return toast('Nada para salvar');
  await salvarItens(itens);
  toast(`${itens.length} produtos salvos`);
  limparLote(); buscar();
};
$('#descartar').onclick = limparLote;
function limparLote() { lote = []; $('#fila').innerHTML = ''; $('#revisao').hidden = true; $('#linhas').innerHTML = ''; }

/* ---------- Tabela / backup ---------- */
async function renderTabela() {
  const itens = await todos();
  const por = {};
  itens.forEach(i => (por[i.folha] ||= []).push(i));
  const ks = Object.keys(por).sort((a, b) => b - a);
  $('#folhas').innerHTML = ks.length ? ks.map(k => `<details class="card"><summary class="folha">Folha ${k} · ${por[k].length} itens</summary>
    <button data-delf="${k}" style="border:0;background:none;color:var(--bad)">Apagar esta folha</button>
    <table><tr><th>NCE</th><th>Produto</th><th>Qtd</th><th>R$</th></tr>${por[k].map(i => `<tr><td>${esc(i.nce)}</td><td>${esc(i.nome)}</td><td>${esc(i.qtd)}</td><td>${esc(i.preco)}</td></tr>`).join('')}</table></details>`).join('')
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
  const l = (await todos()).map(i => [i.nce, i.nome, i.qtd, i.preco, i.folha].map(q).join(';'));
  baixar('produtos-nce.csv', '﻿NCE;Produto;Qtd;Preço;Folha\n' + l.join('\n'), 'text/csv');
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

/* ---------- Início ---------- */
openDB().then(buscar);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
