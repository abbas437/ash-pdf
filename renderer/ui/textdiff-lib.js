// Compare revisions: text changes between two revisions of a page (words added and removed, with
// where they are). Pure: no DOM, no pdf.js, so test/textdiff-lib.test.js runs it in Node.
//
//   viewportTransform(view, rotate)   -> [a b c d e f]: PDF user space -> displayed page, top-left
//       origin, y down, in points. Same matrix as pdf.js page.getViewport({scale: 1}).transform for
//       a page with page.view = view and page.rotate = rotate (0/90/180/270).
//   pageWords(items, view, rotate)    -> [{text, box: {x, y, w, h}, line}] in reading order
//       items: table-extract.js textItems(content) ({str, x, y, w, size}, baseline start in PDF user
//       space), or raw pdf.js getTextContent() items ({str, transform, width}); with a transform the
//       text direction comes from it (rotated text), otherwise text runs along +x of user space.
//       box: top-left points of the displayed page (crop-box offset and /Rotate applied); a glyph
//       spans 0.8 x size above the baseline and 0.2 x size below. line: index of the word's line.
//   diffWords(oldWords, newWords, opts?) -> {added: [{text, box}], removed: [{text, box}], fallback}
//       oldWords / newWords: pageWords() of the older and the newer revision. added boxes are in the
//       newer page's frame; removed boxes in the older page's frame, moved by opts.shiftPt.
//   textChangesSummary(diff, n = 5)   -> {added, removed, addedWords, removedWords, first, more}
//
// Words. Items are grouped into lines in the displayed page's frame: items whose baselines run the
// same way (to the degree) and lie within LINE_TOL x size of the line's first baseline, lines top to
// bottom, items along the line left to right (for upright text). Consecutive items of a line closer
// than JOIN_GAP x size are one run of text (pdf.js splits words across items at font or kerning
// changes); a larger gap is a space. Runs split on whitespace into words; each character gets an
// equal share of its item's width (right to left in an item whose first strong character is RTL).
//
// Diff. Each word's key: Unicode NFKC, whitespace collapsed, sentence punctuation (. , ; : ! ? and
// Arabic ، ؛ ؟) stripped from its end and brackets / quotes from both ends, lower-cased only with
// caseSensitive: false (default true: "DN100" vs "dn100" is a change). Words that are punctuation
// only ("-", "/", "...") are left out. Keys are diffed with Myers' O(ND) algorithm; a hunk whose
// removed and added keys concatenate to the same string ("DN 100" vs "DN100") is not a change.
// Above maxWords (default 5000) words on either page, or more than MAX_D edits, a multiset
// difference is used instead (fallback: true): for each key, the occurrences beyond the other
// page's count are changes, chosen by matching the rest in order to the other page's occurrences
// with the least total reading-order index distance; positions are kept, order is not compared.
// Changed words next to each other in reading order on the same line merge into one phrase: text
// joined by spaces, box the union of the words' boxes.
//
// shiftPt {dx, dy} (points, top-left, y down): how far the newer page's content moved relative to the
// older one; removed boxes are moved by +dx, +dy so they land in the newer page's frame, where the
// overlay is drawn. From compare-lib.js: comparePages(...).shift is the same thing in pixels at the
// render scale (b's content is a's moved by (dx, dy)), so shiftPt = {dx: shift.dx / scale,
// dy: shift.dy / scale}.

const LINE_TOL = 0.5;   // x font size: baselines this close are one line
const JOIN_GAP = 0.1;   // x font size: items closer than this along a line are one run of text
const ASCENT = 0.8, DESCENT = 0.2; // x font size: glyph box above / below the baseline
const MAX_D = 2000;     // edits: Myers' trace grows with D^2, so beyond this the multiset fallback runs
const DP_CELLS = 2e7;   // multiset fallback: largest occurrence-matching table per key
const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const STRONG = /[\p{L}]/u;

export function viewportTransform(view, rotate = 0) {
  const [x0, y0, x1, y1] = view;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const [A, B, C, D] = { 90: [0, 1, 1, 0], 180: [-1, 0, 0, 1], 270: [0, -1, -1, 0] }[((rotate % 360) + 360) % 360] ?? [1, 0, 0, -1];
  const [ox, oy] = A === 0 ? [Math.abs(cy - y0), Math.abs(cx - x0)] : [Math.abs(cx - x0), Math.abs(cy - y0)];
  return [A, B, C, D, ox - A * cx - C * cy, oy - B * cx - D * cy];
}

/** One item -> {str, ox, oy (display baseline start), ux, uy (display direction), w, size}. */
function displayItem(it, M) {
  let x, y, dx = 1, dy = 0, size, w;
  if (it.transform) {
    const [a, b, c, d] = it.transform;
    [x, y] = [it.transform[4], it.transform[5]];
    const len = Math.hypot(a, b) || 1;
    [dx, dy] = [a / len, b / len];
    size = Math.hypot(c, d) || len;
    w = it.width ?? 0;
  } else ({ x, y, w = 0, size = 1 } = it);
  const ux = M[0] * dx + M[2] * dy, uy = M[1] * dx + M[3] * dy;
  const ul = Math.hypot(ux, uy) || 1;
  return { str: it.str, ox: M[0] * x + M[2] * y + M[4], oy: M[1] * x + M[3] * y + M[5], ux: ux / ul, uy: uy / ul, w, size: size || 1 };
}

export function pageWords(items, view, rotate = 0) {
  const M = viewportTransform(view, rotate);
  const groups = new Map(); // direction (whole degrees) -> items
  for (const it of items ?? []) {
    if (typeof it.str !== 'string' || !it.str.trim() || (it.transform === undefined && it.x === undefined)) continue;
    const d = displayItem(it, M);
    const deg = ((Math.round(Math.atan2(d.uy, d.ux) * 180 / Math.PI) % 360) + 360) % 360;
    if (!groups.has(deg)) groups.set(deg, []);
    groups.get(deg).push(d);
  }
  const words = [];
  let line = 0;
  for (const deg of [...groups.keys()].sort((p, q) => p - q)) {
    const t = deg * Math.PI / 180, ux = Math.cos(t), uy = Math.sin(t), nx = -uy, ny = ux; // n: "down" of the text
    const its = groups.get(deg).map((d) => ({ ...d, along: d.ox * ux + d.oy * uy, perp: d.ox * nx + d.oy * ny }));
    its.sort((p, q) => p.perp - q.perp || p.along - q.along);
    const lines = [];
    for (const it of its) {
      const cur = lines[lines.length - 1];
      if (cur && Math.abs(it.perp - cur.perp) <= LINE_TOL * Math.max(it.size, cur.size)) cur.items.push(it);
      else lines.push({ perp: it.perp, size: it.size, items: [it] });
    }
    for (const ln of lines) {
      ln.items.sort((p, q) => p.along - q.along);
      // Characters of the line with their along-the-line extent; null = a space between items.
      const chars = [];
      let prevEnd = null;
      for (const it of ln.items) {
        if (prevEnd !== null && it.along - prevEnd >= JOIN_GAP * it.size) chars.push(null);
        const cs = Array.from(it.str), k = cs.length, step = it.w / k;
        const rtl = RTL.test(cs.find((c) => STRONG.test(c)) ?? '');
        cs.forEach((c, i) => {
          const j = rtl ? k - 1 - i : i;
          chars.push({ c, a0: it.along + j * step, a1: it.along + (j + 1) * step, it });
        });
        prevEnd = Math.max(prevEnd ?? -Infinity, it.along + it.w);
      }
      let run = [];
      const flush = () => {
        if (!run.length) return;
        let a0 = Infinity, a1 = -Infinity, p0 = Infinity, p1 = -Infinity;
        for (const ch of run) {
          a0 = Math.min(a0, ch.a0); a1 = Math.max(a1, ch.a1);
          p0 = Math.min(p0, ch.it.perp - ASCENT * ch.it.size); p1 = Math.max(p1, ch.it.perp + DESCENT * ch.it.size);
        }
        const xs = [], ys = [];
        for (const a of [a0, a1]) for (const p of [p0, p1]) { xs.push(a * ux + p * nx); ys.push(a * uy + p * ny); }
        const x = Math.min(...xs), y = Math.min(...ys);
        words.push({ text: run.map((ch) => ch.c).join(''), box: { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }, line });
        run = [];
      };
      for (const ch of chars) {
        if (ch === null || /\s/u.test(ch.c)) flush();
        else run.push(ch);
      }
      flush();
      line++;
    }
  }
  return words;
}

const PUNCT_ONLY = /^[\p{P}\s]*$/u;
const EDGE = /^[\p{Ps}\p{Pe}\p{Pi}\p{Pf}"']+|[\p{Ps}\p{Pe}\p{Pi}\p{Pf}"'.,;:!?،؛؟]+$/gu;

/** Comparison key of a word, or null for a word that is punctuation only. */
export function wordKey(text, { caseSensitive = true } = {}) {
  let s = text.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (PUNCT_ONLY.test(s)) return null;
  s = s.replace(EDGE, '');
  return caseSensitive ? s : s.toLowerCase();
}

/** Myers' O(ND) diff of two key arrays -> ops [[type, i, j]] ('=', '-' a[i], '+' b[j]), or null past maxD. */
function myers(a, b, maxD) {
  const n = a.length, m = b.length, max = n + m, off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  let D = -1;
  for (let d = 0; d <= max && D < 0; d++) {
    if (d > maxD) return null;
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { D = d; break; }
    }
  }
  const ops = [];
  let x = n, y = m;
  for (let d = D; d > 0; d--) {
    const V = trace[d], get = (k) => V[k + d + 1];
    const k = x - y;
    const prevK = (k === -d || (k !== d && get(k - 1) < get(k + 1))) ? k + 1 : k - 1;
    const px = get(prevK), py = px - prevK;
    while (x > px && y > py) ops.push(['=', --x, --y]);
    if (prevK === k + 1) ops.push(['+', x, --y]);
    else ops.push(['-', --x, y]);
  }
  while (x > 0 && y > 0) ops.push(['=', --x, --y]);
  return ops.reverse();
}

/** Indices (into a and b) of changed keys, by Myers with whitespace-only hunks dropped. */
function changedBySequence(a, b, maxD) {
  let p = 0, s = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const ops = myers(a.slice(p, a.length - s), b.slice(p, b.length - s), maxD);
  if (!ops) return null;
  const del = [], ins = [];
  let hd = [], hi = [];
  const close = () => {
    if (hd.map((i) => a[i]).join('') !== hi.map((j) => b[j]).join('')) { del.push(...hd); ins.push(...hi); }
    hd = []; hi = [];
  };
  for (const [t, i, j] of ops) {
    if (t === '=') close();
    else if (t === '-') hd.push(i + p);
    else hi.push(j + p);
  }
  close();
  return { del, ins };
}

/** Elements of L (sorted indices) left over when every element of the shorter S is matched to one of
 *  L in order, minimising the total index distance (O(|S| |L|); past DP_CELLS, the last ones). */
function unmatched(S, L) {
  const s = S.length, l = L.length;
  if (!s) return L;
  if (s * l > DP_CELLS) return L.slice(s);
  const take = new Uint8Array((s + 1) * (l + 1));
  let prev = new Float64Array(l + 1);
  for (let i = 1; i <= s; i++) {
    const cur = new Float64Array(l + 1).fill(Infinity);
    for (let j = i; j <= l; j++) {
      const match = prev[j - 1] + Math.abs(S[i - 1] - L[j - 1]), skip = j > i ? cur[j - 1] : Infinity;
      if (match <= skip) { cur[j] = match; take[i * (l + 1) + j] = 1; } else cur[j] = skip;
    }
    prev = cur;
  }
  const out = [];
  let i = s, j = l;
  while (j > 0) {
    if (i > 0 && take[i * (l + 1) + j]) i--;
    else out.push(L[j - 1]);
    j--;
  }
  return out.reverse();
}

/** For each key, the occurrences beyond the other side's count, chosen by nearest reading-order index. */
function changedByMultiset(a, b) {
  const at = (keys) => {
    const m = new Map();
    keys.forEach((k, i) => { if (!m.has(k)) m.set(k, []); m.get(k).push(i); });
    return m;
  };
  const A = at(a), B = at(b), del = [], ins = [];
  for (const [k, P] of A) {
    const Q = B.get(k) ?? [];
    if (P.length > Q.length) del.push(...unmatched(Q, P));
    else if (Q.length > P.length) ins.push(...unmatched(P, Q));
  }
  for (const [k, Q] of B) if (!A.has(k)) ins.push(...Q);
  return { del, ins };
}

const union = (bs) => {
  const x0 = Math.min(...bs.map((b) => b.x)), y0 = Math.min(...bs.map((b) => b.y));
  return { x: x0, y: y0, w: Math.max(...bs.map((b) => b.x + b.w)) - x0, h: Math.max(...bs.map((b) => b.y + b.h)) - y0 };
};

/** Changed sequence indices -> phrases (runs of consecutive indices on one line). */
function phrases(words, idx, changed) {
  const out = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const span = words.slice(idx[run[0]], idx[run[run.length - 1]] + 1); // keeps punctuation words between
    out.push({ text: span.map((w) => w.text).join(' '), box: union(span.map((w) => w.box)) });
    run = [];
  };
  for (const i of [...changed].sort((p, q) => p - q)) {
    const last = run[run.length - 1];
    if (last !== undefined && (i !== last + 1 || words[idx[i]].line !== words[idx[last]].line)) flush();
    run.push(i);
  }
  flush();
  return out;
}

export function diffWords(oldWords, newWords, { caseSensitive = true, shiftPt = null, maxWords = 5000 } = {}) {
  const seq = (words) => {
    const keys = [], idx = [];
    words.forEach((w, i) => { const k = wordKey(w.text, { caseSensitive }); if (k !== null) { keys.push(k); idx.push(i); } });
    return { keys, idx };
  };
  const A = seq(oldWords), B = seq(newWords);
  let ch = (A.keys.length > maxWords || B.keys.length > maxWords) ? null : changedBySequence(A.keys, B.keys, MAX_D);
  const fallback = !ch;
  if (fallback) ch = changedByMultiset(A.keys, B.keys);
  const removed = phrases(oldWords, A.idx, ch.del);
  if (shiftPt && (shiftPt.dx || shiftPt.dy)) for (const r of removed) r.box = { ...r.box, x: r.box.x + (shiftPt.dx || 0), y: r.box.y + (shiftPt.dy || 0) };
  return { added: phrases(newWords, B.idx, ch.ins), removed, fallback };
}

export function textChangesSummary(diff, n = 5) {
  const count = (ps) => ps.reduce((s, p) => s + p.text.split(/\s+/u).filter(Boolean).length, 0);
  const all = [...diff.added.map((p) => ({ kind: 'added', ...p })), ...diff.removed.map((p) => ({ kind: 'removed', ...p }))]
    .sort((p, q) => Math.round(p.box.y + p.box.h) - Math.round(q.box.y + q.box.h) || p.box.x - q.box.x);
  return {
    added: diff.added.length, removed: diff.removed.length,
    addedWords: count(diff.added), removedWords: count(diff.removed),
    first: all.slice(0, n), more: Math.max(0, all.length - n),
  };
}
