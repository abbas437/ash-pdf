// Edit image tool (J): move, scale and delete the image objects of the page content with PDFium
// (pdfium/imgedit.js). Hover outlines and the selection (8 handles) are drawn in the page overlay SVG,
// which uses page space; PDF-space boxes go through imgedit-lib.js with the page's view box and /Rotate.
// Each gesture is one page-operation undo step (runOp, identity map) applied to the bytes directly.
// When the bytes change (tab:bytesChanged, also for Undo/Redo) the selection is found again in the new
// bytes by id and box; a selection the user makes meanwhile wins over that pending re-find.
// Images inside form XObjects are outlined in grey and cannot be edited (the engine refuses them).
import { bus } from '../bus.js';
import { state, activeTab } from '../state.js';
import { h, isTyping } from './dom.js';
import { dialogOpen, toast } from './dialogs.js';
import { addIcon } from './icons.js';
import { registerTool, setTool, toggleTool } from './toolbar.js';
import { viewer } from './viewer.js';
import { runOp } from './pagetools.js';
import { pdfium } from '../pdfium/client.js';
import { boxMatrix } from '../pdfium/imgedit.js';
import { pdfBoxToPage, pageBoxToPdf, dragBox } from './imgedit-lib.js';

addIcon('image-edit', '<rect x="3.5" y="4.5" width="13" height="11" rx="1.2"/><path d="M3.5 13l3.5-3 3 2.5 2-1.5 4.5 3.5"/><path d="M14 13.5l6.5 2.5-2.8 1 -1 2.8z"/>');

const TOOL = 'image-edit';
const FORM_TIP = "This image is inside a form object and can't be edited yet";
const SVG_NS = 'http://www.w3.org/2000/svg';
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const DRAG_PX = 3;

const cache = new WeakMap(); // tab -> { bytes, ready: Map<page, imgs>, loading: Map<page, Promise> }
let sel = null;     // { tab, page, img }
let hover = null;   // { tab, page, img }
let gesture = null; // { tab, page, img, handle, cx, cy, inv, box0, box, moved }
let pending = null; // { tab, page, id, bbox }: placement an apply expects; claimed by its own commit
let refinding = null; // { tab, want }: selection being found again in the new bytes; any select() drops it
let pointer = null; // { tab, hit }: last pointer position, to restore the hover once the images load

const geom = (tab, i) => ({ view: tab.pages[i].view, rotate: tab.pages[i].rotate });
const identity = (n) => new Map(Array.from({ length: n }, (_, k) => [k, k]));

function entry(tab) {
  let c = cache.get(tab);
  if (!c || c.bytes !== tab.bytes) { c = { bytes: tab.bytes, ready: new Map(), loading: new Map() }; cache.set(tab, c); }
  return c;
}
/** Images of page i for the current bytes; resolves from the cache when loaded. */
function loadImages(tab, i) {
  const c = entry(tab);
  if (c.ready.has(i)) return Promise.resolve(c.ready.get(i));
  if (!c.loading.has(i)) {
    c.loading.set(i, (async () => {
      const id = await pdfium.open(c.bytes);
      try { const imgs = await pdfium.pageImages(id, i); c.ready.set(i, imgs); return imgs; } finally { await pdfium.close(id).catch(() => {}); }
    })());
  }
  return c.loading.get(i);
}
const readyImages = (tab, i) => entry(tab).ready.get(i) ?? null;

const pageBox = (tab, i, img) => pdfBoxToPage(geom(tab, i), img.bbox);
const inside = (b, x, y) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
function imageAt(tab, i, x, y) {
  const imgs = readyImages(tab, i) ?? [];
  for (let k = imgs.length - 1; k >= 0; k--) if (inside(pageBox(tab, i, imgs[k]), x, y)) return imgs[k];
  return null;
}
function handlePoints({ x, y, w, h: hh }) {
  const xs = { w: x, '': x + w / 2, e: x + w }, ys = { n: y, '': y + hh / 2, s: y + hh };
  return HANDLES.map((k) => ({ k, x: xs[k.replace(/[ns]/, '')], y: ys[k.replace(/[ew]/, '')] }));
}
function handleAt(tab, box, x, y) {
  const tol = 6 / viewer.scale(tab);
  return handlePoints(box).find((p) => Math.abs(p.x - x) <= tol && Math.abs(p.y - y) <= tol)?.k ?? null;
}

// ---------------------------------------------------------------- drawing
function svgEl(name, attrs, parent) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  parent?.append(el);
  return el;
}
function layer(tab, i) {
  const svg = viewer.getOverlaySvg(tab, i);
  if (!svg) return null;
  let g = svg.querySelector(':scope > g.ie-layer');
  if (!g) g = svgEl('g', { class: 'ie-layer' }, svg);
  else svg.append(g); // keep on top of the annotation layers
  return g;
}
function clearLayers(tab) {
  for (let i = 0; i < (tab?.numPages ?? 0); i++) viewer.getOverlaySvg(tab, i)?.querySelector(':scope > g.ie-layer')?.replaceChildren();
}
function redraw(tab = activeTab()) {
  if (!tab?.view) return;
  clearLayers(tab);
  if (state.tool !== TOOL) return;
  const px = 1 / viewer.scale(tab);
  if (hover?.tab === tab && !(sel?.tab === tab && sel.page === hover.page && sel.img.id === hover.img.id)) {
    const g = layer(tab, hover.page), b = pageBox(tab, hover.page, hover.img);
    if (g) svgEl('rect', { class: 'ie-hover', x: b.x, y: b.y, width: b.w, height: b.h, fill: 'none', stroke: hover.img.inForm ? '#888' : '#1a73e8', 'stroke-width': 1.5 * px, 'stroke-dasharray': `${4 * px} ${3 * px}` }, g);
  }
  if (sel?.tab === tab) {
    const g = layer(tab, sel.page);
    if (!g) return;
    const b = gesture?.box ?? pageBox(tab, sel.page, sel.img);
    svgEl('rect', { class: 'ie-sel', x: b.x, y: b.y, width: b.w, height: b.h, fill: 'none', stroke: '#1a73e8', 'stroke-width': 1.5 * px }, g);
    const s = 7 * px;
    for (const p of handlePoints(b)) svgEl('rect', { class: 'ie-handle', 'data-handle': p.k, x: p.x - s / 2, y: p.y - s / 2, width: s, height: s, fill: '#fff', stroke: '#1a73e8', 'stroke-width': px }, g);
  }
}
function setHover(tab, i, img) {
  if (hover?.tab === tab && hover.page === i && hover.img === img) return;
  const pageEl = viewer.getPageEl(tab, i);
  if (hover && hover.tab === tab) { const old = viewer.getPageEl(tab, hover.page); if (old) { old.removeAttribute('title'); old.style.cursor = ''; } }
  hover = img ? { tab, page: i, img } : null;
  if (pageEl && img) { if (img.inForm) pageEl.title = FORM_TIP; pageEl.style.cursor = img.inForm ? 'not-allowed' : 'move'; }
  redraw(tab);
}
function select(next) {
  refinding = null;
  sel = next;
  if (state.tool === TOOL) setTool(TOOL); // re-render the options bar
  redraw(next?.tab ?? activeTab());
}

// ---------------------------------------------------------------- apply
async function apply(tab, page, img, label, op, expect) {
  // Show the result at once: the selection takes the new placement until it is found again in the new bytes.
  select(expect ? { tab, page, img: { ...img, bbox: expect, matrix: op.transform } } : null);
  const ok = await runOp(tab, label, async (bytes, n) => {
    const id = await pdfium.open(bytes);
    try {
      const out = await pdfium.editImage(id, page, img.id, op);
      pending = expect ? { tab, page, id: img.id, bbox: expect } : null; // set just before runOp commits these bytes
      return { bytes: out, map: identity(n) };
    } finally { await pdfium.close(id).catch(() => {}); }
  });
  if (!ok) { pending = null; redraw(tab); }
  return ok;
}
function deleteSelected() {
  if (!sel) return;
  const { tab, page, img } = sel;
  apply(tab, page, img, 'Delete image', { remove: true }, null);
}
const near = (a, b) => a.every((v, k) => Math.abs(v - b[k]) <= 1);
/** The tab's bytes changed: find the selection again (same id and box, else same box, else same id).
 *  Taken when the bytes change, not when the viewer reloads: superseded reloads emit no tab:loaded, and a
 *  late re-find must not replace a selection the user made in the meantime (select() drops `refinding`). */
async function refind(tab) {
  const want = pending?.tab === tab ? pending : sel?.tab === tab ? { page: sel.page, id: sel.img.id, bbox: sel.img.bbox } : null;
  pending = null;
  if (hover?.tab === tab) setHover(tab, hover.page, null); // its image is from the old bytes
  if (!want) { rehover(tab); return; }
  const r = refinding = { tab, want };
  const imgs = await loadImages(tab, want.page).catch(() => []);
  if (refinding !== r) return; // a newer change or the user's own selection
  const img = imgs.find((m) => m.id === want.id && near(m.bbox, want.bbox)) ?? imgs.find((m) => near(m.bbox, want.bbox)) ?? imgs.find((m) => m.id === want.id) ?? null;
  select(img ? { tab, page: want.page, img } : null);
  rehover(tab);
}
/** Hover the image under the last pointer position once the page's images are loaded. */
function rehover(tab) {
  if (pointer?.tab !== tab || gesture || state.tool !== TOOL) return;
  const { hit } = pointer;
  if (!readyImages(tab, hit.pageIndex)) { loadImages(tab, hit.pageIndex).then(() => rehover(tab)).catch(() => {}); return; }
  setHover(tab, hit.pageIndex, hit.inside ? imageAt(tab, hit.pageIndex, hit.x, hit.y) : null);
}

// ---------------------------------------------------------------- pointer
/** Client delta -> page-space delta for page i (inverse of the page's linear client mapping). */
function clientToPageDelta(tab, i) {
  const o = viewer.pageToClient(tab, i, 0, 0), ax = viewer.pageToClient(tab, i, 1, 0), ay = viewer.pageToClient(tab, i, 0, 1);
  const a = ax.clientX - o.clientX, b = ax.clientY - o.clientY, c = ay.clientX - o.clientX, d = ay.clientY - o.clientY, det = a * d - b * c;
  return (dx, dy) => [(d * dx - c * dy) / det, (a * dy - b * dx) / det];
}
function onPointerDown(e, { tab, hit }) {
  if (e.button !== 0 || !hit || gesture) return;
  const i = hit.pageIndex;
  loadImages(tab, i).then(() => redraw(tab)).catch(() => {});
  let handle = null, img = null;
  if (sel?.tab === tab && sel.page === i) {
    const b = pageBox(tab, i, sel.img);
    handle = handleAt(tab, b, hit.x, hit.y);
    if (handle || inside(b, hit.x, hit.y)) img = sel.img;
  }
  if (!img) img = imageAt(tab, i, hit.x, hit.y);
  if (!img) { if (sel) select(null); return; }
  e.preventDefault();
  if (img.inForm) { toast(FORM_TIP); return; }
  if (sel?.img !== img) select({ tab, page: i, img });
  const box0 = pageBox(tab, i, img);
  gesture = { tab, page: i, img, handle: handle ?? 'move', cx: e.clientX, cy: e.clientY, inv: clientToPageDelta(tab, i), box0, box: box0, moved: false };
  window.addEventListener('pointermove', onGestureMove, true);
  window.addEventListener('pointerup', onGestureUp, true);
}
function gestureBox(e) {
  const [dx, dy] = gesture.inv(e.clientX - gesture.cx, e.clientY - gesture.cy);
  return dragBox(gesture.box0, gesture.handle, dx, dy, e.shiftKey);
}
function onGestureMove(e) {
  if (!gesture) return;
  if (!gesture.moved && Math.hypot(e.clientX - gesture.cx, e.clientY - gesture.cy) < DRAG_PX) return;
  gesture.moved = true;
  gesture.box = gestureBox(e);
  redraw(gesture.tab);
}
function endGesture() {
  window.removeEventListener('pointermove', onGestureMove, true);
  window.removeEventListener('pointerup', onGestureUp, true);
  const g = gesture;
  gesture = null;
  return g;
}
function onGestureUp(e) {
  if (!gesture) return;
  const moved = gesture.moved;
  if (moved) gesture.box = gestureBox(e);
  const g = endGesture();
  if (!moved) return;
  const to = pageBoxToPdf(geom(g.tab, g.page), g.box);
  const matrix = boxMatrix(g.img.matrix, g.img.bbox, to);
  apply(g.tab, g.page, g.img, g.handle === 'move' ? 'Move image' : 'Resize image', { transform: matrix }, to);
}
function onPointerMove(e, { tab, hit }) {
  if (gesture || !hit) return;
  pointer = { tab, hit };
  rehover(tab);
}

// ---------------------------------------------------------------- options, keys, init
function options(c) {
  if (sel) c.append(h('button.btn.ie-delete', { type: 'button', onclick: deleteSelected }, 'Delete'));
  else c.append(h('span.opt-hint', {}, 'Click an image to select it; drag to move, drag a handle to resize (Shift keeps the shape)'));
}
function reset() {
  if (gesture) endGesture();
  const tab = hover?.tab;
  if (tab) setHover(tab, hover.page, null);
  sel = null;
  pending = null;
  refinding = null;
  pointer = null;
  clearLayers(activeTab());
}

export function initImageEdit() {
  registerTool({ id: TOOL, label: 'Edit image', icon: 'image-edit', shortcut: 'J', cursor: 'default', options: [options], onPointerDown, onPointerMove,
    onActivate: () => { const tab = activeTab(); if (tab) loadImages(tab, tab.currentPage ?? 0).catch(() => {}); },
    onDeactivate: reset });
  bus.on('tab:bytesChanged', ({ tab }) => { if (state.tool === TOOL) refind(tab); else pending = null; });
  bus.on('tab:loaded', ({ tab, reloaded }) => { if (reloaded && state.tool === TOOL) redraw(tab); });
  bus.on('page:rendered', ({ tab }) => { if (state.tool === TOOL && (sel?.tab === tab || hover?.tab === tab)) redraw(tab); });
  bus.on('tab:activated', () => { if (state.tool === TOOL) { sel = null; hover = null; refinding = null; pointer = null; setTool(TOOL); } });
  // Capture: Esc deselects before annotations.js turns it into "back to Select".
  window.addEventListener('keydown', (e) => {
    if (state.tool !== TOOL || e.ctrlKey || e.metaKey || e.altKey || dialogOpen() || isTyping(e.target)) return;
    if (e.key === 'Escape' && (gesture || sel)) {
      e.preventDefault(); e.stopPropagation();
      if (gesture) { endGesture(); redraw(); } else select(null);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel && !gesture) {
      e.preventDefault(); e.stopPropagation();
      deleteSelected();
    }
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || dialogOpen() || isTyping(e.target) || !activeTab()) return;
    if (e.key.toLowerCase() === 'j') { e.preventDefault(); toggleTool(TOOL); }
  });
}
