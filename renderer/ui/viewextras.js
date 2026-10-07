// View extras: the Layers sidebar tab (PDF optional content groups) and the print options dialog.
//
// Layers: the viewer loads the document's OptionalContentConfig into tab.ocConfig (viewer.js,
// display intent) and passes it to every page and thumbnail render (viewer.optionalContent(tab)).
// This module only toggles visibility on that config, then emits `layers:changed {tab}` and
// re-renders the pages (the thumbnails re-render themselves on that event, sidebar.js).
//
// Print: printDialog(tab) asks for pages, scaling, annotations and copies, then renders the chosen
// pages to images in div.print-container and calls api.print(). Layer visibility is copied from
// tab.ocConfig to a print-intent config. With "Include annotations", unsaved overlay objects
// (tab.objects) are burnt into a temporary copy with the core flattenObjects first; without, no
// annotations are printed at all (also none of the file's own). Copies are repeated pages in the
// container (collated), so they work the same in Electron and in the browser shim.
//
// Word count (Document menu): words and characters of the pdf.js text of the whole document and
// of the current page; the counting rules are textStats() in viewextras-lib.js.
//
// Snapshot (View menu): the user drags a rectangle on a page (Esc cancels); the area is rendered
// from page space at SNAP_SCALE (2 px per point) with the same overlay burn-in as print, then
// previewed with Copy (execCommand + a one-time copy listener: clipboard permission is denied in
// the app) and Save as PNG.
import { bus } from '../bus.js';
import { activeTab } from '../state.js';
import { h, $$ } from './dom.js';
import { addIcon } from './icons.js';
import { viewer } from './viewer.js';
import { registerSidebarTab, refreshSidebarTab } from './sidebar.js';
import { showDialog, showError, toast } from './dialogs.js';
import { layerTree, layerIds, printPageIndices, pageText, textStats, addStats, snapRect } from './viewextras-lib.js';

const PRINT_DPI = 150;
const SNAP_SCALE = 2; // snapshot pixels per point
const api = window.api;

export function initViewExtras() {
  addIcon('layers', '<path d="M12 4l8.5 4.5L12 13 3.5 8.5z"/><path d="M3.5 12.5L12 17l8.5-4.5"/><path d="M3.5 16.5L12 21l8.5-4.5"/>');
  registerSidebarTab({ id: 'layers', label: 'Layers', icon: 'layers', render: renderLayers });
}

/** Menu items; app.js calls this once the menus exist (after the Document menu, before Help). */
export function initViewExtrasMenus({ registerMenuItem: M }) {
  const hasDoc = () => !!activeTab()?.pdfDoc;
  M('View', { separator: true });
  M('View', { id: 'snapshot', label: 'Snapshot…', action: () => snapshot(), enabled: hasDoc });
  M('Document', { separator: true });
  M('Document', { id: 'word-count', label: 'Word count…', action: () => wordCountDialog(), enabled: hasDoc });
}

// ================================================================ layers
function renderLayers(container, tab) {
  if (!tab?.pdfDoc) { container.replaceChildren(h('p.sb-empty', {}, tab ? 'Loading…' : 'No document open')); return; }
  const tree = layerTree(tab.ocConfig);
  if (!tree.length) { container.replaceChildren(h('p.sb-empty', {}, 'This document has no layers')); return; }
  const ids = layerIds(tree);
  const setAll = (visible) => { for (const id of ids) tab.ocConfig.setVisibility(id, visible, false); changed(tab); };
  const item = (n) => h('li', {},
    n.id
      ? h('label.vx-layer', {}, h('input', { type: 'checkbox', dataset: { layerId: n.id }, onchange: (e) => { tab.ocConfig.setVisibility(n.id, e.target.checked); changed(tab); } }), h('span', {}, n.name))
      : h('span.vx-layer-heading', {}, n.name),
    n.children.length ? h('ul.vx-layer-list', { role: 'group' }, n.children.map(item)) : null);
  container.replaceChildren(
    h('div.vx-layer-actions', {},
      h('button.btn', { type: 'button', dataset: { action: 'show-all' }, onclick: () => setAll(true) }, 'Show all'),
      h('button.btn', { type: 'button', dataset: { action: 'hide-all' }, onclick: () => setAll(false) }, 'Hide all')),
    h('ul.vx-layer-list.vx-layer-root', { 'aria-label': 'Layers' }, tree.map(item)));
  syncChecks(container, tab);
}

// Radio-button groups can switch other layers off, so always read the state back from the config.
function syncChecks(container, tab) {
  for (const cb of $$('input[data-layer-id]', container)) cb.checked = !!tab.ocConfig.getGroup(cb.dataset.layerId)?.visible;
}

function changed(tab) {
  if (tab === activeTab()) refreshSidebarTab('layers');
  viewer.rerender(tab);
  bus.emit('layers:changed', { tab });
}

// ================================================================ print
/** File > Print…: options dialog, then the system print. Resolves true when printed. */
export async function printDialog(tab = activeTab()) {
  if (!tab?.pdfDoc) return false;
  const opt = (value, label, selected) => h('option', { value, selected: selected || null }, label);
  const pages = h('select.input#vx-print-pages', { onchange: () => { range.disabled = pages.value !== 'range'; if (!range.disabled) range.focus(); } },
    opt('all', `All pages (${tab.numPages})`, true), opt('current', `Current page (${tab.currentPage + 1})`), opt('range', 'Page range'), opt('odd', 'Odd pages'), opt('even', 'Even pages'));
  const range = h('input.input#vx-print-range', { type: 'text', placeholder: 'e.g. 1-3, 5', disabled: true, 'aria-label': 'Page range' });
  const scaling = h('select.input#vx-print-scaling', {}, opt('fit', 'Fit to paper', true), opt('actual', 'Actual size'));
  const annots = h('select.input#vx-print-annots', {}, opt('yes', 'Yes', true), opt('no', 'No'));
  const copies = h('input.input#vx-print-copies', { type: 'number', min: '1', max: '99', value: '1' });
  const error = h('p.vx-error', { role: 'alert' });
  const field = (label, ...ctl) => h('label.vx-field', {}, h('span', {}, label), ...ctl);
  let chosen = null;
  const validate = () => {
    try {
      const indices = printPageIndices({ mode: pages.value, range: range.value, current: tab.currentPage, count: tab.numPages });
      const n = Number(copies.value);
      if (!Number.isInteger(n) || n < 1 || n > 99) throw new RangeError('Copies must be a whole number from 1 to 99');
      if (!indices.length) throw new RangeError('No pages to print');
      chosen = { indices, copies: n, scaling: scaling.value, annotations: annots.value === 'yes' };
      return true;
    } catch (err) {
      error.textContent = err.message;
      return false;
    }
  };
  const body = h('div.vx-print-form', {},
    field('Pages', pages), field('Range', range), field('Scaling', scaling),
    field('Include annotations', annots), field('Copies', copies), error);
  const res = await showDialog({
    title: 'Print', body, className: 'vx-print-dialog', initialFocus: '#vx-print-pages',
    buttons: [{ label: 'Cancel', value: 'cancel', cancel: true }, { label: 'Print…', value: 'print', primary: true, validate }],
  });
  if (res !== 'print' || !chosen) return false;
  return printPages(tab, chosen);
}

/** Render the given pages to images and run the system print. */
export async function printPages(tab, { indices, copies = 1, scaling = 'fit', annotations = true }) {
  const host = h(`div.print-container.${scaling === 'actual' ? 'print-actual' : 'print-fit'}`, { 'aria-hidden': 'true' });
  document.body.append(host);
  const urls = [];
  let tmp = null;
  try {
    let doc = tab.pdfDoc;
    if (annotations && tab.objects?.length) ({ doc, tmp } = await flattenedCopy(tab));
    const oc = await ocConfigFor(tab, doc, 'print');
    const imgs = [];
    for (const i of indices) {
      const page = doc === tab.pdfDoc ? tab.pages[i] : await doc.getPage(i + 1);
      const vp = page.getViewport({ scale: PRINT_DPI / 72 });
      const c = document.createElement('canvas');
      c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      await page.render({
        canvas: c, viewport: vp, intent: 'print',
        annotationMode: annotations ? viewer.pdfjs.AnnotationMode.ENABLE : viewer.pdfjs.AnnotationMode.DISABLE,
        ...(oc ? { optionalContentConfigPromise: Promise.resolve(oc) } : {}),
      }).promise;
      const blob = await new Promise((r) => c.toBlob(r));
      c.width = 0; c.height = 0;
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const pt = page.getViewport({ scale: 1 });
      imgs.push({ url, pt });
    }
    for (let k = 0; k < copies; k++) {
      for (const { url, pt } of imgs) {
        const style = scaling === 'actual' ? { width: `${pt.width}pt`, height: `${pt.height}pt` } : { aspectRatio: `${pt.width} / ${pt.height}` };
        host.append(h('div.print-page', {}, h('img', { src: url, alt: '', style })));
      }
    }
    document.body.classList.add('printing');
    await api.print();
    return true;
  } catch (err) {
    showError('Could not print', err);
    return false;
  } finally {
    document.body.classList.remove('printing');
    host.remove();
    for (const u of urls) URL.revokeObjectURL(u);
    tmp?.destroy();
  }
}

// Unsaved overlay objects (tab.objects) burnt into a temporary pdf.js copy of the document with
// the core flattenObjects, which draws every type the app creates (notes and text markups with
// the same code as their saved appearances, annots.js). A type it does not know is left out with a
// console warning rather than failing the print. The caller destroys `tmp` when done.
async function flattenedCopy(tab) {
  const { flattenObjects } = await import('../../src/core/index.js');
  const bytes = await flattenObjects(tab.bytes.slice(), tab.objects.map((o) => structuredClone(o)), { skipUnknown: true });
  const V = new URL('./vendor/pdfjs/', document.baseURI).href; // same resources as viewer.js
  const tmp = viewer.pdfjs.getDocument({ data: bytes, password: tab.password ?? undefined, cMapUrl: V + 'cmaps/', cMapPacked: true, standardFontDataUrl: V + 'standard_fonts/',
    wasmUrl: V + 'wasm/', iccUrl: V + 'iccs/', isEvalSupported: false, enableScripting: false });
  return { doc: await tmp.promise, tmp };
}

// `intent` config of `doc` carrying the current on-screen visibility of tab.ocConfig.
async function ocConfigFor(tab, doc, intent) {
  if (!tab.ocConfig) return null;
  const oc = await doc.getOptionalContentConfig({ intent }).catch(() => null);
  if (!oc) return null;
  for (const [id, g] of tab.ocConfig) if (oc.getGroup(id)) oc.setVisibility(id, g.visible, false);
  return oc;
}

// ================================================================ word count
/** Document > Word count…: counts of the whole document and the current page. Resolves the counts. */
export async function wordCountDialog(tab = activeTab()) {
  if (!tab?.pdfDoc) return null;
  let per;
  try {
    per = [];
    for (let i = 0; i < tab.numPages; i++) per.push(textStats(pageText(await viewer.getTextContent(tab, i))));
  } catch (err) {
    showError('Could not count words', err);
    return null;
  }
  const counts = { document: addStats(...per), page: per[tab.currentPage] ?? addStats() };
  const fmt = (n) => n.toLocaleString();
  const row = (key, label) => h('tr', { dataset: { stat: key } }, h('th', { scope: 'row' }, label),
    h('td', { dataset: { scope: 'document' } }, fmt(counts.document[key])), h('td', { dataset: { scope: 'page' } }, fmt(counts.page[key])));
  const body = h('div.vx-wc', {},
    h('table.vx-wc-table', {},
      h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', { scope: 'col' }, `Document (${tab.numPages} ${tab.numPages === 1 ? 'page' : 'pages'})`), h('th', { scope: 'col' }, `Page ${tab.currentPage + 1}`))),
      h('tbody', {}, row('words', 'Words'), row('chars', 'Characters (with spaces)'), row('charsNoSpaces', 'Characters (no spaces)'))),
    h('p.vx-note', {}, 'Counts the text layer of the PDF. Scanned pages without text count as empty; each Chinese or Japanese character counts as one word.'));
  await showDialog({ title: 'Word count', body, className: 'vx-wc-dialog' });
  return counts;
}

// ================================================================ snapshot
/** View > Snapshot…: pick an area, then preview it with Copy and Save as PNG. */
export async function snapshot(tab = activeTab()) {
  if (!tab?.pdfDoc || !tab.view) return null;
  const area = await pickArea(tab);
  if (!area) return null;
  let canvas;
  try {
    canvas = await renderSnapshot(tab, area);
  } catch (err) {
    showError('Could not take the snapshot', err);
    return null;
  }
  return snapshotDialog(tab, area, canvas);
}

// Rubber-band selection on one page. Resolves {pageIndex, x, y, w, h} in page space, or null.
function pickArea(tab) {
  const scrollEl = viewer.getScrollEl(tab);
  return new Promise((resolve) => {
    let drag = null;
    const hint = h('div.vx-snap-hint', { role: 'status' }, 'Drag over a page to take a snapshot. Esc cancels.');
    document.body.append(hint);
    scrollEl.classList.add('vx-snapping');
    const pointOn = (i, e) => {
      const r = viewer.getPageEl(tab, i).getBoundingClientRect();
      const [ux, uy] = viewer.getViewport(tab, i).convertToPdfPoint(e.clientX - r.left, e.clientY - r.top);
      const [x, y] = tab.pages[i].getViewport({ scale: 1 }).convertToViewportPoint(ux, uy);
      return { x, y };
    };
    const draw = () => {
      const r = snapRect(drag.start, drag.end, viewer.pageSize(tab, drag.i), 0);
      if (!r) { drag.box.hidden = true; return; }
      const pr = drag.pe.getBoundingClientRect();
      const a = viewer.pageToClient(tab, drag.i, r.x, r.y), b = viewer.pageToClient(tab, drag.i, r.x + r.w, r.y + r.h);
      Object.assign(drag.box.style, {
        left: `${Math.min(a.clientX, b.clientX) - pr.left}px`, top: `${Math.min(a.clientY, b.clientY) - pr.top}px`,
        width: `${Math.abs(b.clientX - a.clientX)}px`, height: `${Math.abs(b.clientY - a.clientY)}px`,
      });
      drag.box.hidden = false;
    };
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    const onDown = (e) => {
      if (drag) { stop(e); return; }
      const pe = e.target.closest?.('.page');
      if (!scrollEl.contains(e.target)) { finish(null); return; } // a click elsewhere cancels
      if (!pe || e.button !== 0) return;                            // gaps and scrollbars still scroll
      stop(e);
      const i = Number(pe.dataset.pageIndex);
      const start = pointOn(i, e);
      drag = { i, pe, start, end: start, box: h('div.vx-snap-box', { hidden: true }) };
      pe.append(drag.box);
    };
    const onMove = (e) => { if (!drag) return; stop(e); drag.end = pointOn(drag.i, e); draw(); };
    const onUp = (e) => {
      if (!drag) return;
      stop(e);
      drag.end = pointOn(drag.i, e);
      const r = snapRect(drag.start, drag.end, viewer.pageSize(tab, drag.i));
      if (r) finish({ pageIndex: drag.i, ...r });
      else { drag.box.remove(); drag = null; } // a click: keep waiting for a drag
    };
    const onKey = (e) => { if (e.key === 'Escape') { stop(e); finish(null); } };
    const offTab = bus.on('tab:activated', () => finish(null));
    const opts = { capture: true };
    window.addEventListener('pointerdown', onDown, opts);
    window.addEventListener('pointermove', onMove, opts);
    window.addEventListener('pointerup', onUp, opts);
    window.addEventListener('keydown', onKey, opts);
    function finish(result) {
      window.removeEventListener('pointerdown', onDown, opts);
      window.removeEventListener('pointermove', onMove, opts);
      window.removeEventListener('pointerup', onUp, opts);
      window.removeEventListener('keydown', onKey, opts);
      offTab();
      drag?.box.remove();
      hint.remove();
      scrollEl.classList.remove('vx-snapping');
      resolve(result);
    }
  });
}

/** Render a page-space area ({pageIndex, x, y, w, h}, points) at `scale` px per point, overlay objects included. */
export async function renderSnapshot(tab, { pageIndex, x, y, w, h: ht }, scale = SNAP_SCALE) {
  let doc = tab.pdfDoc, tmp = null;
  try {
    if (tab.objects?.some((o) => o.page === pageIndex)) ({ doc, tmp } = await flattenedCopy(tab));
    const oc = await ocConfigFor(tab, doc, 'display');
    const page = doc === tab.pdfDoc ? tab.pages[pageIndex] : await doc.getPage(pageIndex + 1);
    const vp = page.getViewport({ scale, offsetX: -x * scale, offsetY: -y * scale });
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(ht * scale));
    await page.render({
      canvas: c, viewport: vp, annotationMode: viewer.pdfjs.AnnotationMode.ENABLE,
      ...(oc ? { optionalContentConfigPromise: Promise.resolve(oc) } : {}),
    }).promise;
    return c;
  } finally {
    tmp?.destroy();
  }
}

async function snapshotDialog(tab, area, canvas) {
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const dataUrl = canvas.toDataURL('image/png');
  const n = area.pageIndex + 1;
  const pt = (v) => Math.round(v * 10) / 10;
  const desc = `Snapshot of page ${n}, ${canvas.width} × ${canvas.height} px`;
  const base = String(tab.name ?? 'document').replace(/\.pdf$/i, '');
  const copy = () => {
    toast(copyImage(dataUrl, blob, desc) ? 'Snapshot copied' : 'Could not copy the snapshot');
    return false; // keep the dialog open
  };
  const save = async () => {
    try {
      const res = await api.saveFile({ defaultPath: `${base}-p${n}-snapshot.png`, filters: [{ name: 'PNG image', extensions: ['png'] }], bytes });
      if (res?.path) toast('Snapshot saved');
    } catch (err) { showError('Could not save the snapshot', err); }
    return false;
  };
  const body = h('div.vx-snap', {},
    h('div.vx-snap-frame', {}, h('img.vx-snap-img', { src: dataUrl, alt: desc, width: String(Math.round(area.w * viewer.PDF_TO_CSS)), height: String(Math.round(area.h * viewer.PDF_TO_CSS)) })),
    h('p.vx-note', {}, `Page ${n} · ${pt(area.w)} × ${pt(area.h)} pt · ${canvas.width} × ${canvas.height} px`));
  await showDialog({
    title: 'Snapshot', body, className: 'vx-snap-dialog', initialFocus: '[data-value="copy"]',
    buttons: [{ label: 'Copy', value: 'copy', validate: copy }, { label: 'Save as PNG…', value: 'save', validate: save }, { label: 'Close', value: 'close', cancel: true, primary: true }],
  });
  canvas.width = 0; canvas.height = 0;
  return area;
}

// Must run inside the click handler (user activation): execCommand('copy') with a one-time copy
// listener supplying an <img> as HTML and a text fallback. The async clipboard API is tried too
// for apps that accept image/png, and its (permission) failure ignored.
function copyImage(dataUrl, blob, text) {
  const onCopy = (e) => {
    e.clipboardData.setData('text/html', `<img src="${dataUrl}" alt="${text}">`);
    e.clipboardData.setData('text/plain', text);
    e.preventDefault();
  };
  document.addEventListener('copy', onCopy, { once: true });
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; } finally { document.removeEventListener('copy', onCopy); }
  try {
    if (navigator.clipboard?.write && typeof ClipboardItem === 'function') navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).catch(() => {});
  } catch { /* not available */ }
  return ok;
}
