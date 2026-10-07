// Advanced search panel (Edit > Advanced Search…, Ctrl+Shift+F): search the current document, all
// open documents or every PDF in a folder (optionally through a saved index), results grouped by
// file, click to open at the page, export to CSV. Matching lives in advsearch-engine.js.
import { state, activeTab } from '../state.js';
import { h } from './dom.js';
import { viewer } from './viewer.js';
import { search } from './search.js';
import { dialogOpen, showError, toast } from './dialogs.js';
import { registerSidebarTab, showSidebarTab } from './sidebar.js';
import { compile, searchDoc, extractDoc, extractAnnots, extractBookmarks, joinItems, loadIndex, saveIndex, updateIndex, searchIndex, indexKey, toCsv } from './advsearch-engine.js';

const api = window.api;
const VENDOR = new URL('./vendor/pdfjs/', document.baseURI).href;
const yieldUi = () => new Promise((r) => setTimeout(r, 0));
const MAX_SHOWN = 5000; // hits rendered in the panel (CSV export has all)
const KIND = { annotation: ' · comment', bookmark: ' · bookmark', text: '' };
let app = null;
let panel = null;
let job = null;          // {cancelled}
let results = [];        // [{name, path, tabId, mtimeMs, hits}]
let folder = null;
const els = {};

export function initAdvancedSearch(appRef) {
  app = appRef;
  const opt = (id, label) => h('label.as-opt', {}, (els[id] = h('input', { type: 'checkbox', dataset: { as: id } })), ' ', label);
  const sel = (id, pairs) => (els[id] = h('select.input', { dataset: { as: id } }, pairs.map(([v, t]) => h('option', { value: v }, t))));
  els.query = h('input.input.as-query', { type: 'search', placeholder: 'Search for…', 'aria-label': 'Search for', dataset: { as: 'query' } });
  els.folderLabel = h('span.as-folder', {}, 'No folder chosen');
  els.progress = h('progress.as-progress', { max: 1, value: 0, hidden: true });
  els.status = h('p.sb-summary.as-status', { 'aria-live': 'polite' });
  els.list = h('div.as-results');
  els.proxN = h('input.input.as-num', { type: 'number', min: '1', max: '1000', value: '10', 'aria-label': 'Within N words', dataset: { as: 'proxN' } });
  els.custom = h('input.input', { type: 'text', placeholder: 'Custom regular expression', 'aria-label': 'Custom pattern', dataset: { as: 'custom' } });
  const button = (label, fn, id) => (els[id] = h('button.btn', { type: 'button', dataset: { as: id }, onclick: fn }, label));
  panel = h('form.as-panel', { onsubmit: (e) => { e.preventDefault(); runSearch(); } },
    h('label.as-row', {}, 'Scope ', sel('scope', [['current', 'Current document'], ['open', 'All open documents'], ['folder', 'Folder…']])),
    (els.folderBox = h('div.as-folder-box', { hidden: true },
      h('div.as-row', {}, button('Choose folder…', chooseFolder, 'chooseFolder'), els.folderLabel),
      h('div.as-row', {}, opt('recursive', 'Include subfolders'), opt('useIndex', 'Use index')),
      h('div.as-row', {}, button('Build/Update index', buildIndex, 'buildIndex')))),
    els.query,
    h('label.as-row', {}, 'Match ', sel('mode', [['phrase', 'Exact phrase'], ['all', 'All words'], ['any', 'Any words']])),
    h('div.as-row', {}, opt('caseSensitive', 'Case sensitive'), opt('wholeWords', 'Whole words')),
    h('div.as-row', {}, opt('stemming', 'Stemming'), opt('regex', 'Regular expression')),
    h('div.as-row', {}, opt('proximity', 'Within'), els.proxN, ' words'),
    h('label.as-row', {}, 'Pattern ', sel('pattern', [['', 'None (use query)'], ['email', 'Email'], ['phone', 'Phone'], ['date', 'Date'], ['url', 'URL'], ['amount', 'Amount'], ['custom', 'Custom regex']])),
    els.custom,
    h('div.as-row', {}, opt('annotations', 'Comments'), opt('bookmarks', 'Bookmarks')),
    h('div.as-row', {}, h('button.btn.primary', { type: 'submit', dataset: { as: 'search' } }, 'Search'), button('Cancel', () => { if (job) job.cancelled = true; }, 'cancel'), button('Export CSV', exportCsv, 'export')),
    els.progress, els.status,
    h('label.as-row', {}, 'Sort by ', sel('sort', [['name', 'File name'], ['mtime', 'Modified date'], ['hits', 'Hits']])),
    els.list);
  els.list.addEventListener('click', onResultClick);
  els.sort.addEventListener('change', () => render(false));
  els.scope.addEventListener('change', () => { els.folderBox.hidden = els.scope.value !== 'folder'; });
  els.custom.hidden = true;
  els.pattern.addEventListener('change', () => { els.custom.hidden = els.pattern.value !== 'custom'; });
  registerSidebarTab({ id: 'advsearch', label: 'Advanced search', icon: 'search', render: (c) => { if (panel.parentNode !== c) c.replaceChildren(panel); } });
  app.registerMenuItem('Edit', { id: 'advsearch', label: 'Advanced Search…', shortcut: 'Ctrl+Shift+F', action: open });
  // Capture phase on window, so app.js's Ctrl+F (find bar) handler does not also fire.
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f' && !dialogOpen()) { e.preventDefault(); e.stopPropagation(); open(); }
  }, true);
}

function open() {
  showSidebarTab('advsearch');
  state.sidebarOpen = true;
  els.query.focus();
}

function options() {
  return {
    mode: els.mode.value, caseSensitive: els.caseSensitive.checked, wholeWords: els.wholeWords.checked, stemming: els.stemming.checked,
    regex: els.regex.checked, proximity: els.proximity.checked ? Math.max(1, Number(els.proxN.value) || 1) : 0,
    pattern: els.pattern.value || null, customPattern: els.custom.value, annotations: els.annotations.checked, bookmarks: els.bookmarks.checked,
  };
}

async function chooseFolder() {
  const r = await api.openFolder();
  if (!r) return;
  folder = r.path;
  els.folderLabel.textContent = folder;
  els.scope.value = 'folder';
  els.folderBox.hidden = false;
}

/** Run fn(job) with progress UI; only one job at a time. */
async function withJob(fn) {
  if (job) job.cancelled = true;
  const my = (job = { cancelled: false });
  els.progress.hidden = false; els.progress.value = 0;
  try { return await fn(my); } catch (err) { showError('Advanced search failed', err); return null; } finally {
    if (job === my) { job = null; els.progress.hidden = true; }
  }
}
const progress = (k, n, what) => { els.progress.max = Math.max(1, n); els.progress.value = k; els.status.textContent = `${what} ${k} of ${n}…`; };

/** {pages, annots, bookmarks} of a file; pdf.js document destroyed afterwards. null if cancelled. */
async function extractFile(file, my) {
  const bytes = await api.readFile(file.path);
  const task = viewer.pdfjs.getDocument({ data: bytes, cMapUrl: VENDOR + 'cmaps/', cMapPacked: true, standardFontDataUrl: VENDOR + 'standard_fonts/',
    wasmUrl: VENDOR + 'wasm/', iccUrl: VENDOR + 'iccs/', isEvalSupported: false, enableScripting: false });
  try { return await extractDoc(await task.promise, { isCancelled: () => my.cancelled }); } catch { return { pages: [], annots: null, bookmarks: null }; } finally { await task.destroy(); }
}

async function folderIndex(my, update) {
  if (!folder) throw new Error('Choose a folder first.');
  const key = indexKey(folder, els.recursive.checked);
  const idx = loadIndex((await api.cacheGet(key)) ?? '');
  if (!update) return idx;
  const list = await api.listPdfs(folder, { recursive: els.recursive.checked });
  const changed = await updateIndex(idx, list, (f) => extractFile(f, my), (k, n) => progress(k, n, 'Indexing file'));
  if (changed === null) return null;
  await api.cacheSet(key, saveIndex(idx));
  els.status.textContent = `Index up to date: ${list.length} files (${changed} re-read).`;
  return idx;
}
const buildIndex = () => withJob((my) => folderIndex(my, true));

function runSearch() {
  const query = els.query.value, o = options();
  return withJob(async (my) => {
    const match = compile(query, o);
    const out = [];
    const scope = els.scope.value;
    if (scope === 'folder' && els.useIndex.checked) {
      const idx = await folderIndex(my, false);
      if (!Object.keys(idx.files).length) throw new Error('No index for this folder yet: use Build/Update index.');
      out.push(...searchIndex(idx, query, o, match));
    } else if (scope === 'folder') {
      if (!folder) throw new Error('Choose a folder first.');
      const list = await api.listPdfs(folder, { recursive: els.recursive.checked });
      for (const [k, f] of list.entries()) {
        progress(k, list.length, 'Searching file');
        const doc = await extractFile(f, my);
        if (my.cancelled || doc === null) break;
        const hits = searchDoc(doc, match, o);
        if (hits.length) out.push({ name: f.name, path: f.path, mtimeMs: f.mtimeMs, hits });
      }
    } else {
      const tabs = scope === 'open' ? state.tabs : [activeTab()].filter(Boolean);
      for (const [k, tab] of tabs.entries()) {
        progress(k, tabs.length, 'Searching document');
        const doc = { pages: [], annots: null, bookmarks: null };
        for (let i = 0; i < tab.numPages && !my.cancelled; i++) { doc.pages.push(joinItems((await viewer.getTextContent(tab, i)).items)); await yieldUi(); }
        if (my.cancelled) break;
        // Comments already saved in the file (unsaved overlay objects are not in the PDF yet).
        if (o.annotations) doc.annots = await extractAnnots(tab.pdfDoc, { isCancelled: () => my.cancelled });
        if (o.bookmarks) doc.bookmarks = await extractBookmarks(tab.pdfDoc);
        const hits = searchDoc(doc, match, o);
        if (hits.length) out.push({ name: tab.name, path: tab.path, tabId: tab.id, hits });
      }
    }
    results = out;
    render(my.cancelled);
  });
}

const SORTS = {
  name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || String(a.path).localeCompare(String(b.path)),
  mtime: (a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0) || SORTS.name(a, b),
  hits: (a, b) => b.hits.length - a.hits.length || SORTS.name(a, b),
};

function render(cancelled) {
  results.sort(SORTS[els.sort.value] ?? SORTS.name);
  const n = results.reduce((a, r) => a + r.hits.length, 0);
  els.status.textContent = `${n} hit${n === 1 ? '' : 's'} in ${results.length} file${results.length === 1 ? '' : 's'}${cancelled ? ' (cancelled)' : ''}`
    + (n > MAX_SHOWN ? ` - showing the first ${MAX_SHOWN}; Export CSV has all` : '');
  let budget = MAX_SHOWN;
  els.list.replaceChildren(...results.map((r, fi) => h('section.as-file', {},
    h('h3.as-file-name', { title: r.path ?? r.name }, h('span.as-file-title', {}, r.name), h('span.as-count', {}, String(r.hits.length))),
    h('ol.search-results', {}, r.hits.slice(0, Math.max(0, budget)).map((hit, hi) => (budget--, h('li', {}, h('button.search-hit', { type: 'button', dataset: { file: String(fi), hit: String(hi) } },
      h('span.sh-page', {}, `Page ${hit.page + 1}${KIND[hit.kind] ?? ''}`),
      h('span.sh-text', {}, hit.snippet.before, h('mark', {}, hit.snippet.match), hit.snippet.after)))))))));
}

async function onResultClick(e) {
  const b = e.target.closest('.search-hit');
  if (!b) return;
  const r = results[Number(b.dataset.file)], hit = r.hits[Number(b.dataset.hit)];
  let tab = (r.tabId && state.tabs.find((t) => t.id === r.tabId)) || (r.path && state.tabs.find((t) => t.path === r.path));
  try {
    if (tab) app.activate(tab.id);
    else if (r.path) tab = await app.openBytes({ name: r.name, path: r.path, bytes: await api.readFile(r.path) });
  } catch (err) { showError('Could not open the file', err); return; }
  if (!tab) { toast('That document is no longer open'); return; }
  const scrollTop = els.list.scrollTop;
  viewer.scrollToPage(tab, hit.page);
  if (hit.kind !== 'text') { showSidebarTab('advsearch'); return; }
  // Highlight with the find bar's machinery: search the matched text, then select the
  // occurrence on this page with the same ordinal as our hit.
  const ordinal = r.hits.filter((x, k) => x.page === hit.page && x.snippet.match === hit.snippet.match && k < Number(b.dataset.hit)).length;
  const saved = { ...search.options };
  Object.assign(search.options, { caseSensitive: true, wholeWord: false });
  try { await search.run(hit.snippet.match, tab); } finally { Object.assign(search.options, saved); }
  const found = search.getResults(tab)?.hits ?? [];
  const onPage = found.map((x, k) => [x, k]).filter(([x]) => x.pageIndex === hit.page);
  const pick = onPage[Math.min(ordinal, onPage.length - 1)];
  if (pick) search.goTo(pick[1], tab);
  showSidebarTab('advsearch');
  els.list.scrollTop = scrollTop;
}

async function exportCsv() {
  if (!results.length) { toast('No results to export'); return; }
  try {
    await api.saveFile({ defaultPath: 'search-results.csv', filters: [{ name: 'CSV', extensions: ['csv'] }], bytes: new TextEncoder().encode(toCsv(results)) });
  } catch (err) { showError('Could not export the results', err); }
}
