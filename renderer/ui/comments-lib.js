// Pure helpers of comments.js (no DOM), unit-tested in test/comments.test.js.

export const TYPE_LABELS = {
  rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', arrow: 'Arrow', ink: 'Drawing', highlight: 'Highlight',
  text: 'Text box', callout: 'Callout', stamp: 'Stamp', image: 'Image', note: 'Sticky note', underline: 'Underline',
  strikeout: 'Strikeout', textHighlight: 'Text highlight', whiteout: 'Whiteout', squiggly: 'Squiggly',
};
export const STATUSES = ['accepted', 'rejected', 'cancelled', 'completed', 'none'];
export const STATUS_LABELS = { accepted: 'Accepted', rejected: 'Rejected', cancelled: 'Cancelled', completed: 'Completed', none: 'None' };

export const typeLabel = (t) => TYPE_LABELS[t] ?? t;

/** The text shown for an object: its comment, or the box's own text for text boxes and callouts. */
export function commentText(o) {
  if (o.type === 'text' || o.type === 'callout') return o.note || o.text || '';
  return o.note ?? (o.type === 'stamp' ? o.text ?? '' : '');
}

/** One list entry per object; `author` fills objects without one (not saved yet). */
export function toEntries(objects, author = '') {
  return objects.map((o, order) => ({
    id: o.id, order, page: o.page, type: o.type, author: o.author || author,
    date: o.modified || o.created || null, status: o.status || 'none', text: commentText(o),
    replies: (o.replies ?? []).map((r) => ({ ...r })),
  }));
}

/** filter = {type, author, status}; an empty value matches everything. */
export function filterEntries(entries, { type = '', author = '', status = '' } = {}) {
  return entries.filter((e) => (!type || e.type === type) && (!author || e.author === author) && (!status || e.status === status));
}

/** Entries whose comment text, reply text or author contains `query` (case-insensitive); blank matches all. */
export function searchEntries(entries, query = '') {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  const has = (s) => String(s ?? '').toLowerCase().includes(q);
  return entries.filter((e) => has(e.text) || has(e.author) || e.replies.some((r) => has(r.text)));
}

export const SORTS = { page: 'Page', date: 'Date (newest)', author: 'Author' };

/** A sorted copy: 'page' (page, then document order), 'date' (newest first; unsaved, undated entries
 *  are the newest so they come first) or 'author' (A-Z, case-insensitive; then page order). */
export function sortEntries(entries, by = 'page') {
  const byPage = (a, b) => a.page - b.page || a.order - b.order;
  const time = (e) => (e.date ? Date.parse(e.date) : Infinity);
  const cmp = by === 'date' ? (a, b) => time(b) - time(a) || byPage(a, b)
    : by === 'author' ? (a, b) => a.author.localeCompare(b.author, undefined, { sensitivity: 'base' }) || byPage(a, b)
      : byPage;
  return [...entries].sort((a, b) => cmp(a, b) || 0);
}

/** [{page, items}] by page number; items keep the document order. */
export function groupByPage(entries) {
  const pages = new Map();
  for (const e of [...entries].sort((a, b) => a.page - b.page || a.order - b.order)) {
    if (!pages.has(e.page)) pages.set(e.page, []);
    pages.get(e.page).push(e);
  }
  return [...pages].map(([page, items]) => ({ page, items }));
}

/** Distinct values of `key`, sorted, for the filter menus. */
export const distinct = (entries, key) => [...new Set(entries.map((e) => e[key]).filter(Boolean))].sort();

/** A CSV cell; cells starting with = + - @ (or tab/CR) get a leading ' so spreadsheets keep them text. */
export function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** UTF-8 CSV text (with BOM) of the entries: page (1-based), type, author, date, status, comment, replies. */
export function toCsv(entries) {
  const rows = [['page', 'type', 'author', 'date', 'status', 'comment', 'replies']];
  for (const e of entries) {
    rows.push([e.page + 1, typeLabel(e.type), e.author, e.date ?? '', STATUS_LABELS[e.status] ?? e.status, e.text,
      e.replies.map((r) => `${r.author}: ${r.text}`).join(' | ')]);
  }
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
