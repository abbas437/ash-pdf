// Help search (pure, no DOM; shared by the in-app Help window and the website build).
//   tokens('Add a text box') → ['add', 'a', 'text', 'box']
//   indexEntry({id, title, keywords, text}) → {id, t, k, x}   (token lists: title, keywords, body text)
//   searchHelp(index, 'text box', {limit}) → [{id, score}] best first
// Ranking: a query word found in the title outweighs one in the keywords, which outweighs one in the
// body text; a whole-word match outweighs a prefix match; every query word must match somewhere.
// Copied unchanged into other ASH apps with help-engine.js.

export const tokens = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(Boolean);

export function indexEntry({ id, title, keywords = [], text = '' }) {
  return { id, t: tokens(title), k: [...new Set(keywords.flatMap(tokens))], x: [...new Set(tokens(text))] };
}

const W = { t: 10, k: 5, x: 1 };

function fieldScore(list, q) {
  let best = 0;
  for (const w of list) {
    if (w === q) return 1;
    if (w.startsWith(q)) best = 0.6;
  }
  return best;
}

export function searchHelp(index, query, { limit = 20 } = {}) {
  const qs = tokens(query);
  if (!qs.length) return [];
  const out = [];
  for (const e of index) {
    let score = 0;
    let all = true;
    for (const q of qs) {
      const s = W.t * fieldScore(e.t, q) + W.k * fieldScore(e.k, q) + W.x * fieldScore(e.x, q);
      if (!s) { all = false; break; }
      score += s;
    }
    if (all) {
      // the whole query as a phrase in the title: a strong hint it is the topic meant
      if (qs.length > 1 && e.t.join(' ').includes(qs.join(' '))) score += W.t;
      out.push({ id: e.id, score });
    }
  }
  return out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1)).slice(0, limit);
}
