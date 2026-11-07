// Tools > Compare revisions…: compares an older and a newer revision of a submittal page by page (by
// index) and opens the result as a new, unsaved overlay PDF (src/core/compareReport.js): unchanged ink
// grey, removed red, added green, a dashed rectangle with a note round each changed area.
// Per page pair: both pages are drawn by pdf.js on white with annotations off at the same pixel size
// (the newer page's at the chosen dpi, lowered to fit a canvas; an older page of another size is
// scaled to fit it), compared by compare-lib.js comparePages, and their words diffed by
// textdiff-lib.js. Pages in one revision only become 'added' / 'removed' pages (onlyPage). The
// composite is PNG, or JPEG q 0.85 above JPEG_PIXELS. Canvases are released after every page and the
// loop yields to the UI between pages; Cancel stops it before the report is built, so no tab opens.
// The per-page results stay on the new tab (tab.compare) for the Differences sidebar panel.
import { bus } from '../bus.js';
import { state, activeTab } from '../state.js';
import { h } from './dom.js';
import { showDialog, showError, toast, progressDialog, CANCELLED } from './dialogs.js';
import { registerSidebarTab, showSidebarTab, refreshSidebarTab } from './sidebar.js';
import { viewer } from './viewer.js';
import { splitView } from './splitview.js';
import { comparePages, onlyPage, regionsToPoints } from './compare-lib.js';
import { pageWords, diffWords } from './textdiff-lib.js';
import { DPI_PRESETS, DEFAULT_OPTIONS, guessOrder, renderScale, pagePairs, hasChanges, pageSummary, regionKind, diffCsv, diffText } from './comparerev-lib.js';
import { parseRanges } from '../../src/core/pdfOps.js';

const OPTIONS_KEY = 'compare.options';
const JPEG_PIXELS = 4e6; // above this a composite is stored as JPEG (A1 at 150 dpi: 17 Mpx)
const TAB = 'differences';
const BROWSE = '__browse__';
let app = null;

const nextFrame = () => new Promise((r) => setTimeout(r, 0));
const release = (c) => { c.width = 0; c.height = 0; };
const baseName = (n) => String(n ?? '').replace(/\.pdf$/i, '');

async function loadOptions() {
  try { return { ...DEFAULT_OPTIONS, ...((await window.api.settingsGet(OPTIONS_KEY)) ?? {}) }; } catch { return { ...DEFAULT_OPTIONS }; }
}

/** Page i of `tab` drawn on white into a W x H canvas, scaled to fit (top-left). Returns {canvas, rgba, fit}. */
async function draw(tab, i, W, H) {
  const page = tab.pages[i];
  const v1 = page.getViewport({ scale: 1 });
  const fit = Math.min(W / v1.width, H / v1.height);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  await page.render({ canvas: c, viewport: page.getViewport({ scale: fit }), background: '#ffffff', annotationMode: viewer.pdfjs.AnnotationMode.DISABLE }).promise;
  const rgba = ctx.getImageData(0, 0, W, H).data;
  return { canvas: c, rgba, fit, v1 };
}

async function encode(rgba, W, H) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length), W, H), 0, 0);
  const jpeg = W * H > JPEG_PIXELS;
  const blob = await new Promise((r) => c.toBlob(r, jpeg ? 'image/jpeg' : 'image/png', 0.85));
  release(c);
  if (!blob) throw new Error(`could not encode a ${W} x ${H} page image`);
  return { bytes: new Uint8Array(await blob.arrayBuffer()), type: jpeg ? 'jpeg' : 'png' };
}

async function words(tab, i) {
  const page = tab.pages[i];
  return pageWords((await viewer.getTextContent(tab, i)).items, page.view, page.rotate);
}

/**
 * Compare `older` and `newer` (open tabs) with opts {indices?, dpi, ignoreColor, align, text}.
 * Resolves the new compare tab, or null when cancelled.
 */
export async function compareRevisions(older, newer, opts = {}) {
  const o = { ...DEFAULT_OPTIONS, ...opts };
  const pairs = pagePairs(older.numPages, newer.numPages, o.indices);
  const prog = progressDialog({ title: 'Compare revisions', text: 'Starting…', statusId: 'compare-progress', className: 'compare-progress' });
  const out = [], results = [];
  const t0 = performance.now();
  try {
    for (const [k, p] of pairs.entries()) {
      if (prog.isCancelled()) return null;
      prog.set(`Comparing page ${k + 1} of ${pairs.length}…`);
      await nextFrame();
      const ref = p.newer !== null ? newer : older, ri = p.newer ?? p.older;
      const v = ref.pages[ri].getViewport({ scale: 1 });
      const scale = renderScale(v.width, v.height, o.dpi);
      const W = Math.max(1, Math.round(v.width * scale)), H = Math.max(1, Math.round(v.height * scale));
      const res = { index: k, older: p.older, newer: p.newer, regions: [], text: { added: [], removed: [] }, stats: null, shift: { dx: 0, dy: 0 }, scaled: false, capped: false };
      let composite;
      if (p.older !== null && p.newer !== null) {
        const b = await draw(newer, p.newer, W, H);
        const a = await draw(older, p.older, W, H);
        release(a.canvas); release(b.canvas);
        res.scaled = Math.abs(a.v1.width - v.width) > 0.5 || Math.abs(a.v1.height - v.height) > 0.5;
        const cmp = comparePages(a.rgba, b.rgba, W, H, { align: o.align });
        composite = cmp.composite;
        Object.assign(res, { regions: regionsToPoints(cmp.regions, scale), stats: cmp.stats, capped: cmp.capped,
          shift: { dx: cmp.shift.dx / scale, dy: cmp.shift.dy / scale } });
        res.status = 'compared';
        if (o.text) {
          const k2 = a.fit / scale; // older points -> newer points when the older page was scaled to fit
          const ow = (await words(older, p.older)).map((w) => ({ ...w, box: { x: w.box.x * k2, y: w.box.y * k2, w: w.box.w * k2, h: w.box.h * k2 } }));
          const d = diffWords(ow, await words(newer, p.newer), { shiftPt: res.shift });
          res.text = { added: d.added, removed: d.removed };
        }
      } else {
        const one = await draw(ref, ri, W, H);
        release(one.canvas);
        composite = onlyPage(one.rgba, W, H, p.newer !== null ? 'newer' : 'older');
        res.status = p.newer !== null ? 'added' : 'removed';
      }
      if (prog.isCancelled()) return null;
      const image = await encode(composite, W, H);
      out.push({ width: v.width, height: v.height, image, regions: res.regions, status: res.status, textChanges: res.text });
      results.push(res);
    }
    if (prog.isCancelled() || !out.length) return null;
    prog.set('Building the compare document…');
    const { buildCompareReport } = await import('../../src/core/index.js');
    const bytes = await buildCompareReport(out, { older: { name: older.name }, newer: { name: newer.name }, date: new Date() });
    if (prog.isCancelled()) return null;
    const ms = Math.round(performance.now() - t0);
    console.info(`[compare] ${pairs.length} page(s) in ${ms} ms, ${bytes.length} bytes`);
    const tab = await app.openBytes({ name: `Compare – ${baseName(older.name)} vs ${baseName(newer.name)}.pdf`, bytes });
    if (!tab) return null;
    tab.compare = { older: { id: older.id, name: older.name }, newer: { id: newer.id, name: newer.name }, pages: results, ms, bytes: bytes.length };
    showSidebarTab(TAB);
    if (!state.sidebarOpen) state.sidebarOpen = true;
    refreshSidebarTab(TAB);
    const changed = results.filter(hasChanges).length;
    toast(changed ? `${changed} page${changed === 1 ? '' : 's'} with differences` : 'No differences found');
    return tab;
  } catch (err) {
    if (err !== CANCELLED) showError('Could not compare the revisions', err);
    return null;
  } finally {
    prog.close();
  }
}

async function browse() {
  const files = await window.api.openFiles({ filters: [{ name: 'PDF', extensions: ['pdf'] }], multiple: false });
  const f = files?.[0];
  if (!f) return null;
  const { bytes, stamp } = f.bytes instanceof Uint8Array ? f : await window.api.readFile(f.path, { withStamp: true });
  return app.openBytes({ name: f.name ?? String(f.path).split(/[\\/]/).pop(), path: f.path ?? null, bytes, stamp: stamp ?? null });
}

/** Tools > Compare revisions…: choose the documents and options, then compareRevisions(). */
export async function compareDialog() {
  const tabs = state.tabs.filter((t) => t.pdfDoc && !t.compare);
  const cur = activeTab();
  const recentTwo = tabs.length >= 2 ? [tabs[tabs.length - 2], tabs[tabs.length - 1]] : tabs;
  const [g0, g1] = recentTwo.length === 2 ? guessOrder(...recentTwo) : [recentTwo[0] ?? cur, recentTwo[0] ?? cur];
  const saved = await loadOptions();
  const pick = (id, label, sel) => h('label.cmp-row', {}, h('span', {}, label),
    h('select.input', { id, 'aria-label': label }, tabs.map((t) => h('option', { value: t.id, selected: t === sel }, t.name)), h('option', { value: BROWSE }, 'Browse…')));
  const check = (id, label, on) => h('label.cmp-check', {}, h('input', { type: 'checkbox', id, checked: on || null }), h('span', {}, label));
  const range = h('input.input#cmp-range', { type: 'text', placeholder: 'All pages, or e.g. 1-5', 'aria-label': 'Pages' });
  const dpi = h('select.input#cmp-dpi', { 'aria-label': 'Quality' }, DPI_PRESETS.map((d) => h('option', { value: d, selected: d === saved.dpi }, `${d} dpi${d === 150 ? ' (default)' : ''}`)));
  const error = h('p.vx-error', { role: 'alert' });
  const body = h('div.cmp-form', {},
    pick('cmp-older', 'Older revision', g0), pick('cmp-newer', 'Newer revision', g1),
    h('label.cmp-row', {}, h('span', {}, 'Pages'), range),
    h('label.cmp-row', {}, h('span', {}, 'Quality'), dpi),
    h('label.cmp-check', { title: 'Colour-sensitive compare is not available yet: ink is always compared' }, h('input', { type: 'checkbox', id: 'cmp-ignore-color', checked: true, disabled: true }), h('span', {}, 'Ignore colour (compare ink only)')),
    check('cmp-align', 'Align shifted pages automatically', saved.align),
    check('cmp-text', 'List text changes', saved.text),
    h('p.ocr-note', {}, 'Pages are compared in order (page 1 with page 1, …) as pictures at the chosen quality.'),
    error);
  for (const id of ['#cmp-older', '#cmp-newer']) {
    const sel = body.querySelector(id);
    sel.addEventListener('change', async () => {
      if (sel.value !== BROWSE) return;
      const t = await browse().catch((err) => { showError('Could not open the file', err); return null; });
      if (!t) { sel.value = tabs[0]?.id ?? ''; return; }
      tabs.push(t);
      for (const s of body.querySelectorAll('select[id^="cmp-o"], select[id^="cmp-n"]')) s.insertBefore(h('option', { value: t.id }, t.name), s.lastChild);
      sel.value = t.id;
    });
  }
  let chosen = null;
  const validate = () => {
    const older = tabs.find((t) => t.id === body.querySelector('#cmp-older').value);
    const newer = tabs.find((t) => t.id === body.querySelector('#cmp-newer').value);
    if (!older || !newer) { error.textContent = 'Choose an older and a newer document.'; return false; }
    if (older === newer) { error.textContent = 'Choose two different documents.'; return false; }
    let indices = null;
    try { if (range.value.trim()) indices = parseRanges(range.value, Math.max(older.numPages, newer.numPages)); } catch (err) { error.textContent = `Pages: ${err.message}`; range.focus(); return false; }
    chosen = { older, newer, opts: { indices, dpi: Number(dpi.value), ignoreColor: body.querySelector('#cmp-ignore-color').checked,
      align: body.querySelector('#cmp-align').checked, text: body.querySelector('#cmp-text').checked } };
    return true;
  };
  const res = await showDialog({ title: 'Compare revisions', body, className: 'compare-dialog', help: 'compare-revisions', initialFocus: '#cmp-older',
    buttons: [{ label: 'Cancel', value: 'cancel', cancel: true }, { label: 'Compare', value: 'ok', primary: true, validate }] });
  if (res !== 'ok' || !chosen) return null;
  const { indices, ...keep } = chosen.opts;
  window.api.settingsSet(OPTIONS_KEY, keep).catch(() => {});
  return compareRevisions(chosen.older, chosen.newer, chosen.opts);
}

// ---------------------------------------------------------------- Differences panel

/** A basic list from a saved compare PDF: its /T "Compare" squares (session results are richer). */
function fromAnnotations(tab) {
  const objs = (tab.objects ?? []).filter((o) => o.author === 'Compare');
  if (!objs.length) return null;
  const pages = new Map();
  for (const o of objs) {
    const p = pages.get(o.page) ?? { index: o.page, status: 'compared', regions: [], text: { added: [], removed: [] }, notes: [] };
    p.notes.push({ text: String(o.contents ?? o.text ?? '').split('\n')[0], id: o.id });
    pages.set(o.page, p);
  }
  return [...pages.values()].sort((a, b) => a.index - b.index);
}

/** Scroll page i into view and flash box b (top-left points) with a temporary SVG rectangle. */
function flash(tab, i, b) {
  viewer.scrollToPage(tab, i);
  if (!b) return;
  requestAnimationFrame(() => {
    const ref = viewer.getOverlaySvg(tab, i), pageEl = viewer.getPageEl(tab, i);
    if (!ref || !pageEl) return;
    const { width, height } = viewer.pageSize(tab, i);
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'overlay-svg cmp-flash');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.width = ref.style.width; svg.style.height = ref.style.height;
    if (ref.dataset.viewRotation) svg.dataset.viewRotation = ref.dataset.viewRotation;
    const r = document.createElementNS(NS, 'rect');
    Object.entries({ x: b.x - 4, y: b.y - 4, width: b.w + 8, height: b.h + 8, fill: 'none', stroke: '#1a73e8', 'stroke-width': 3, 'stroke-dasharray': '6 3' }).forEach(([k, v]) => r.setAttribute(k, String(v)));
    svg.append(r);
    pageEl.append(svg);
    pageEl.scrollIntoView?.({ block: 'nearest' });
    setTimeout(() => svg.remove(), 1600);
  });
}

function sideBySide(tab, i) {
  const c = tab.compare;
  const a = state.tabs.find((t) => t.id === c?.older.id), b = state.tabs.find((t) => t.id === c?.newer.id);
  if (!a || !b) { toast('Open both revisions to show them side by side'); return; }
  splitView.open([a.id, b.id], 'v', { sync: true, focus: 1 });
  viewer.scrollToPage(b, Math.min(i, b.numPages - 1));
}

async function copyList(pages) {
  try { await navigator.clipboard.writeText(diffText(pages)); toast('Differences copied'); } catch (err) { showError('Copy list', err); }
}

async function exportCsv(tab, pages) {
  try {
    await window.api.saveFile({ defaultPath: `${baseName(tab.name)}-differences.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }], bytes: new TextEncoder().encode(diffCsv(pages)) });
  } catch (err) { showError('Export differences', err); }
}

function render(container, tab) {
  if (!tab) { container.replaceChildren(h('p.sb-empty', {}, 'No document open')); return; }
  const live = tab.compare?.pages;
  const saved = !live && fromAnnotations(tab);
  if (!live && !saved) { container.replaceChildren(h('p.sb-empty', {}, 'Not a compare document. Use Tools › Compare revisions… to make one.')); return; }
  const list = h('div.cmp-list', { role: 'list', 'aria-label': 'Differences' });
  const item = (label, onclick, cls = '') => h(`button.cmp-item${cls}`, { type: 'button', role: 'listitem', onclick }, label);
  if (live) {
    const changed = live.filter(hasChanges);
    if (!changed.length) list.append(h('p.sb-empty', {}, 'No differences found'));
    for (const p of changed) {
      list.append(h('div.cmp-page', {},
        item(pageSummary(p), () => flash(tab, p.index, null), '.cmp-page-head'),
        p.scaled ? h('p.cmp-note', {}, 'Pages differ in size: the older page was scaled to fit.') : null,
        p.capped ? h('p.cmp-note', {}, 'Many changes: shown as one area.') : null,
        h('button.btn.cmp-sbs', { type: 'button', onclick: () => sideBySide(tab, p.index) }, 'Side by side')));
      p.regions.forEach((r, k) => list.append(item(`Change ${k + 1}: ${regionKind(r)}`, () => flash(tab, p.index, r))));
      for (const t of p.text.added) list.append(item(`+ ${t.text}`, () => flash(tab, p.index, t.box), '.cmp-add'));
      for (const t of p.text.removed) list.append(item(`− ${t.text}`, () => flash(tab, p.index, t.box), '.cmp-rem'));
    }
  } else {
    list.append(h('p.cmp-note', {}, 'Saved compare document: the list is read from its compare marks. Run the compare again for the text list and Side by side.'));
    for (const p of saved) {
      list.append(h('div.cmp-page', {}, item(`Page ${p.index + 1} — ${p.notes.length} mark${p.notes.length === 1 ? '' : 's'}`, () => flash(tab, p.index, null), '.cmp-page-head')));
      for (const n of p.notes) list.append(item(n.text || 'Change', () => { viewer.scrollToPage(tab, p.index); app.annotations?.select(tab, [n.id]); }));
    }
  }
  const pages = live ?? saved.map((p) => ({ ...p, regions: p.notes.map(() => ({})) }));
  const bar = h('div.cm-toolbar', {},
    h('button.btn.cmp-copy', { type: 'button', onclick: () => copyList(pages) }, 'Copy list'),
    h('button.btn.cmp-csv', { type: 'button', onclick: () => exportCsv(tab, pages) }, 'Export CSV'));
  container.replaceChildren(bar, list);
}

export function initCompareRevisions(a) {
  app = a;
  registerSidebarTab({ id: TAB, label: 'Differences', icon: 'search', render });
  a.registerMenuItem('Tools', { separator: true });
  a.registerMenuItem('Tools', { id: 'compare-revisions', label: 'Compare revisions…', action: () => compareDialog(), enabled: () => state.tabs.some((t) => t.pdfDoc) });
  bus.on('tab:activated', ({ tab }) => { if (tab?.compare || (tab && fromAnnotations(tab))) showSidebarTab(TAB); });
  a.compareRevisions = { compareDialog, compareRevisions };
}
