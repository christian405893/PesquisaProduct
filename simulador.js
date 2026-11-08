// Regras de venda parcelada. Todos os valores em CENTAVOS (inteiros).
// As taxas foram medidas nos prints do site que os vendedores usam (tabela Price, 9,9% ao mês).
(function (root) {
  const CFG = {
    crediario: { taxa: 0.099, semJuros: 3, min: 1, max: 12, maxComEntrada: 11 },
    // Cartão: até 6x sem juros. Taxa mensal dos 7x–12x ainda não informada (ex.: 0.0599 = 5,99% a.m.).
    // taxas: { 7: 0.0599, 8: ... } para taxa diferente em cada prazo; taxa serve para todos os prazos sem taxa própria.
    cartao: { taxa: null, taxas: {}, semJuros: 6, max: 12 }
  };

  // "1.279,00" | "1279,00" | "1279.00" | "338.70" | "1279" -> número (ou NaN)
  function parseBRL(s) {
    s = String(s ?? '').replace(/[^\d.,]/g, '');
    if (!s) return NaN;
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
    const v = parseFloat(s);
    return isFinite(v) ? v : NaN;
  }
  const cents = s => { const v = parseBRL(s); return isNaN(v) ? 0 : Math.round(v * 100); };
  const brl = c => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  // parcela (centavos) de um valor financiado em n vezes, com taxa mensal i (0 = sem juros)
  function parcela(pv, n, i) {
    return i ? Math.round(pv * i / (1 - Math.pow(1 + i, -n))) : Math.round(pv / n);
  }
  function linha(pv, n, taxa, entrada) {
    const p = parcela(pv, n, taxa);
    return { n, parcela: p, total: p * n + entrada, semJuros: !taxa };
  }

  // Crediário: obrigatoriamente com garantia (o app exige a escolha). 1x a 3x sem juros;
  // até 12x sem entrada, até 11x com entrada.
  function crediario({ preco, garantia = 0, entrada = 0 }) {
    const c = CFG.crediario, financiado = preco + garantia - entrada;
    const max = entrada > 0 ? c.maxComEntrada : c.max, lista = [];
    if (financiado > 0)
      for (let n = c.min; n <= max; n++) lista.push(linha(financiado, n, n <= c.semJuros ? 0 : c.taxa, entrada));
    return { financiado, lista };
  }

  // Cartão de crédito: 1x a 6x sem juros; 7x a 12x com juros (a taxa de cada prazo, quando cadastrada).
  function cartao({ preco, garantia = 0, entrada = 0 }) {
    const c = CFG.cartao, financiado = preco + garantia - entrada, lista = [];
    if (financiado > 0) {
      for (let n = 1; n <= c.max; n++) {
        if (n <= c.semJuros) { lista.push(linha(financiado, n, 0, entrada)); continue; }
        const t = (c.taxas && c.taxas[n]) || c.taxa;
        lista.push(t ? linha(financiado, n, t, entrada) : { n, semTaxa: true });
      }
    }
    return { financiado, lista, faltaTaxa: lista.some(l => l.semTaxa) };
  }

  const api = { CFG, parseBRL, cents, brl, parcela, crediario, cartao };
  if (typeof module !== 'undefined') module.exports = api; else root.Simulador = api;
})(typeof self !== 'undefined' ? self : this);
