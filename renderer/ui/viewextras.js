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
import { bus } from '../bus.js';
import { activeTab } from '../state.js';
import { h, $$ } from './dom.js';
import { addIcon } from './icons.js';
import { viewer } from './viewer.js';
import { registerSidebarTab, refreshSidebarTab } from './sidebar.js';
import { showDialog, showError } from './dialogs.js';
import { layerTree, layerIds, printPageIndices } from './viewextras-lib.js';

const PRINT_DPI = 150;
const api = window.api;

export function initViewExtras() {
  addIcon('layers', '<path d="M12 4l8.5 4.5L12 13 3.5 8.5z"/><path d="M3.5 12.5L12 17l8.5-4.5"/><path d="M3.5 16.5L12 21l8.5-4.5"/>');
  registerSidebarTab({ id: 'layers', label: 'Layers', icon: 'layers', render: renderLayers });
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
    if (annotations && tab.objects?.length) {
      const { flattenObjects } = await import('../../src/core/index.js');
      const bytes = await flattenObjects(tab.bytes.slice(), tab.objects.map((o) => structuredClone(o)));
      const V = new URL('./vendor/pdfjs/', document.baseURI).href; // same resources as viewer.js
      tmp = viewer.pdfjs.getDocument({ data: bytes, password: tab.password ?? undefined, cMapUrl: V + 'cmaps/', cMapPacked: true, standardFontDataUrl: V + 'standard_fonts/',
        wasmUrl: V + 'wasm/', iccUrl: V + 'iccs/', isEvalSupported: false, enableScripting: false });
      doc = await tmp.promise;
    }
    const oc = await printConfig(tab, doc);
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

// Print-intent config of `doc` carrying the current on-screen visibility of tab.ocConfig.
async function printConfig(tab, doc) {
  if (!tab.ocConfig) return null;
  const oc = await doc.getOptionalContentConfig({ intent: 'print' }).catch(() => null);
  if (!oc) return null;
  for (const [id, g] of tab.ocConfig) if (oc.getGroup(id)) oc.setVisibility(id, g.visible, false);
  return oc;
}
