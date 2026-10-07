// Advanced search engine: pure text matching plus a MiniSearch page index. No DOM, no pdf.js
// import (callers pass pdf.js objects), so it runs under `node --test` (test/advsearch.test.js).
//
// opts = { mode: 'phrase'|'all'|'any', caseSensitive, wholeWords, stemming, proximity (N > 0:
// "all words" hits only where every word occurs within N words), regex (query is a regular
// expression), pattern: null|'email'|'phone'|'date'|'url'|'amount'|'custom', customPattern }.
// A pattern replaces the query. Words are runs of letters, marks and digits (\p{L}\p{M}\p{N}).
// Stemming implies word matching (it compares stems of whole words).
import MiniSearch from 'minisearch';

const W = '\\p{L}\\p{M}\\p{N}';
const WORD_RE = new RegExp(`[${W}]+`, 'gu');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?';

/** Built-in patterns (always case-insensitive). */
export const PATTERNS = {
  email: '[\\p{L}\\p{N}._%+-]+@[\\p{L}\\p{N}-]+(?:\\.[\\p{L}\\p{N}-]+)*\\.\\p{L}{2,}',
  phone: '(?<![\\p{N}+])(?:\\+\\d{1,3}[\\s.-]?)?(?:\\(\\d{1,4}\\)\\s?)?\\d{2,4}[\\s.-]\\d{3,4}(?:[\\s.-]\\d{3,4})?(?!\\p{N})',
  date: `(?<!\\p{N})(?:\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}|\\d{1,2}[-/.]\\d{1,2}[-/.](?:\\d{4}|\\d{2})|\\d{1,2}\\s+${MONTH},?\\s+\\d{4}|${MONTH}\\s+\\d{1,2},?\\s+\\d{4})(?!\\p{N})`,
  url: '(?:https?://|www\\.)[^\\s<>"\']*[^\\s<>"\'.,;:!?)\\]]',
  amount: '(?:[$€£¥₹]\\s?|\\b(?:USD|EUR|GBP|SAR|AED|JPY|INR)\\s?)\\d{1,3}(?:[,\\s]\\d{3})*(?:\\.\\d+)?|\\d{1,3}(?:,\\d{3})*(?:\\.\\d+)?\\s?(?:USD|EUR|GBP|SAR|AED|JPY|INR)\\b',
};

/**
 * Small English suffix stemmer (a subset of Porter step 1 plus a few endings), applied to words of
 * 4+ letters: -sses -> -ss, -ies/-ied -> -y, -es after s/x/z/ch/sh, -s (not -ss/-us/-is), -ing/-ed
 * when a vowel remains (then a doubled final consonant is undoubled), -ly, -ion(s) after t/s, and
 * finally a trailing -e. So hope/hopes/hoped/hoping -> "hop", connect/connection -> "connect".
 */
export function stem(word) {
  let w = word;
  if (w.length < 4) return w;
  const vowel = (s) => /[aeiouy]/.test(s);
  if (/sses$/.test(w)) w = w.slice(0, -2);
  else if (/ie[sd]$/.test(w)) w = w.slice(0, -3) + 'y';
  else if (/(s|x|z|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (/[^sui]s$/.test(w)) w = w.slice(0, -1);
  let m;
  if ((m = /^(.+?)(ing|ed)$/.exec(w)) && m[1].length >= 2 && vowel(m[1])) {
    w = m[1];
    if (/([^aeiouylsz])\1$/.test(w)) w = w.slice(0, -1);
  } else if ((m = /^(.+)ly$/.exec(w)) && m[1].length >= 3) w = m[1];
  else if ((m = /^(.+[ts])ions?$/.exec(w)) && m[1].length >= 3) w = m[1];
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

/** Words of `text` as [{word, start, end}]. */
export function tokenize(text) {
  return [...text.matchAll(WORD_RE)].map((m) => ({ word: m[0], start: m.index, end: m.index + m[0].length }));
}

const boundary = (src) => `(?<![${W}])(?:${src})(?![${W}])`;
const flagsOf = (o) => `gu${o.caseSensitive ? '' : 'i'}`;

/** Compile a query into a function text -> [{start, end}] (sorted, non-overlapping). Throws on a bad regex. */
export function compile(query, o = {}) {
  const re = (src, flags = flagsOf(o)) => {
    const r = new RegExp(o.wholeWords ? boundary(src) : src, flags);
    return (text) => [...text.matchAll(r)].filter((m) => m[0].length).map((m) => ({ start: m.index, end: m.index + m[0].length }));
  };
  if (o.pattern === 'custom') return re(o.customPattern ?? '');
  if (o.pattern) {
    if (!PATTERNS[o.pattern]) throw new Error(`Unknown pattern ${o.pattern}`);
    return re(PATTERNS[o.pattern], 'giu');
  }
  if (o.regex) return re(query);
  const words = query.match(WORD_RE) ?? [];
  const norm = (s) => (o.caseSensitive ? s : s.toLowerCase());
  if (!query.trim()) return () => [];
  if (o.mode !== 'all' && o.mode !== 'any') {
    if (!o.stemming) return re(query.trim().split(/\s+/).map(escapeRe).join('\\s+'));
    const want = words.map((w) => stem(norm(w)));
    return (text) => {
      const toks = tokenize(text), out = [];
      for (let i = 0; i + want.length <= toks.length && want.length; i++) {
        if (want.every((s, k) => stem(norm(toks[i + k].word)) === s)) { out.push({ start: toks[i].start, end: toks[i + want.length - 1].end }); i += want.length - 1; }
      }
      return out;
    };
  }
  const terms = o.stemming ? [...new Set(words.map((w) => stem(norm(w))))] : [...new Set(query.trim().split(/\s+/))];
  return (text) => {
    const toks = tokenize(text);
    const tokAt = (pos) => { let lo = 0, hi = toks.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (toks[m].start <= pos) lo = m; else hi = m - 1; } return lo; };
    const occ = []; // {start, end, term, tok}
    terms.forEach((t, term) => {
      if (o.stemming) toks.forEach((k, tok) => { if (stem(norm(k.word)) === t) occ.push({ start: k.start, end: k.end, term, tok }); });
      else for (const h of re(escapeRe(t))(text)) occ.push({ ...h, term, tok: tokAt(h.start) });
    });
    occ.sort((a, b) => a.start - b.start || b.end - a.end);
    if (o.mode === 'all' && new Set(occ.map((x) => x.term)).size < terms.length) return [];
    if (o.mode === 'all' && o.proximity > 0) return windows(occ, terms.length, o.proximity);
    const out = [];
    for (const x of occ) if (!out.length || x.start >= out.at(-1).end) out.push({ start: x.start, end: x.end });
    return out;
  };
}

/** Non-overlapping minimal spans containing every term, at most `n` words apart (first to last). */
function windows(occ, nTerms, n) {
  const out = [];
  const count = new Map();
  let left = 0;
  for (let right = 0; right < occ.length; right++) {
    count.set(occ[right].term, (count.get(occ[right].term) ?? 0) + 1);
    while (count.size === nTerms) {
      const l = occ[left];
      if (occ[right].tok - l.tok <= n) {
        out.push({ start: l.start, end: occ[right].end });
        count.clear(); left = right + 1; break;
      }
      if (count.get(l.term) === 1) count.delete(l.term); else count.set(l.term, count.get(l.term) - 1);
      left++;
    }
  }
  return out;
}

/** Join pdf.js text items: '\n' at EOL or a line change, ' ' where a visible gap separates items. */
export function joinItems(items) {
  let text = '', prev = null;
  for (const it of items) {
    if (it.str === undefined) continue;
    if (prev) {
      const hgt = Math.abs(prev.height || prev.transform?.[3] || 10);
      if (prev.hasEOL) { if (!text.endsWith('\n')) text += '\n'; }
      else if (prev.transform && it.transform && Math.abs(prev.transform[5] - it.transform[5]) > hgt * 0.5) text += '\n';
      else if (prev.transform && it.transform && it.transform[4] - (prev.transform[4] + (prev.width ?? 0)) > hgt * 0.15
        && !/\s$/.test(text) && !/^\s/.test(it.str)) text += ' ';
    }
    text += it.str;
    prev = it;
  }
  return text;
}

/** Snippet around [start, end) with `ctx` characters of context, whitespace collapsed. */
export function snippet(text, start, end, ctx = 40) {
  const c = (s) => s.replace(/\s+/g, ' ');
  return { before: c(text.slice(Math.max(0, start - ctx), start)), match: c(text.slice(start, end)), after: c(text.slice(end, end + ctx)) };
}

/** Search page texts: returns [{page, start, end, snippet, kind: 'text'}] (page 0-based). */
export function searchPages(pages, match) {
  const hits = [];
  pages.forEach((text, page) => { for (const m of match(text)) hits.push({ page, ...m, kind: 'text', snippet: snippet(text, m.start, m.end) }); });
  return hits;
}

/**
 * Search an extracted document {pages, annots?, bookmarks?} (see extractDoc). Page text hits come
 * first; with o.annotations, hits in annotation contents (kind 'annotation', annots[page] = contents
 * joined by newlines); with o.bookmarks, hits in outline titles (kind 'bookmark', page = target page
 * or 0 when the outline item has no page destination). Sorted by page, then kind order above.
 */
export function searchDoc(doc, match, o = {}) {
  const hits = searchPages(doc.pages, match);
  const extra = (kind, texts) => texts.forEach(([page, text]) => {
    for (const m of match(text)) hits.push({ page, ...m, kind, snippet: snippet(text, m.start, m.end) });
  });
  if (o.annotations && doc.annots) extra('annotation', doc.annots.map((t, p) => [p, t]).filter(([, t]) => t));
  if (o.bookmarks && doc.bookmarks) extra('bookmark', doc.bookmarks.map((b) => [b.page ?? 0, b.title]));
  const rank = { text: 0, annotation: 1, bookmark: 2 };
  return hits.sort((a, b) => a.page - b.page || rank[a.kind] - rank[b.kind] || a.start - b.start);
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Page texts of a loaded pdf.js document, yielding to the event loop between pages. null if cancelled. */
export async function extractPages(pdfDoc, { isCancelled = () => false } = {}) {
  const pages = [];
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    if (isCancelled()) return null;
    const page = await pdfDoc.getPage(i);
    pages.push(joinItems((await page.getTextContent()).items));
    page.cleanup();
    await tick();
  }
  return pages;
}

/** Annotation contents per page (pdf.js getAnnotations; Link and Widget annotations skipped). */
export async function extractAnnots(pdfDoc, { isCancelled = () => false } = {}) {
  const annots = [];
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    if (isCancelled()) return null;
    let list = [];
    try { list = await (await pdfDoc.getPage(i)).getAnnotations({ intent: 'display' }); } catch { /* damaged page */ }
    annots.push(list.filter((a) => a.subtype !== 'Link' && a.subtype !== 'Widget')
      .map((a) => a.contentsObj?.str || a.contents || '').filter(Boolean).join('\n'));
  }
  return annots;
}

/** Outline titles, depth first, as [{title, page}] (page 0-based, null when it has no page destination). */
export async function extractBookmarks(pdfDoc) {
  const out = [];
  const pageOf = async (dest) => {
    try {
      const d = typeof dest === 'string' ? await pdfDoc.getDestination(dest) : dest;
      if (!Array.isArray(d)) return null;
      return typeof d[0] === 'number' ? d[0] : await pdfDoc.getPageIndex(d[0]);
    } catch { return null; }
  };
  const walk = async (items) => { for (const it of items ?? []) { out.push({ title: it.title ?? '', page: await pageOf(it.dest) }); await walk(it.items); } };
  try { await walk(await pdfDoc.getOutline()); } catch { /* no or damaged outline */ }
  return out;
}

/** {pages, annots, bookmarks} of a loaded pdf.js document; null if cancelled. */
export async function extractDoc(pdfDoc, { isCancelled = () => false, annotations = true, bookmarks = true } = {}) {
  const pages = await extractPages(pdfDoc, { isCancelled });
  if (!pages) return null;
  const annots = annotations ? await extractAnnots(pdfDoc, { isCancelled }) : null;
  if (annotations && !annots) return null;
  return { pages, annots, bookmarks: bookmarks ? await extractBookmarks(pdfDoc) : null };
}

// ---------------------------------------------------------------- index
// Stored per folder (api.cacheSet) as JSON {v, files: {path: {mtimeMs, size, name, pages: [text], annots, bookmarks}}, mini}.
// MiniSearch narrows word queries to candidate pages; exact hits always come from searchPages on the
// stored text, so indexed and live searches return the same hits.
const INDEX_V = 2;
const MS_OPTS = { idField: 'id', fields: ['text'], tokenize: (s) => s.match(WORD_RE) ?? [], processTerm: (t) => stem(t.toLowerCase()) };
export const indexKey = (folder, recursive) => `advsearch:${INDEX_V}:${recursive ? 'r' : 'n'}:${folder}`;

export function loadIndex(json) {
  try {
    const d = JSON.parse(json);
    if (d?.v === INDEX_V) return { files: d.files, mini: MiniSearch.loadJSON(JSON.stringify(d.mini), MS_OPTS) };
  } catch { /* corrupt cache: rebuild */ }
  return { files: {}, mini: new MiniSearch(MS_OPTS) };
}
export const saveIndex = (idx) => JSON.stringify({ v: INDEX_V, files: idx.files, mini: idx.mini });

/** Bring idx up to date with `list` ([{path, name, size, mtimeMs}]); extract(file) -> {pages, annots, bookmarks}|null (null = cancelled). Returns #re-extracted. */
export async function updateIndex(idx, list, extract, onProgress = () => {}) {
  const ids = (path, f) => f.pages.map((_, p) => `${path}\u0000${p}`);
  const live = new Set(list.map((f) => f.path));
  for (const [path, f] of Object.entries(idx.files)) {
    if (!live.has(path)) { idx.mini.discardAll(ids(path, f)); delete idx.files[path]; }
  }
  let changed = 0;
  for (const [k, file] of list.entries()) {
    onProgress(k, list.length);
    const old = idx.files[file.path];
    if (old && old.mtimeMs === file.mtimeMs && old.size === file.size) continue;
    const doc = await extract(file);
    if (doc === null) return null; // cancelled
    if (old) idx.mini.discardAll(ids(file.path, old));
    idx.files[file.path] = { mtimeMs: file.mtimeMs, size: file.size, name: file.name, ...doc };
    idx.mini.addAll(doc.pages.map((text, page) => ({ id: `${file.path}\u0000${page}`, text })));
    changed++;
  }
  return changed;
}

/** Search an index: [{path, name, mtimeMs, hits}] for files with hits. */
export function searchIndex(idx, query, o, match = compile(query, o)) {
  let cand = null;
  if (!o.pattern && !o.regex && (o.wholeWords || o.stemming) && query.trim()) {
    cand = new Set(idx.mini.search(query, { combineWith: o.mode === 'any' ? 'OR' : 'AND', prefix: false, fuzzy: false }).map((r) => r.id));
  }
  const out = [];
  for (const [path, f] of Object.entries(idx.files)) {
    const pages = f.pages.map((t, p) => (!cand || cand.has(`${path}\u0000${p}`) ? t : ''));
    const hits = searchDoc({ ...f, pages }, match, o);
    if (hits.length) out.push({ path, name: f.name, mtimeMs: f.mtimeMs, hits });
  }
  return out;
}

/** CSV (RFC 4180, CRLF, UTF-8 BOM) of results [{name, path, hits}]: file, path, page (1-based), snippet. */
export function toCsv(results) {
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection guard
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [['file', 'path', 'page', 'snippet']];
  for (const r of results) for (const h of r.hits) rows.push([r.name, r.path ?? '', h.page + 1, h.snippet.before + h.snippet.match + h.snippet.after]);
  return '﻿' + rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
