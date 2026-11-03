// Converte o texto lido pelo OCR (linhas) em registros {nce, nome, qtd, preco, raw}
(function (root) {
  const PRICE = /(?:R\$\s*)?(\d{1,3}(?:\.\d{3})+,\d{2}|\d+[.,]\d{2})(?!\d)/g;

  // corrige confusões comuns do OCR dentro de tokens numéricos
  function fixDigits(s) {
    return s.replace(/[Oo]/g, '0').replace(/[lIi|]/g, '1').replace(/S/g, '5').replace(/B/g, '8');
  }

  function findCode(line) {
    // 1) depois de "nce"
    let m = line.match(/n\s*c\s*e\W{0,3}([0-9OolIiSB]{6})(?![0-9])/i);
    if (m) return { code: fixDigits(m[1]), text: m[0] };
    // 2) qualquer número isolado de 6 dígitos
    m = line.match(/(?<![0-9.,])(\d{6})(?![0-9]|[.,]\d)/);
    if (m) return { code: m[1], text: m[1] };
    return null;
  }

  function parseLine(line) {
    line = line.replace(/\s+/g, ' ').trim();
    if (!line) return null;
    const c = findCode(line);
    if (!c) return null;
    let rest = line.replace(c.text, ' ');

    let preco = '';
    const prices = [...rest.matchAll(PRICE)];
    if (prices.length) {
      const p = prices[prices.length - 1];
      preco = p[1].replace('.', ',') === p[1] ? p[1] : p[1];
      rest = rest.slice(0, p.index) + ' ' + rest.slice(p.index + p[0].length);
    }

    let qtd = '';
    const q = rest.match(/(?:^|\s)(\d{1,4})(?=\s|$)/);
    if (q) {
      qtd = q[1];
      rest = rest.replace(q[0], ' ');
    }

    const nome = rest.replace(/[|_\[\]{}]+/g, ' ').replace(/\s+/g, ' ').trim();
    return { nce: c.code, nome, qtd, preco, raw: line };
  }

  function parseLines(lines) {
    const out = [];
    for (const l of lines) {
      const r = parseLine(l);
      if (r) { out.push(r); continue; }
      // linha sem código: continuação do nome do produto anterior
      const t = l.replace(/\s+/g, ' ').trim();
      if (out.length && /[A-Za-zÀ-ú]{3,}/.test(t) && !/\d{4,}/.test(t) && t.length < 60 &&
          !/c[oó]d|produto|descri|\bqtd|quant|pre[cç]o|valor|folha|p[aá]gina/i.test(t)) {
        const prev = out[out.length - 1];
        prev.nome = (prev.nome + ' ' + t).trim();
      }
    }
    return out;
  }

  const api = { parseLine, parseLines };
  if (typeof module !== 'undefined') module.exports = api; else root.Parser = api;
})(typeof self !== 'undefined' ? self : this);
