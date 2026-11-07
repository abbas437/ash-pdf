// Compare revisions (Tools > Compare revisions…): pure helpers of renderer/ui/comparerev.js.
// No DOM, no pdf.js, so test/comparerev-lib.test.js runs them in Node.
//   revisionKey(name)            -> [rank, value] of the revision named in a file name, or null
//   guessOrder(a, b)             -> [older, newer] of two {name} (revision in the name, else as given)
//   renderScale(wPt, hPt, dpi)   -> px per point at dpi, lowered so the canvas fits (CANVAS_LIMITS)
//   pagePairs(nOld, nNew, idx?)  -> [{index, older, newer}] page pairs by index (null: no such page)
//   pageLabel(p)                 -> "Page 5", "Page 5 (older 4)" or "Older page 4" (source page numbers)
//   pageSummary(p)               -> "Page 3 — 4 areas, text: +2 / −1"
//   diffRows(pages)              -> [[page, kind, item, text]] for Copy list / Export CSV
//   diffCsv(pages), diffText(pages)
import { csvCell } from './comments-lib.js';
// Same limits as CANVAS_LIMITS / fitsCanvas in compress.js (which needs the DOM): Chromium blanks a larger canvas.
const LIM = { area: 16384 * 16384, side: 32767 };
export const fitsCanvas = (w, h) => w > 0 && h > 0 && w <= LIM.side && h <= LIM.side && w * h <= LIM.area;

export const DPI_PRESETS = [100, 150, 200];
export const DEFAULT_OPTIONS = Object.freeze({ dpi: 150, align: true, text: true });

// Revision tokens, most specific first: "Rev.01", "Rev 1", "Rev-B", "R1", a trailing "_B" / "-B".
const PATTERNS = [/(?:^|[^a-z])rev(?:ision)?[\s._-]*([0-9]+|[a-z])(?![a-z])/i, /(?:^|[\s._-])r([0-9]+)(?![a-z0-9])/i, /[\s._-]([a-z])$/i];

/** [rank, value] of the revision in a file name: numbers rank by value, letters A < B < … */
export function revisionKey(name) {
  const base = String(name ?? '').replace(/\.pdf$/i, '').trim();
  for (const re of PATTERNS) {
    const m = base.match(re);
    if (m) return /^\d+$/.test(m[1]) ? [0, Number(m[1])] : [1, m[1].toUpperCase().charCodeAt(0)];
  }
  return null;
}

/** The older and the newer of two documents: by the revision in their names when both have one of the same kind and they differ, else in the order given. */
export function guessOrder(a, b) {
  const ka = revisionKey(a?.name), kb = revisionKey(b?.name);
  if (ka && kb && ka[0] === kb[0] && ka[1] !== kb[1]) return ka[1] < kb[1] ? [a, b] : [b, a];
  return [a, b];
}

/** Pixels per point for a page of wPt x hPt at `dpi`, reduced until the canvas fits. */
export function renderScale(wPt, hPt, dpi, fits = fitsCanvas) {
  let s = dpi / 72;
  const ok = () => fits(Math.ceil(wPt * s), Math.ceil(hPt * s));
  if (!ok()) s = Math.min(s, Math.sqrt(LIM.area / (wPt * hPt)) * 0.999, LIM.side / wPt, LIM.side / hPt);
  while (s > 0.01 && !ok()) s *= 0.95;
  return s;
}

/** Page pairs by index over max(nOld, nNew); `indices` (0-based) limits them. */
export function pagePairs(nOld, nNew, indices = null) {
  const n = Math.max(nOld, nNew);
  const want = indices ?? [...Array(n).keys()];
  return want.filter((i) => i >= 0 && i < n).map((i) => ({ index: i, older: i < nOld ? i : null, newer: i < nNew ? i : null }));
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** A page has changes when it has areas, text changes, or is in one revision only. */
export const hasChanges = (p) => p.status !== 'compared' || p.regions.length > 0 || p.text.added.length > 0 || p.text.removed.length > 0;

/**
 * The source page of a result: its newer page number, with the older one when they differ; "Older page n"
 * for a page in the older revision only. Without olderPage / newerPage (a reopened compare PDF), the
 * output page number (index + 1).
 */
export function pageLabel(p) {
  const { newerPage: n = null, olderPage: o = null } = p;
  if (n === null && o === null) return `Page ${p.index + 1}`;
  if (n === null) return `Older page ${o}`;
  return o === null || o === n ? `Page ${n}` : `Page ${n} (older ${o})`;
}

const num = (v) => v ?? '';

/** "Page 3 — 4 areas, text: +2 / −1" (see pageLabel for the page). */
export function pageSummary(p) {
  if (p.status === 'error') return `${pageLabel(p)} – not compared (${p.error || 'unknown error'})`;
  const head = `${pageLabel(p)} — `;
  if (p.status === 'added') return `${head}only in the newer revision`;
  if (p.status === 'removed') return `${head}only in the older revision`;
  const parts = [plural(p.regions.length, 'area')];
  if (p.text.added.length || p.text.removed.length) parts.push(`text: +${p.text.added.length} / −${p.text.removed.length}`);
  return head + parts.join(', ');
}

const KIND = (r) => (r.removed > 0 && r.removed >= 2 * (r.added || 0) ? 'removed' : r.added > 0 && r.added >= 2 * (r.removed || 0) ? 'added' : 'added and removed');
export const regionKind = KIND;

/**
 * Rows [newer page, older page, kind, item, text] of every changed page: one per area and one per text
 * phrase. Page cells are the source page numbers ('' when the page is not in that revision); without them
 * (a compare PDF not made by this app) the newer cell is the output page number and the older one is blank.
 */
export function diffRows(pages) {
  const rows = [];
  for (const p of pages.filter(hasChanges)) {
    const known = p.newerPage != null || p.olderPage != null;
    const pg = known ? [num(p.newerPage), num(p.olderPage)] : [p.index + 1, ''];
    if (p.status === 'error') rows.push([...pg, 'page', pageSummary(p), '']);
    else if (p.status !== 'compared') rows.push([...pg, 'page', p.status === 'added' ? 'Page only in the newer revision' : 'Page only in the older revision', '']);
    p.regions.forEach((r, k) => rows.push([...pg, 'area', `Change ${k + 1}: ${KIND(r)}`, '']));
    for (const t of p.text.added) rows.push([...pg, 'text added', `+ ${t.text}`, t.text]);
    for (const t of p.text.removed) rows.push([...pg, 'text removed', `− ${t.text}`, t.text]);
  }
  return rows;
}

/** UTF-8 CSV (with BOM, formula guard) of diffRows. */
export function diffCsv(pages) {
  const rows = [['Newer page', 'Older page', 'Kind', 'Item', 'Text'], ...diffRows(pages)];
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Plain-text list for the clipboard: a summary line per page, its items indented. */
export function diffText(pages) {
  const out = [];
  for (const p of pages.filter(hasChanges)) {
    out.push(pageSummary(p));
    p.regions.forEach((r, k) => out.push(`  Change ${k + 1}: ${KIND(r)}`));
    for (const t of p.text.added) out.push(`  + ${t.text}`);
    for (const t of p.text.removed) out.push(`  − ${t.text}`);
  }
  return out.length ? out.join('\n') : 'No differences found';
}
