// Tabelas compartilhadas entre aparelhos (uma por loja), protegidas por nome + senha.
//
// Como funciona:
//  - O nome da tabela + a senha geram um código (PBKDF2-SHA256). Só quem sabe os dois chega até a tabela;
//    a senha em si nunca sai do aparelho nem é guardada.
//  - Os dados ficam no Firestore (Google Firebase, plano gratuito), acessado pela API REST (sem biblioteca externa).
//  - Cada produto é um documento. Cada aparelho envia só os CAMPOS que mudou (preço, estoque, seguros...) e recebe
//    o que os outros mudaram. Se duas pessoas mudam o mesmo campo, vale a última que enviou.
//  - Cada envio gera uma linha de histórico: quem, quando, nome da atualização e o que mudou (de → para).
(function (root) {
  const CAMPOS = ['nome', 'cor', 'qtd', 'preco', 'g1', 'g2']; // 'quebrados' fica só no aparelho
  const ROTULO = { nome: 'descrição', cor: 'cor', qtd: 'estoque', preco: 'preço', g1: 'seguro 1 ano', g2: 'seguro 2 anos', defeito: 'quebrados' };
  const str = v => (v === undefined || v === null ? '' : String(v));
  const val = (it, f) => (f === 'defeito' ? String(parseInt(it && it[f], 10) || 0) : str(it && it[f]).trim());

  const normNome = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

  async function hashTabela(nome, senha) {
    const c = root.crypto || (typeof require !== 'undefined' ? require('crypto').webcrypto : null);
    const enc = new TextEncoder();
    const chave = await c.subtle.importKey('raw', enc.encode(String(senha)), 'PBKDF2', false, ['deriveBits']);
    const bits = await c.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('pesquisa-nce|' + normNome(nome)), iterations: 120000 }, chave, 256);
    return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
  const p2 = n => String(n).padStart(2, '0');
  // "Tabela de quinta 10/11/2026 às 07:30"
  function rotuloPadrao(d) {
    d = d || new Date();
    return `Tabela de ${DIAS[d.getDay()]} ${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()} às ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  }

  /* ================= Firestore (API REST) ================= */
  function Firestore(cfg) {
    const P = cfg.projectId, K = encodeURIComponent(cfg.apiKey);
    const raiz = `projects/${P}/databases/(default)/documents`;
    const base = `https://firestore.googleapis.com/v1/${raiz}`;
    const doc = (...p) => `${raiz}/${p.join('/')}`;

    async function api(metodo, url, corpo) {
      let r;
      try {
        r = await fetch(url + (url.includes('?') ? '&' : '?') + 'key=' + K, { method: metodo, headers: corpo ? { 'Content-Type': 'application/json' } : undefined, body: corpo ? JSON.stringify(corpo) : undefined });
      } catch (e) { const er = new Error('Sem conexão com a nuvem (' + (e.message || e) + ')'); er.offline = true; throw er; }
      let j = null; try { j = await r.json(); } catch { /* corpo vazio */ }
      if (!r.ok) {
        const er = new Error((j && j.error && j.error.message) || 'Erro ' + r.status);
        er.status = r.status; er.codigo = j && j.error && j.error.status; throw er;
      }
      return j;
    }
    const S = v => ({ stringValue: String(v) });
    const lerCampos = f => { const o = {}; for (const k in (f || {})) { const v = f[k]; o[k] = v.stringValue ?? v.integerValue ?? v.timestampValue ?? ''; } return o; };
    const commit = writes => api('POST', `${base}:commit`, { writes });
    const agora = { fieldPath: 't', setToServerValue: 'REQUEST_TIME' };

    return {
      async obterMeta(tid) {
        try { const d = await api('GET', `${base}/tabelas/${tid}`); const c = lerCampos(d.fields); return { nome: c.nome || '', rotulo: c.rotulo || '', rotuloPor: c.rotuloPor || '', criadoPor: c.criadoPor || '' }; }
        catch (e) { if (e.status === 404) return null; throw e; }
      },
      async criarMeta(tid, { nome, por }) {
        try {
          await commit([{ update: { name: doc('tabelas', tid), fields: { nome: S(nome), criadoPor: S(por) } }, updateMask: { fieldPaths: ['nome', 'criadoPor'] }, updateTransforms: [{ fieldPath: 'criadoEm', setToServerValue: 'REQUEST_TIME' }], currentDocument: { exists: false } }]);
        } catch (e) { if (e.status === 409 || e.codigo === 'ALREADY_EXISTS' || e.codigo === 'FAILED_PRECONDITION') { const er = new Error('Já existe uma tabela com esse nome e senha.'); er.existe = true; throw er; } throw e; }
      },
      async atualizarMeta(tid, { rotulo, rotuloPor }) {
        await commit([{ update: { name: doc('tabelas', tid), fields: { rotulo: S(rotulo), rotuloPor: S(rotuloPor) } }, updateMask: { fieldPaths: ['rotulo', 'rotuloPor'] }, updateTransforms: [{ fieldPath: 'rotuloEm', setToServerValue: 'REQUEST_TIME' }] }]);
      },
      async listarItens(tid, cursor, limite) {
        const q = { from: [{ collectionId: 'itens' }], orderBy: [{ field: { fieldPath: 't' }, direction: 'ASCENDING' }, { field: { fieldPath: '__name__' }, direction: 'ASCENDING' }], limit: limite || 400 };
        if (cursor) q.startAt = { values: [{ timestampValue: cursor.t }, { referenceValue: doc('tabelas', tid, 'itens', cursor.nce) }], before: false };
        const r = await api('POST', `${base}/tabelas/${tid}:runQuery`, { structuredQuery: q });
        const itens = (r || []).filter(x => x.document).map(x => {
          const c = lerCampos(x.document.fields), nce = c.nce || x.document.name.split('/').pop();
          const campos = {}; CAMPOS.forEach(f => { if (c[f] !== undefined) campos[f] = c[f]; });
          return { nce, campos, por: c.por || '', t: c.t };
        });
        const ult = itens[itens.length - 1];
        return { itens, cursor: ult ? { t: ult.t, nce: ult.nce } : cursor || null, mais: itens.length >= (limite || 400) };
      },
      async gravarItens(tid, itens, por) {
        let t = null;
        for (let i = 0; i < itens.length; i += 300) {
          const writes = itens.slice(i, i + 300).map(it => {
            const fields = { nce: S(it.nce), por: S(por) }, mask = ['nce', 'por'];
            for (const f in it.campos) { fields[f] = S(it.campos[f]); mask.push(f); }
            return { update: { name: doc('tabelas', tid, 'itens', it.nce), fields }, updateMask: { fieldPaths: mask }, updateTransforms: [agora] };
          });
          const r = await commit(writes); t = r.commitTime || t;
        }
        return { t };
      },
      async gravarHistorico(tid, h) {
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const f = { quem: S(h.quem), rotulo: S(h.rotulo || ''), mudancas: S(JSON.stringify(h.mudancas || [])), n: { integerValue: String(h.n ?? (h.mudancas || []).length) } };
        await commit([{ update: { name: doc('tabelas', tid, 'historico', id), fields: f }, updateMask: { fieldPaths: Object.keys(f) }, updateTransforms: [agora] }]);
      },
      async listarHistorico(tid, n) {
        const r = await api('POST', `${base}/tabelas/${tid}:runQuery`, { structuredQuery: { from: [{ collectionId: 'historico' }], orderBy: [{ field: { fieldPath: 't' }, direction: 'DESCENDING' }], limit: n || 30 } });
        return (r || []).filter(x => x.document).map(x => {
          const c = lerCampos(x.document.fields); let m = []; try { m = JSON.parse(c.mudancas || '[]'); } catch { /* ignora */ }
          return { quem: c.quem, rotulo: c.rotulo, t: c.t, n: Number(c.n) || m.length, mudancas: m };
        });
      },
      // Teste de ponta a ponta para a tela de configuração: devolve uma lista de passos com ok/erro
      async testar() {
        const passos = []; const tid = 'teste-conexao';
        const passo = async (nome, fn) => { try { await fn(); passos.push({ nome, ok: true }); return true; } catch (e) { passos.push({ nome, ok: false, erro: e.message }); return false; } };
        if (!await passo('Gravar na nuvem', () => this.gravarItens(tid, [{ nce: '000000', campos: { nome: 'teste' } }], 'teste'))) return passos;
        await passo('Ler da nuvem', async () => { const r = await this.listarItens(tid, null, 5); if (!r.itens.length) throw new Error('Gravou, mas não leu de volta'); });
        await passo('Gravar histórico', () => this.gravarHistorico(tid, { quem: 'teste', rotulo: 'teste', mudancas: [] }));
        await passo('Ler histórico', async () => { const r = await this.listarHistorico(tid, 3); if (!r.length) throw new Error('Não leu de volta'); });
        return passos;
      }
    };
  }

  /* ================= Memória (para testes: faz o papel do servidor) ================= */
  function Memoria() {
    const tab = {}; let seq = 0;
    const T = () => 't' + String(++seq).padStart(10, '0');
    const get = tid => (tab[tid] ||= { meta: null, itens: {}, hist: [] });
    return {
      _tab: tab,
      async obterMeta(tid) { return get(tid).meta ? { ...get(tid).meta } : null; },
      async criarMeta(tid, { nome, por }) { const g = get(tid); if (g.meta) { const e = new Error('Já existe uma tabela com esse nome e senha.'); e.existe = true; throw e; } g.meta = { nome, criadoPor: por, rotulo: '', rotuloPor: '' }; },
      async atualizarMeta(tid, { rotulo, rotuloPor }) { const g = get(tid); g.meta = Object.assign(g.meta || {}, { rotulo, rotuloPor }); },
      async listarItens(tid, cursor, limite) {
        limite = limite || 400;
        const todos = Object.entries(get(tid).itens).map(([nce, d]) => ({ nce, campos: { ...d.campos }, por: d.por, t: d.t })).sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.nce < b.nce ? -1 : 1));
        const dep = cursor ? todos.filter(x => x.t > cursor.t || (x.t === cursor.t && x.nce > cursor.nce)) : todos;
        const itens = dep.slice(0, limite), ult = itens[itens.length - 1];
        return { itens, cursor: ult ? { t: ult.t, nce: ult.nce } : cursor || null, mais: itens.length >= limite };
      },
      async gravarItens(tid, itens, por) {
        const t = T(), g = get(tid);
        itens.forEach(it => { const d = (g.itens[it.nce] ||= { campos: {} }); Object.assign(d.campos, it.campos); d.por = por; d.t = t; });
        return { t };
      },
      async gravarHistorico(tid, h) { get(tid).hist.push({ ...h, t: T(), n: h.n ?? h.mudancas.length }); },
      async listarHistorico(tid, n) { return get(tid).hist.slice().reverse().slice(0, n || 30); }
    };
  }

  /* ================= Sincronização ================= */
  // loja: { listar(): Promise<itens[]>, atualizar(id, fn): Promise, adicionar(item): Promise }  (itens locais da tabela atual)
  // estado: { cursor, rotuloPendente }  (guardado pelo app entre as sincronizações)
  async function sincronizar({ backend, tid, quem, loja, estado }) {
    const rel = { enviados: 0, mudancas: 0, recebidos: 0, outros: [] };

    // 1) envia só o que mudou aqui desde a última sincronização
    const itens = await loja.listar(), envios = [], mud = [];
    for (const it of itens) {
      if (!/^\d{6}$/.test(str(it.nce))) continue;
      const base = it._base, sujos = {};
      for (const f of CAMPOS) {
        const cur = val(it, f), b = base ? val(base, f) : '';
        const mudou = base ? cur !== b : (cur !== '' && !(f === 'defeito' && cur === '0'));
        if (mudou) { sujos[f] = cur; mud.push({ nce: it.nce, nome: val(it, 'nome'), campo: f, de: base ? b : '', para: cur }); }
      }
      if (Object.keys(sujos).length) envios.push({ id: it.id, nce: it.nce, campos: sujos });
    }
    if (envios.length) {
      await backend.gravarItens(tid, envios.map(e => ({ nce: e.nce, campos: e.campos })), quem);
      for (const e of envios) await loja.atualizar(e.id, it => { it._base = { ...(it._base || {}), ...e.campos }; });
      rel.enviados = envios.length; rel.mudancas = mud.length;
    }
    if (mud.length || estado.rotuloPendente) {
      const rotulo = estado.rotuloPendente || '';
      if (mud.length) for (let i = 0; i < mud.length; i += 1500) await backend.gravarHistorico(tid, { quem, rotulo, mudancas: mud.slice(i, i + 1500), n: mud.length });
      else await backend.gravarHistorico(tid, { quem, rotulo, mudancas: [], n: 0 });
      if (rotulo) await backend.atualizarMeta(tid, { rotulo, rotuloPor: quem });
      estado.rotuloPendente = '';
    }

    // 2) recebe o que os outros mudaram
    const outros = new Set();
    for (;;) {
      const r = await backend.listarItens(tid, estado.cursor, 400);
      const locais = {}; (await loja.listar()).forEach(i => { locais[i.nce] = i; });
      for (const rem of r.itens) {
        const loc = locais[rem.nce];
        if (!loc) {
          const campos = { ...rem.campos }; if (campos.defeito !== undefined) campos.defeito = parseInt(campos.defeito, 10) || 0;
          await loja.adicionar({ nce: rem.nce, nome: '', cor: '', qtd: '', preco: '', g1: '', g2: '', defeito: 0, folha: 0, ...campos, _base: { ...campos } });
          rel.recebidos++; if (rem.por && rem.por !== quem) outros.add(rem.por);
          continue;
        }
        const mudar = {};
        for (const f in rem.campos) {
          const novo = f === 'defeito' ? String(parseInt(rem.campos[f], 10) || 0) : rem.campos[f];
          const editadoAqui = loc._base ? val(loc, f) !== val(loc._base, f) : val(loc, f) !== '';
          if (editadoAqui) continue; // alteração daqui ainda não enviada: ela prevalece e segue no próximo envio
          if (val(loc, f) !== novo) mudar[f] = f === 'defeito' ? parseInt(novo, 10) || 0 : novo;
          mudar['_b_' + f] = f === 'defeito' ? parseInt(novo, 10) || 0 : novo;
        }
        const reais = Object.keys(mudar).filter(k => !k.startsWith('_b_'));
        if (Object.keys(mudar).length) await loja.atualizar(loc.id, it => {
          it._base = it._base || {};
          for (const k in mudar) { if (k.startsWith('_b_')) it._base[k.slice(3)] = mudar[k]; else it[k] = mudar[k]; }
        });
        if (reais.length) { rel.recebidos++; if (rem.por && rem.por !== quem) outros.add(rem.por); }
      }
      estado.cursor = r.cursor;
      if (!r.mais) break;
    }
    rel.outros = Array.from(outros);
    return rel;
  }

  const api = { CAMPOS, ROTULO, hashTabela, normNome, rotuloPadrao, Firestore, Memoria, sincronizar };
  if (typeof module !== 'undefined') module.exports = api; else root.Nuvem = api;
})(typeof self !== 'undefined' ? self : this);
