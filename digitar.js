// Digitação manual da tabela da loja: 1) garantia (seguro)  2) produtos. Funciona no celular e no PC.
(() => {
  const MODOS = {
    seguro: { titulo: '🛡️ Seguros', salvar: 'Salvar tabela de garantia', campos: [['grupo', 'Grupo', 'text'], ['nce', 'NCE', 'numeric'], ['nome', 'Descrição', 'text'], ['g1', 'Seguro 1 ano', 'decimal'], ['g2', 'Seguro 2 anos', 'decimal']] },
    produtos: { titulo: '📦 Produtos', salvar: 'Salvar tabela de produtos', campos: [['grupo', 'Grupo', 'text'], ['nce', 'NCE', 'numeric'], ['cor', 'Nome da cor', 'text'], ['nome', 'Descrição', 'text'], ['qtd', 'Saldo', 'numeric'], ['preco', 'Preço', 'decimal']] }
  };
  let escolhido = false, modo = 'seguro', linhas = { seguro: [], produtos: [] }, existentes = {}, tidCarregado = null;
  const vazia = g => ({ grupo: g || '', nce: '', cor: '', nome: '', qtd: '', preco: '', g1: '', g2: '' });
  const chave = () => 'nce-dig-' + tidAtual;
  const lerRascunho = () => { try { const d = JSON.parse(localStorage.getItem(chave()) || 'null'); if (d) linhas = { seguro: d.seguro || [], produtos: d.produtos || [] }; } catch (e) { } };
  const gravarRascunho = () => { try { localStorage.setItem(chave(), JSON.stringify(linhas)); } catch (e) { } };
  const vazioTudo = r => !['nce', 'cor', 'nome', 'qtd', 'preco', 'g1', 'g2'].some(k => String(r[k] || '').trim());
  const rotuloLoja = () => ($('#lojaBtn').textContent || '').replace(/^\S+\s/, '') || 'Só neste aparelho';

  async function abrirTab() {
    if (tidCarregado !== tidAtual) { linhas = { seguro: [], produtos: [] }; lerRascunho(); tidCarregado = tidAtual; }
    existentes = {}; (await todos()).forEach(i => { existentes[i.nce] = i; });
    ['seguro', 'produtos'].forEach(m => { if (!linhas[m].length) linhas[m].push(vazia()); });
    escolhido = false; render();
  }
  function resumo() {
    const v = Object.values(existentes), tem = {
      s: i => String(i.g1 || '').trim() || String(i.g2 || '').trim(),
      p: i => String(i.preco || '').trim() || String(i.qtd || '').trim()
    };
    const ambos = v.filter(i => tem.s(i) && tem.p(i)).length, so_s = v.filter(i => tem.s(i) && !tem.p(i)).length, so_p = v.filter(i => !tem.s(i) && tem.p(i)).length;
    $('#digResumo').innerHTML = v.length ? `<b>Nesta tabela já tem ${v.length} produtos (NCE)</b><br>✅ completos (seguro + produto): <b>${ambos}</b><br>🛡️ só com seguro, falta digitar o produto: <b>${so_s}</b><br>📦 só com produto, falta digitar o seguro: <b>${so_p}</b>` : '<span class="hint">Tabela ainda vazia. Escolha acima por onde começar.</span>';
  }
  function status(t, erro) { const s = $('#digMsg'); if (s) { s.textContent = t || ''; s.className = 'hint' + (erro ? ' erro' : ''); } }
  function render() {
    $('#digLoja').textContent = 'Tabela: ' + rotuloLoja();
    $('#digInicio').hidden = escolhido; $('#digTela').hidden = !escolhido;
    if (!escolhido) return resumo();
    const M = MODOS[modo], L = linhas[modo], n = L.filter(r => !vazioTudo(r)).length;
    $('#digLoja').textContent = 'Tabela: ' + rotuloLoja();
    $('#digModo').innerHTML = Object.keys(MODOS).map(k => `<button data-modo="${k}" class="chip ${k === modo ? 'on' : ''}">${MODOS[k].titulo}</button>`).join('');
    $('#digDica').textContent = modo === 'seguro'
      ? 'Tabela de seguros: grupo, NCE, descrição e os dois seguros. O grupo se repete sozinho nas linhas novas.'
      : 'Tabela de produtos: grupo, NCE, nome da cor, descrição, saldo e preço. Se o NCE já foi digitado na outra tabela, a descrição e o grupo aparecem sozinhos.';
    $('#digLinhas').innerHTML = L.map((r, i) => `<div class="drow m-${modo}" data-i="${i}"><span class="dn">${i + 1}</span>${M.campos.map(([f, rot, im]) =>
      `<label class="df df-${f}${r._bad && r._bad[f] ? ' bad' : ''}">${rot}<input data-f="${f}" value="${esc(r[f])}" inputmode="${im}" autocomplete="off" ${f === 'nce' ? 'maxlength="6"' : ''} enterkeyhint="next"></label>`).join('')}<button class="dx" data-del="${i}" aria-label="Apagar linha">✕</button></div>`).join('');
    $('#digSalvar').textContent = M.salvar + (n ? ` (${n})` : '');
  }
  function proximo(inp) {
    const row = inp.closest('.drow'), ins = [...row.querySelectorAll('input')], k = ins.indexOf(inp);
    if (k < ins.length - 1) return ins[k + 1].focus();
    const L = linhas[modo], i = +row.dataset.i;
    if (i === L.length - 1) { L.push(vazia(L[i].grupo)); gravarRascunho(); render(); }
    const nova = $('#digLinhas').querySelector(`.drow[data-i="${i + 1}"] input[data-f="nce"]`); if (nova) nova.focus();
  }
  $('#digLinhas').addEventListener('input', e => {
    const f = e.target.dataset.f; if (!f) return; const i = +e.target.closest('.drow').dataset.i, r = linhas[modo][i];
    if (f === 'nce') e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
    r[f] = e.target.value;
    if (r._bad && r._bad[f]) { delete r._bad[f]; e.target.closest('.df').classList.remove('bad'); }
    if (f === 'nce' && r.nce.length === 6 && existentes[r.nce]) { // já existe: completa o que estiver vazio
      const x = existentes[r.nce], row = e.target.closest('.drow');
      [['nome', x.nome], ['cor', x.cor], ['grupo', x.grupo]].forEach(([k, v]) => { if (v && !String(r[k] || '').trim() && (modo === 'produtos' || k !== 'cor')) { r[k] = v; const inp = row.querySelector(`[data-f="${k}"]`); if (inp) inp.value = v; } });
    }
    gravarRascunho();
  });
  $('#digLinhas').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.dataset.f) { e.preventDefault(); proximo(e.target); } });
  $('#digLinhas').addEventListener('click', e => {
    const d = e.target.closest('[data-del]'); if (!d) return;
    linhas[modo].splice(+d.dataset.del, 1); if (!linhas[modo].length) linhas[modo].push(vazia()); gravarRascunho(); render();
  });
  $('#digModo').addEventListener('click', e => { const b = e.target.closest('[data-modo]'); if (b) { modo = b.dataset.modo; status(''); render(); } });
  $('#digEscSeguro').onclick = () => { modo = 'seguro'; escolhido = true; status(''); render(); };
  $('#digEscProdutos').onclick = () => { modo = 'produtos'; escolhido = true; status(''); render(); };
  $('#digTrocar').onclick = () => { escolhido = false; render(); };
  // Ler foto (OCR no próprio aparelho) e preencher a grade; o que ficou duvidoso vem em vermelho para conferir
  async function lerFotos(files) {
    files = [...files].filter(f => f.type.startsWith('image/')); if (!files.length) return;
    if (ocupado) return toast('Aguarde: ainda lendo');
    ocupado = true; const M = modo, avisos = []; let total = 0;
    try {
      for (let n = 0; n < files.length; n++) {
        const rot = `Lendo foto ${n + 1} de ${files.length}…`; setProg(0.01, rot);
        const onp = (f, txt) => setProg(f, txt || rot); let lido;
        if (typeof OffscreenCanvas !== 'undefined') { try { lido = await lerNoWorker({ file: files[n] }, onp); } catch (e) { if (!e.prep) throw e; } }
        if (!lido) { const { img } = await prepararImagem(files[n]); lido = await lerNoWorker(img, onp); }
        const tipoReal = Parser.detectarTipo(lido.linhas);
        const itens = Parser.parsePagina(lido.linhas, tipoReal === 'esq' ? 'produtos' : M, lido.meta).filter(i => /^\d{6}$/.test(i.nce));
        if (tipoReal === 'seguro' && M === 'produtos') avisos.push(`foto ${n + 1} parece tabela de SEGUROS`);
        if (tipoReal === 'produtos' && M === 'seguro') avisos.push(`foto ${n + 1} parece tabela de PRODUTOS`);
        if (tipoReal === 'esq') avisos.push(`foto ${n + 1} é só a metade esquerda: sem saldo/preço`);
        if (!itens.length) { avisos.push(`foto ${n + 1}: nenhuma linha reconhecida`); continue; }
        const L = linhas[M]; while (L.length && vazioTudo(L[L.length - 1])) L.pop();
        let g = L.length ? L[L.length - 1].grupo : '';
        itens.forEach(it => {
          const lim = (Parser.LIM ?? 0.7), bad = {}, c = it.conf || {};
          const campos = M === 'seguro' ? ['nce', 'g1', 'g2'] : ['nce', 'qtd', 'preco'];
          campos.forEach(k => { if (k !== 'nce' ? (!it[k] || (c[k] !== undefined && c[k] < lim)) : (c.nce !== undefined && c.nce < lim)) bad[k] = true; });
          if (M === 'seguro' && it.g1 && it.g2) { const q = Sim.cents(it.g2) / Sim.cents(it.g1); if (!(q > 1.55 && q < 1.66)) { bad.g1 = true; bad.g2 = true; } }
          let r = L.find(x => x.nce === it.nce);
          if (!r) { r = vazia(g); L.push(r); }
          const nv = { nce: it.nce, nome: it.nome || '', cor: it.cor || '', qtd: it.qtd || '', preco: it.preco || '', g1: it.g1 || '', g2: it.g2 || '' };
          Object.keys(nv).forEach(k => { if (nv[k] !== '' && (!String(r[k] || '').trim() || k === 'nce')) r[k] = nv[k]; });
          r._bad = Object.assign(r._bad || {}, bad); total++;
        });
        L.push(vazia(g));
      }
      fimProg(); gravarRascunho(); render();
      status(`📷 ${total} linhas preenchidas pela foto. Confira os campos em vermelho antes de salvar.` + (avisos.length ? ' Avisos: ' + avisos.join('; ') + '.' : ''), avisos.length > 0);
    } catch (e) { console.error(e); fimProg(); status(e.message === 'cancelado' ? 'Leitura cancelada' : 'Erro ao ler a imagem: ' + (e.message || e), true); }
    finally { ocupado = false; }
  }
  $('#digCam').onchange = e => { const f = [...e.target.files]; e.target.value = ''; lerFotos(f); };
  $('#digGal').onchange = e => { const f = [...e.target.files]; e.target.value = ''; lerFotos(f); };
  $('#digAdd').onclick = () => { const L = linhas[modo]; L.push(vazia(L.length ? L[L.length - 1].grupo : '')); gravarRascunho(); render(); const i = L.length - 1; const c = $('#digLinhas').querySelector(`.drow[data-i="${i}"] input[data-f="nce"]`); if (c) c.focus(); };
  $('#digLimpar').onclick = () => { if (!confirm('Apagar tudo que está digitado nesta tabela (ainda não salvo)?')) return; linhas[modo] = [vazia()]; gravarRascunho(); status(''); render(); };
  $('#digSalvar').onclick = async () => {
    const L = linhas[modo], itens = [], erros = []; let suspeitos = 0;
    L.forEach((r, i) => {
      if (vazioTudo(r)) return;
      const nce = String(r.nce).replace(/\D/g, '');
      if (!/^\d{6}$/.test(nce)) return erros.push(`linha ${i + 1}: NCE precisa ter 6 números`);
      const it = { tipo: modo, nce, grupo: String(r.grupo || '').trim(), nome: String(r.nome || '').trim().replace(/\s+/g, ' '), pagina: 1, raw: '' };
      const campos = modo === 'seguro' ? [['g1', 'seguro 1 ano'], ['g2', 'seguro 2 anos']] : [['preco', 'preço']];
      for (const [k, rot] of campos) { const b = String(r[k] || '').trim(); it[k] = dinStr(b); if (b && !it[k]) return erros.push(`linha ${i + 1}: ${rot} inválido`); }
      if (modo === 'produtos') { it.cor = String(r.cor || '').trim(); it.qtd = String(r.qtd || '').replace(/\D/g, ''); }
      else if (it.g1 && it.g2) { const q = Sim.cents(it.g2) / Sim.cents(it.g1); if (!(q > 1.55 && q < 1.66)) suspeitos++; }
      itens.push(it);
    });
    if (erros.length) return status('Corrija antes de salvar → ' + erros.slice(0, 4).join('; ') + (erros.length > 4 ? ` (+${erros.length - 4})` : ''), true);
    if (!itens.length) return status('Nada digitado para salvar.', true);
    await salvarItens(itens); aposMudar();
    linhas[modo] = [vazia(L.length ? L[L.length - 1].grupo : '')]; gravarRascunho();
    toast(`${itens.length} linhas salvas em ${rotuloLoja()}`);
    status(`✅ ${itens.length} linhas salvas.` + (suspeitos ? ` ${suspeitos} com seguro 2 anos fora do normal (~1,6× o de 1 ano): confira no quadro.` : ''));
    existentes = {}; (await todos()).forEach(i => { existentes[i.nce] = i; }); render(); buscar();
  };
  const corpo = () => $('#tabelaCorpo');
  $('#digAbrir').onclick = async () => { await abrirTab(); $('#digPainel').hidden = false; $('#digAbrir').hidden = true; corpo().hidden = true; };
  $('#digFechar').onclick = () => { $('#digPainel').hidden = true; $('#digAbrir').hidden = false; corpo().hidden = false; renderTabela(); };
  window.abrirDigitar = abrirTab; window._dig = () => ({ linhas, modo, escolhido });
})();
