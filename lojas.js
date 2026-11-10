'use strict';
// Tabelas compartilhadas das lojas (nome + senha) e sincronização com a nuvem. Usa as funções do app.js.
(function () {
  const LS = 'nce-nuvem';
  let cfg = {};
  try { cfg = JSON.parse(localStorage.getItem(LS)) || {}; } catch { /* sem armazenamento */ }
  cfg.tabelas = cfg.tabelas || []; cfg.usuario = cfg.usuario || ''; cfg.atual = cfg.atual || 'local';
  const gravar = () => { try { localStorage.setItem(LS, JSON.stringify(cfg)); } catch { /* ignora */ } };
  const tabAtual = () => cfg.tabelas.find(t => t.tid === cfg.atual) || null;
  const dataBR = t => { const d = new Date(t); return isNaN(d) ? '' : d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }); };

  let be = null, beKey = '';
  const fbCfg = () => { const c = cfg.fb || window.NUVEM_CONFIG || {}; return c.apiKey && c.projectId ? c : null; };
  function backend() {
    if (window.NUVEM_BACKEND) return window.NUVEM_BACKEND;
    const c = fbCfg(); if (!c) return null;
    const k = c.apiKey + '|' + c.projectId;
    if (k !== beKey) { be = Nuvem.Firestore(c); beKey = k; }
    return be;
  }

  /* ---------- faixa no topo e na busca ---------- */
  function pintar() {
    const t = tabAtual();
    $('#lojaBtn').textContent = t ? '🏬 ' + t.nome : '📍 Só neste aparelho';
    const i = $('#lojaInfo');
    if (!t) { i.hidden = true; return; }
    const m = t.meta || {};
    i.hidden = false;
    i.innerHTML = `<b>${esc(t.nome)}</b>` + (m.rotulo ? ` · ${esc(m.rotulo)}${m.rotuloPor ? ' (por ' + esc(m.rotuloPor) + ')' : ''}` : '') + '<br>' +
      (t.erro ? `<span class="erro">⚠ ${esc(t.erro)}</span>` : t.sync ? 'sincronizado às ' + new Date(t.sync).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : 'ainda não sincronizado');
  }
  window.prepararRotulo = () => {
    const compart = cfg.atual !== 'local';
    $('#rotuloBox').hidden = !compart;
    if (compart && !$('#rotulo').value) $('#rotulo').value = Nuvem.rotuloPadrao();
  };

  /* ---------- sincronização ---------- */
  let sincronizando = false, pedir = false, tSync = null;
  async function sync(manual) {
    const t = tabAtual(); if (!t) return;
    const b = backend();
    if (!b) { t.erro = 'Configure a conexão com a nuvem (⚙️ na tela das lojas).'; pintar(); return; }
    if (sincronizando) { pedir = true; return; }
    sincronizando = true;
    const tid = t.tid;
    try {
      await salvarAgora();
      const loja = {
        listar: () => todosDe(tid),
        atualizar: async (id, fn) => { const r = await req(tx().get(id)); if (r) { fn(r); await req(tx('readwrite').put(r)); } },
        adicionar: item => req(tx('readwrite').add({ ...item, tid }))
      };
      const rel = await Nuvem.sincronizar({ backend: b, tid, quem: cfg.usuario || '?', loja, estado: t });
      try { t.meta = await b.obterMeta(tid) || t.meta; } catch { /* só informativo */ }
      t.erro = ''; t.sync = Date.now(); gravar();
      if (cfg.atual === tid) { pintar(); await atualizarTela(); }
      if (rel.enviados) toast(`Enviado para a loja: ${rel.mudancas} alterações em ${rel.enviados} produtos`);
      else if (rel.recebidos) toast(`${rel.recebidos} produtos atualizados` + (rel.outros.length ? ' por ' + rel.outros.join(', ') : ''));
      else if (manual) toast('Tudo em dia');
    } catch (e) {
      t.erro = e.offline ? 'Sem internet: as alterações ficam guardadas e seguem quando voltar.' : (e.message || String(e));
      gravar(); pintar(); if (manual) toast(t.erro);
    } finally {
      sincronizando = false;
      if (pedir) { pedir = false; setTimeout(sync, 500); }
    }
  }
  // recarrega a tela com o que chegou da nuvem, sem atropelar o que você está digitando
  async function atualizarTela() {
    await buscar();
    if (atual && !$('#sheet').hidden) {
      const f = (await todos()).find(i => i.id === atual.id);
      if (f) {
        [['#fPreco', 'preco'], ['#fG1', 'g1'], ['#fG2', 'g2']].forEach(([s, k]) => {
          if (document.activeElement !== $(s)) { atual[k] = f[k]; $(s).value = f[k] || ''; }
        });
        atual.qtd = f.qtd; atual.nome = f.nome; $('#shNome').textContent = f.nome || '(sem descrição)';
        renderEstoque(); $('#estCard').hidden = !atual.qtd && !atual.defeito;
        if (!$('#simBox').hidden) { renderGarantias(); renderSim(); }
      }
    }
    if ($('#tab-tabela').classList.contains('active')) renderTabela();
  }
  aposMudar = origem => {
    if (cfg.atual === 'local' || sincronizando) return;
    const t = tabAtual();
    if (origem === 'scan' && t) {
      t.rotuloPendente = ($('#rotulo').value || '').trim() || Nuvem.rotuloPadrao(); gravar();
      $('#rotulo').value = '';
    }
    clearTimeout(tSync); tSync = setTimeout(() => sync(), 700);
  };

  async function trocar(tid) {
    await salvarAgora();
    cfg.atual = tid; gravar(); tidAtual = tid;
    pintar(); $('#rotulo').value = ''; prepararRotulo();
    await buscar();
    if ($('#tab-tabela').classList.contains('active')) renderTabela();
    if (tid !== 'local') sync(true);
  }

  /* ---------- tela das lojas ---------- */
  function lojasMsg(t, erro) { const m = $('#lMsg'); m.textContent = t || ''; m.className = 'hint' + (erro ? ' erro' : ''); }
  function renderLojas() {
    $('#lojasLista').innerHTML =
      `<div class="card"><button class="btn chip${cfg.atual === 'local' ? ' on' : ''}" data-sel="local">📍 Só neste aparelho (pessoal)</button></div>` +
      cfg.tabelas.map(t => `<div class="card"><button class="btn chip${cfg.atual === t.tid ? ' on' : ''}" data-sel="${esc(t.tid)}">🏬 ${esc(t.nome)}</button>
        <div class="hint">${t.meta && t.meta.rotulo ? esc(t.meta.rotulo) + (t.meta.rotuloPor ? ' (por ' + esc(t.meta.rotuloPor) + ')' : '') : 'sem atualização ainda'}${t.erro ? '<br><span class="erro">⚠ ' + esc(t.erro) + '</span>' : ''}</div>
        <button class="mini" data-hist="${esc(t.tid)}">ver histórico</button> <button class="mini" data-sync="${esc(t.tid)}">sincronizar agora</button> <button class="mini" data-sair="${esc(t.tid)}">sair desta tabela</button></div>`).join('');
    $('#lUsuario').value = cfg.usuario;
    const c = fbCfg();
    $('#fbMsg').textContent = c ? 'Conectado ao projeto: ' + c.projectId : 'Ainda não configurado.';
    $('#fbMsg').className = 'hint' + (c ? '' : ' erro');
    if (!c) $('#nuvemCfg').open = true;
  }
  function abrir(el) {
    el.hidden = false; el.scrollTop = 0; document.body.style.overflow = 'hidden';
    history.pushState({ loja: el.id }, '');
  }
  function fechar(el) { el.hidden = true; if ($('#lojas').hidden && $('#hist').hidden && $('#sheet').hidden && $('#novo').hidden) document.body.style.overflow = ''; }
  addEventListener('popstate', () => {
    if (!$('#hist').hidden) fechar($('#hist'));
    else if (!$('#lojas').hidden) fechar($('#lojas'));
  });
  $('#lojaBtn').onclick = () => { renderLojas(); lojasMsg(''); abrir($('#lojas')); };
  $('#lojasFechar').onclick = () => history.back();
  $('#histFechar').onclick = () => history.back();
  $('#lUsuario').addEventListener('input', e => { cfg.usuario = e.target.value.trim(); gravar(); });

  $('#lojasLista').addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.sel !== undefined) { await trocar(b.dataset.sel); renderLojas(); if (b.dataset.sel !== 'local') history.back(); }
    else if (b.dataset.hist) abrirHist(b.dataset.hist);
    else if (b.dataset.sync) { if (cfg.atual !== b.dataset.sync) await trocar(b.dataset.sync); else await sync(true); renderLojas(); }
    else if (b.dataset.sair) {
      const t = cfg.tabelas.find(x => x.tid === b.dataset.sair);
      if (!t || !confirm(`Sair da tabela "${t.nome}"? Os produtos dela saem deste aparelho (na nuvem continuam).`)) return;
      if (cfg.atual === t.tid) await trocar('local');
      const w = db.transaction('itens', 'readwrite'), s = w.objectStore('itens');
      (await todosDe(t.tid)).forEach(i => s.delete(i.id));
      await new Promise(r => { w.oncomplete = r; w.onerror = r; });
      cfg.tabelas = cfg.tabelas.filter(x => x.tid !== t.tid); gravar(); renderLojas(); pintar();
    }
  });

  async function entrar(criar) {
    const nome = $('#lNome').value.trim().replace(/\s+/g, ' '), senha = $('#lSenha').value, quem = $('#lUsuario').value.trim();
    if (!quem) return lojasMsg('Digite o seu nome lá em cima.', true);
    if (!nome) return lojasMsg('Digite o nome da tabela.', true);
    if (senha.length < 6) return lojasMsg('A senha precisa ter pelo menos 6 caracteres.', true);
    const b = backend(); if (!b) return lojasMsg('Falta configurar a conexão com a nuvem (⚙️ abaixo).', true);
    lojasMsg('Verificando…');
    try {
      const tid = await Nuvem.hashTabela(nome, senha);
      let meta = await b.obterMeta(tid);
      if (criar) {
        if (meta) return lojasMsg('Já existe uma tabela com esse nome e senha. Use "Entrar".', true);
        await b.criarMeta(tid, { nome, por: quem }); meta = { nome };
      } else if (!meta) return lojasMsg('Não encontrei: confira o nome e a senha. (Primeira vez? use "Criar tabela nova".)', true);
      cfg.usuario = quem;
      if (!cfg.tabelas.find(t => t.tid === tid)) cfg.tabelas.push({ tid, nome: meta.nome || nome, cursor: null, rotuloPendente: '', meta });
      if (criar && $('#lCopiar').checked) {
        const w = db.transaction('itens', 'readwrite'), s = w.objectStore('itens');
        (await todosDe('local')).forEach(({ id, _base, ...r }) => s.add({ ...r, tid }));
        await new Promise((res, rej) => { w.oncomplete = res; w.onerror = () => rej(w.error); });
      }
      gravar(); $('#lSenha').value = ''; $('#lNome').value = ''; lojasMsg('');
      await trocar(tid); history.back();
      toast(criar ? 'Tabela criada' : 'Entrou na tabela');
    } catch (e) { lojasMsg(e.offline ? 'Sem internet.' : e.existe ? e.message : 'Erro: ' + (e.message || e), true); }
  }
  $('#lEntrar').onclick = () => entrar(false);
  $('#lCriar').onclick = () => entrar(true);

  /* ---------- conexão ---------- */
  $('#fbSalvar').onclick = () => {
    const t = $('#fbTexto').value, k = /apiKey["']?\s*[:=]\s*["']([^"']+)/.exec(t), p = /projectId["']?\s*[:=]\s*["']([^"']+)/.exec(t);
    if (!k || !p) { $('#fbMsg').textContent = 'Não achei apiKey e projectId no texto colado.'; $('#fbMsg').className = 'hint erro'; return; }
    cfg.fb = { apiKey: k[1], projectId: p[1] }; gravar(); $('#fbTexto').value = '';
    renderLojas(); toast('Conexão salva');
  };
  const DICA = { 403: 'As regras do Firestore estão bloqueando: cole as regras do arquivo NUVEM-LEIA-ME.txt e publique.', 400: 'Chave (apiKey) ou projeto inválido.', 404: 'O banco Firestore não foi criado nesse projeto (ou o projectId está errado).' };
  $('#fbTestar').onclick = async () => {
    const b = backend(), box = $('#fbPassos');
    if (!b) { box.innerHTML = '<p class="passo ruim">Salve a conexão primeiro.</p>'; return; }
    box.innerHTML = '<p class="hint">Testando…</p>';
    try {
      const ps = await b.testar();
      box.innerHTML = ps.map(p => `<div class="passo ${p.ok ? 'ok' : 'ruim'}">${p.ok ? '✅' : '❌'} ${esc(p.nome)}${p.ok ? '' : ': ' + esc(p.erro)}</div>`).join('') +
        (ps.every(p => p.ok) ? '<p class="passo ok"><b>Tudo certo. Pode criar as tabelas.</b></p>' : '');
    } catch (e) { box.innerHTML = `<div class="passo ruim">❌ ${esc(e.message)}</div>`; }
  };

  /* ---------- histórico ---------- */
  async function abrirHist(tid) {
    const t = cfg.tabelas.find(x => x.tid === tid), b = backend(); if (!t || !b) return;
    $('#histNome').textContent = t.nome; $('#histLista').innerHTML = '<p class="hint">Carregando…</p>';
    abrir($('#hist'));
    try {
      const h = await b.listarHistorico(tid, 40);
      $('#histLista').innerHTML = h.length ? h.map(x => {
        const ms = x.mudancas.slice(0, 300).map(m => `<div class="mud"><b>${esc(m.nce)}</b> ${esc(String(m.nome || '').slice(0, 40))}<br>${esc(Nuvem.ROTULO[m.campo] || m.campo)}: <small>${esc(m.de || '—')}</small> → <b>${esc(m.para || '—')}</b></div>`).join('');
        return `<details class="card"><summary><b>${esc(x.rotulo || 'Edição')}</b><br><small>${esc(x.quem)} · ${esc(dataBR(x.t))} · ${x.n} alterações</small></summary>${ms}${x.mudancas.length > 300 ? '<p class="hint">… e mais ' + (x.mudancas.length - 300) + '</p>' : ''}${x.mudancas.length ? '' : '<p class="hint">Atualização sem alterações de valores.</p>'}</details>`;
      }).join('') : '<div class="empty">Nenhuma atualização ainda.</div>';
    } catch (e) { $('#histLista').innerHTML = `<div class="empty">Não consegui carregar: ${esc(e.message)}</div>`; }
  }

  /* ---------- início ---------- */
  window.iniciarLojas = () => {
    if (!tabAtual()) cfg.atual = 'local';
    tidAtual = cfg.atual; pintar(); prepararRotulo();
    if (cfg.atual !== 'local') setTimeout(() => sync(), 300);
    setInterval(() => { if (!document.hidden && cfg.atual !== 'local' && !ocupado) sync(); }, 30000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && cfg.atual !== 'local') sync(); });
    window.addEventListener('online', () => { if (cfg.atual !== 'local') sync(); });
  };
  window._lojas = { sync, cfg: () => cfg, trocar };
})();
