// Find bar (Ctrl+F / bus 'search:open'), whole-document text search through
// viewer.getTextContent, text-layer highlights and the "Search results" sidebar tab.
//
// A hit is { pageIndex, start, end, parts: [{ item, from, to }], snippet: {before, match, after},
// userX, userY } where `item` indexes the page's text items that have a `str` (the same index
// as pdf.js TextLayer.textDivs) and from/to are offsets inside that item's string.
// Emits 'search:changed' { tab, query, options, hits, current } after every change.
import { bus } from '../bus.js';
import { state, activeTab } from '../state.js';
import { h } from './dom.js';
import { icon } from './icons.js';
import { viewer } from './viewer.js';
import { dialogOpen, toast } from './dialogs.js';
import { annotations } from './annotations.js';
import { registerSidebarTab, showSidebarTab, refreshSidebarTab } from './sidebar.js';

const SNIPPET = 40;          // characters of context on each side
const results = new WeakMap(); // tab -> {query, options, hits, current, done}
const opts = { caseSensitive: false, wholeWord: false };
let bar = null;
let input = null;
let counter = null;
let gen = 0;
let debounce = 0;

export const search = { markAllForRedaction, open, close, run, next: () => step(1), prev: () => step(-1), goTo, getResults: (tab = activeTab()) => results.get(tab) ?? null, options: opts };

/** Build the find bar inside `host` (main.viewer-host) and register the Search results tab. */
export function initSearch(host) {
  input = h('input.find-input', { type: 'search', placeholder: 'Find in document', 'aria-label': 'Find in document', spellcheck: 'false' });
  counter = h('span.find-count', { 'aria-live': 'polite' });
  const toggle = (key, label, text) => {
    const b = h('button.find-toggle', { type: 'button', title: label, 'aria-label': label, 'aria-pressed': 'false', dataset: { opt: key } }, text);
    b.addEventListener('click', () => { opts[key] = !opts[key]; b.setAttribute('aria-pressed', String(opts[key])); run(input.value); input.focus(); });
    return b;
  };
  const small = (ic, label, fn, cls) => h(`button.find-btn${cls}`, { type: 'button', title: label, 'aria-label': label, html: icon(ic, 16), onclick: fn });
  bar = h('div.find-bar', { role: 'search', 'aria-label': 'Find', hidden: true },
    input,
    toggle('caseSensitive', 'Match case', 'Aa'),
    toggle('wholeWord', 'Whole words', 'W'),
    counter,
    small('prev', 'Previous match (Shift+Enter)', () => step(-1), '.find-prev'),
    small('next', 'Next match (Enter)', () => step(1), '.find-next'),
    small('close', 'Close (Esc)', () => close(), '.find-close'));
  host.append(bar);
  input.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(() => run(input.value), 250); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(debounce);
      const r = results.get(activeTab());
      if (!r || r.query !== input.value || r.options.caseSensitive !== opts.caseSensitive || r.options.wholeWord !== opts.wholeWord) run(input.value);
      else step(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  registerSidebarTab({ id: 'search', label: 'Search results', icon: 'search', render: renderList });
}

function open() {
  if (!bar || !activeTab()) return;
  bar.hidden = false;
  input.focus();
  input.select();
}

function close() {
  if (!bar) return;
  clearTimeout(debounce);
  gen++;
  bar.hidden = true;
  for (const tab of state.tabs) if (results.has(tab)) { results.delete(tab); unpaintAll(tab); }
  counter.textContent = '';
  emitChanged(activeTab());
  activeTab()?.view?.scrollEl.focus();
}

// ---------------------------------------------------------------- matching
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function buildRegex(query, o) {
  let src = escapeRe(query).replace(/\s+/g, '\\s+');
  if (o.wholeWord) src = `(?<![\\p{L}\\p{N}_])${src}(?![\\p{L}\\p{N}_])`;
  return new RegExp(src, `gu${o.caseSensitive ? '' : 'i'}`);
}

/** Join the page's text items; returns {text, starts, items} (starts[k] = offset of item k). */
function pageText(content) {
  const items = content.items.filter((it) => it.str !== undefined);
  const starts = [];
  let text = '';
  for (const it of items) {
    starts.push(text.length);
    text += it.str;
    if (it.hasEOL) text += '\n';    // virtual separator, belongs to no item
  }
  return { text, starts, items };
}

function itemAt(starts, offset) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
  return lo;
}

function findInPage(pageIndex, content, re) {
  const { text, starts, items } = pageText(content);
  const hits = [];
  re.lastIndex = 0;
  for (let m; (m = re.exec(text));) {
    if (!m[0].length) { re.lastIndex++; continue; }
    const start = m.index, end = start + m[0].length;
    const parts = [];
    for (let k = itemAt(starts, start); k < items.length && starts[k] < end; k++) {
      const from = Math.max(0, start - starts[k]);
      const to = Math.min(items[k].str.length, end - starts[k]);
      if (to > from) parts.push({ item: k, from, to });
    }
    if (!parts.length) continue;
    const it = items[parts[0].item];
    const clean = (s) => s.replace(/\s+/g, ' ');
    hits.push({
      pageIndex, start, end, parts,
      snippet: { before: clean(text.slice(Math.max(0, start - SNIPPET), start)), match: clean(m[0]), after: clean(text.slice(end, end + SNIPPET)) },
      userX: it.transform[4], userY: it.transform[5] + (it.height || Math.abs(it.transform[3]) || 0),
    });
  }
  return hits;
}

/** Search the whole active document for `query` with the current options. */
async function run(query, tab = activeTab()) {
  const my = ++gen;
  if (!tab) return;
  unpaintAll(tab);
  if (!query.trim()) { results.delete(tab); counter.textContent = ''; emitChanged(tab); return; }
  const re = buildRegex(query, opts);
  const r = { query, options: { ...opts }, hits: [], current: -1, done: false };
  results.set(tab, r);
  counter.textContent = 'Searching…';
  for (let i = 0; i < tab.numPages; i++) {
    let content;
    try { content = await viewer.getTextContent(tab, i); } catch { continue; }
    if (my !== gen || results.get(tab) !== r) return;
    r.hits.push(...findInPage(i, content, re));
  }
  r.done = true;
  if (!r.hits.length) { updateCounter(tab); emitChanged(tab); return; }
  // First hit on or after the current page.
  const k = r.hits.findIndex((x) => x.pageIndex >= tab.currentPage);
  for (const i of viewer.renderedPages(tab)) paint(tab, i);
  goTo(k < 0 ? 0 : k, tab);
}

function step(dir, tab = activeTab()) {
  const r = results.get(tab);
  if (!r?.hits.length) return;
  goTo((r.current + dir + r.hits.length) % r.hits.length, tab);
}

/** Make hit k current: highlight it and scroll it into view (rendering the page first). */
function goTo(k, tab = activeTab()) {
  const r = results.get(tab);
  if (!r?.hits[k]) return;
  const prev = r.hits[r.current];
  r.current = k;
  const hit = r.hits[k];
  if (prev && prev.pageIndex !== hit.pageIndex) paint(tab, prev.pageIndex);
  const ps = viewer.getPageState(tab, hit.pageIndex);
  if (ps?.textLayer) { paint(tab, hit.pageIndex); reveal(tab); }
  else { r.pendingReveal = true; viewer.scrollToPage(tab, hit.pageIndex, { userY: hit.userY }); }
  updateCounter(tab);
  emitChanged(tab);
}

function reveal(tab) {
  const r = results.get(tab);
  const hit = r?.hits[r.current];
  if (!hit) return;
  r.pendingReveal = false;
  const el = viewer.getPageEl(tab, hit.pageIndex)?.querySelector('.textLayer span.hl.current');
  if (el) el.scrollIntoView({ block: 'center', inline: 'nearest' });
  else viewer.scrollToPage(tab, hit.pageIndex, { userY: hit.userY });
}

function updateCounter(tab) {
  const r = results.get(tab);
  if (!counter) return;
  if (!r) counter.textContent = '';
  else if (!r.hits.length) counter.textContent = r.done ? 'No results' : 'Searching…';
  else counter.textContent = `${r.current + 1} of ${r.hits.length}`;
}

function emitChanged(tab) {
  const r = tab ? results.get(tab) : null;
  bus.emit('search:changed', { tab, query: r?.query ?? '', options: r?.options ?? { ...opts }, hits: r?.hits ?? [], current: r?.current ?? -1 });
}

// ---------------------------------------------------------------- text-layer highlights
function unpaintPage(tab, i) {
  const ps = viewer.getPageState(tab, i);
  const tl = ps?.textLayer;
  if (!tl || !ps.textLayerDiv) return;
  const strs = tl.textContentItemsStr;
  for (const div of ps.textLayerDiv.querySelectorAll('[data-hl-item]')) {
    div.textContent = strs[Number(div.dataset.hlItem)];
    delete div.dataset.hlItem;
  }
}
function unpaintAll(tab) { for (const i of viewer.renderedPages(tab)) unpaintPage(tab, i); }

/** (Re)apply the highlights of page i. Safe to call any time; a no-op without a text layer. */
function paint(tab, i) {
  const ps = viewer.getPageState(tab, i);
  const tl = ps?.textLayer;
  if (!tl) return;
  unpaintPage(tab, i);
  const r = results.get(tab);
  if (!r?.hits.length) return;
  const divs = tl.textDivs;
  const strs = tl.textContentItemsStr;
  const byItem = new Map();  // item -> [{from, to, current}]
  r.hits.forEach((hit, k) => {
    if (hit.pageIndex !== i) return;
    for (const p of hit.parts) {
      if (!byItem.has(p.item)) byItem.set(p.item, []);
      byItem.get(p.item).push({ from: p.from, to: p.to, current: k === r.current });
    }
  });
  for (const [item, segs] of byItem) {
    const div = divs[item];
    const str = strs[item];
    if (!div || str == null) continue;
    segs.sort((a, b) => a.from - b.from);
    const nodes = [];
    let pos = 0;
    for (const s of segs) {
      if (s.from < pos) continue;
      if (s.from > pos) nodes.push(document.createTextNode(str.slice(pos, s.from)));
      nodes.push(h(`span.hl${s.current ? '.current' : ''}`, {}, str.slice(s.from, s.to)));
      pos = s.to;
    }
    if (pos < str.length) nodes.push(document.createTextNode(str.slice(pos)));
    div.replaceChildren(...nodes);
    div.dataset.hlItem = String(item);
  }
}

// ---------------------------------------------------------------- mark all for redaction
/** Every hit of the tab -> redactMark objects in visible page space (points, y down), one per text item part. */
async function hitMarks(tab, hits) {
  const marks = [];
  const pages = [...new Set(hits.map((x) => x.pageIndex))];
  for (const i of pages) {
    const items = (await viewer.getTextContent(tab, i)).items.filter((it) => it.str !== undefined);
    const vp = tab.pages[i].getViewport({ scale: 1 });
    for (const hit of hits) {
      if (hit.pageIndex !== i) continue;
      for (const p of hit.parts) {
        const it = items[p.item];
        if (!it || !it.str.length) continue;
        const hgt = it.height || Math.abs(it.transform[3]) || 0;
        const x0 = it.transform[4] + it.width * (p.from / it.str.length), x1 = it.transform[4] + it.width * (p.to / it.str.length);
        const y0 = it.transform[5] - 0.2 * hgt, y1 = it.transform[5] + hgt; // a little below the baseline for descenders
        const a = vp.convertToViewportPoint(x0, y0), b = vp.convertToViewportPoint(x1, y1);
        const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]);
        marks.push({ type: 'redactMark', page: i, x, y, w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]), fill: '#000000' });
      }
    }
  }
  return marks;
}

/** Turn all hits of the tab's current search into redaction marks (one undoable step). */
async function markAllForRedaction(tab = activeTab()) {
  const r = tab ? results.get(tab) : null;
  if (!r?.hits.length) return 0;
  const marks = await hitMarks(tab, r.hits);
  if (!marks.length) return 0;
  annotations.addMany(tab, marks);
  toast(`${marks.length} area${marks.length === 1 ? '' : 's'} marked — use Document > Apply redactions to remove them`);
  return marks.length;
}

// ---------------------------------------------------------------- sidebar list
function renderList(container, tab) {
  const r = tab ? results.get(tab) : null;
  if (!r) { container.replaceChildren(h('p.sb-empty', {}, 'Press Ctrl+F to search this document')); return; }
  if (!r.hits.length) { container.replaceChildren(h('p.sb-empty', {}, r.done ? `No results for “${r.query}”` : 'Searching…')); return; }
  const list = h('ol.search-results', { 'aria-label': `${r.hits.length} results for ${r.query}` });
  r.hits.forEach((hit, k) => {
    const item = h('li', {}, h('button.search-hit', { type: 'button', 'aria-current': k === r.current ? 'true' : null, dataset: { hit: String(k) } },
      h('span.sh-page', {}, `Page ${hit.pageIndex + 1}`),
      h('span.sh-text', {}, hit.snippet.before, h('mark', {}, hit.snippet.match), hit.snippet.after)));
    list.append(item);
  });
  list.addEventListener('click', (e) => {
    const b = e.target.closest('.search-hit');
    if (b) goTo(Number(b.dataset.hit), tab);
  });
  const markAll = h('button.search-mark-all', { type: 'button', title: 'Mark every result for redaction' }, 'Mark all for redaction');
  markAll.addEventListener('click', () => { markAll.disabled = true; markAllForRedaction(tab).finally(() => { markAll.disabled = false; }); });
  container.replaceChildren(h('p.sb-summary', {}, `${r.hits.length} result${r.hits.length === 1 ? '' : 's'}`), markAll, list);
  container.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------- wiring
let lastShown = null;
bus.on('search:open', () => { open(); });
bus.on('search:changed', ({ tab, hits }) => {
  if (state.sidebarTab === 'search') {
    // Keep the list stable while stepping: only rebuild for a new result set.
    const list = document.querySelector('.search-results');
    const r = results.get(tab);
    if (list && r === lastShown && hits.length) {
      for (const b of list.querySelectorAll('.search-hit')) b.toggleAttribute('aria-current', Number(b.dataset.hit) === r.current);
      list.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest' });
    } else refreshSidebarTab('search');
    lastShown = r;
  } else if (hits.length && results.get(tab) !== lastShown) {
    lastShown = results.get(tab);
    showSidebarTab('search');
  }
});
bus.on('page:rendered', ({ tab, pageIndex }) => {
  const r = results.get(tab);
  if (!r?.hits.length) return;
  paint(tab, pageIndex);
  if (r.pendingReveal && r.hits[r.current]?.pageIndex === pageIndex) reveal(tab);
});
bus.on('tab:activated', ({ tab }) => {
  if (!bar || bar.hidden) return;
  if (!tab) { close(); return; }
  if (input.value.trim() && !results.has(tab)) run(input.value, tab);
  else { updateCounter(tab); emitChanged(tab); }
});
bus.on('tab:loaded', ({ tab, reloaded }) => {
  // Bytes changed (page operations, ...): old hits are stale; search the new document again.
  if (reloaded && results.has(tab)) { const q = results.get(tab).query; results.delete(tab); if (tab === activeTab() && bar && !bar.hidden) run(q, tab); else emitChanged(tab); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && bar && !bar.hidden && !dialogOpen() && !e.defaultPrevented) close();
});
