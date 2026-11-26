// Digitação manual da tabela da loja: 1) garantia (seguro)  2) produtos. Funciona no celular e no PC.
(() => {
  const MODOS = {
    seguro: { titulo: '1 · Garantia', salvar: 'Salvar tabela de garantia', campos: [['grupo', 'Grupo', 'text'], ['nce', 'NCE', 'numeric'], ['nome', 'Descrição', 'text'], ['g1', 'Seguro 1 ano', 'decimal'], ['g2', 'Seguro 2 anos', 'decimal']] },
    produtos: { titulo: '2 · Produtos', salvar: 'Salvar tabela de produtos', campos: [['grupo', 'Grupo', 'text'], ['nce', 'NCE', 'numeric'], ['cor', 'Nome da cor', 'text'], ['nome', 'Descrição', 'text'], ['qtd', 'Saldo', 'numeric'], ['preco', 'Preço', 'decimal']] }
  };
  let modo = 'seguro', linhas = { seguro: [], produtos: [] }, existentes = {}, tidCarregado = null;
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
    render();
  }
  function status(t, erro) { const s = $('#digMsg'); if (s) { s.textContent = t || ''; s.className = 'hint' + (erro ? ' erro' : ''); } }
  function render() {
    const M = MODOS[modo], L = linhas[modo], n = L.filter(r => !vazioTudo(r)).length;
    $('#digLoja').textContent = 'Tabela: ' + rotuloLoja();
    $('#digModo').innerHTML = Object.keys(MODOS).map(k => `<button data-modo="${k}" class="chip ${k === modo ? 'on' : ''}">${MODOS[k].titulo}</button>`).join('');
    $('#digDica').textContent = modo === 'seguro'
      ? 'Digite primeiro a garantia: grupo, NCE, descrição e os dois seguros. O grupo se repete sozinho nas linhas novas.'
      : 'Agora os produtos: grupo, NCE, nome da cor, descrição, saldo e preço. Se o NCE já tem garantia, a descrição e o grupo aparecem sozinhos.';
    $('#digLinhas').innerHTML = L.map((r, i) => `<div class="drow m-${modo}" data-i="${i}"><span class="dn">${i + 1}</span>${M.campos.map(([f, rot, im]) =>
      `<label class="df df-${f}">${rot}<input data-f="${f}" value="${esc(r[f])}" inputmode="${im}" autocomplete="off" ${f === 'nce' ? 'maxlength="6"' : ''} enterkeyhint="next"></label>`).join('')}<button class="dx" data-del="${i}" aria-label="Apagar linha">✕</button></div>`).join('');
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
    status(`✅ ${itens.length} linhas salvas.` + (suspeitos ? ` ${suspeitos} com seguro 2 anos fora do normal (~1,6× o de 1 ano): confira no quadro.` : '') + (modo === 'seguro' ? ' Agora digite os produtos (aba 2).' : ''));
    if (modo === 'seguro') modo = 'produtos';
    await abrirTab(); buscar();
  };
  document.querySelector('nav button[data-tab="digitar"]').addEventListener('click', abrirTab);
  window.abrirDigitar = abrirTab; window._dig = () => ({ linhas, modo });
})();
