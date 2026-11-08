// Object snapping for the measure tools (tools-measure.js setSnapHook). A measure point within 8 screen
// px of a straight-segment end in the page content (measure-snap-lib.js snapPointsFromOps) lands on it
// exactly; Alt held turns snapping off. While a measure tool is active an 8 px square marker shows the
// point a click would snap to.
//
// Snap points are read from pdf.js getOperatorList in PDF user space and converted once, at load, to
// annotation page space (points, origin top-left, /Rotate and the view box offset applied) with the
// same scale-1 viewport viewer.clientToPage uses. Per tab, per page they are cached (a Promise while
// loading); a page starts loading when a measure tool is activated (current page) and when the
// pointer is over it. The hook never waits: until a page's points are in, points pass unchanged.
// The cache follows tab.pages (a reload replaces them) and is dropped on tab:bytesChanged.
import { bus } from '../bus.js';
import { state, activeTab } from '../state.js';
import { h } from './dom.js';
import { viewer, PDF_TO_CSS } from './viewer.js';
import { setSnapHook } from './tools-measure.js';
import { snapPointsFromOps, nearestSnap } from './measure-snap-lib.js';

const SNAP_PX = 8;
const isMeasure = (tool) => tool === 'measure';

// ---------------------------------------------------------------- cache
const cache = new WeakMap(); // tab -> {pages: tab.pages, map: Map<pageIndex, points | Promise>}
function entry(tab) {
  let e = cache.get(tab);
  if (!e || e.pages !== tab.pages) cache.set(tab, e = { pages: tab.pages, map: new Map() });
  return e;
}
function load(tab, i) {
  if (!tab?.pages?.[i]) return;
  const { map } = entry(tab);
  if (map.has(i)) return;
  const page = tab.pages[i];
  map.set(i, (async () => {
    let pts = [];
    try {
      const raw = snapPointsFromOps(await page.getOperatorList(), viewer.pdfjs.OPS);
      const vp = page.getViewport({ scale: 1 });
      pts = raw.map(([x, y]) => vp.convertToViewportPoint(x, y));
    } catch { /* damaged page: no snap points */ }
    map.set(i, pts);
    return pts;
  })());
}
/** Loaded snap points of page i (page space), or null while loading (the load is started). */
function pointsOf(tab, i) {
  load(tab, i);
  const v = cache.get(tab)?.map.get(i);
  return Array.isArray(v) ? v : null;
}
/** The snap point near page-space pt on page i: [x, y] or null. */
function snapAt(tab, i, pt) {
  const pts = pointsOf(tab, i);
  return pts && nearestSnap(pts, pt.x, pt.y, SNAP_PX / ((tab.zoom || 1) * PDF_TO_CSS));
}

// ---------------------------------------------------------------- marker
let marker = null;
function showMarker(tab, i, p) {
  marker ??= document.body.appendChild(h('div.measure-snap-marker', { hidden: true, 'aria-hidden': 'true' }));
  const c = viewer.pageToClient(tab, i, p[0], p[1]);
  marker.style.left = `${c.clientX - SNAP_PX / 2}px`;
  marker.style.top = `${c.clientY - SNAP_PX / 2}px`;
  marker.hidden = false;
}
function hideMarker() { if (marker) marker.hidden = true; }

function onMove(e) {
  const tab = activeTab();
  if (!isMeasure(state.tool) || !tab?.view) return;
  const hit = !e.altKey && e.target.closest?.('.page') ? viewer.clientToPage(tab, e.clientX, e.clientY) : null;
  const p = hit && snapAt(tab, hit.pageIndex, hit);
  if (p) showMarker(tab, hit.pageIndex, p); else hideMarker();
}

// ---------------------------------------------------------------- init
export function initMeasureSnap() {
  setSnapHook((tab, page, pt, ev) => {
    if (ev?.altKey) return pt;
    const p = snapAt(tab, page, pt);
    return p ? { x: p[0], y: p[1] } : pt;
  });
  window.addEventListener('pointermove', onMove, { passive: true });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' || e.key === 'Alt') hideMarker(); }, true);
  window.addEventListener('scroll', hideMarker, { capture: true, passive: true });
  bus.on('tool:changed', ({ tool }) => {
    hideMarker();
    const tab = activeTab();
    if (isMeasure(tool) && tab) load(tab, tab.currentPage ?? 0);
  });
  bus.on('zoom:changed', hideMarker);
  bus.on('tab:activated', hideMarker);
  bus.on('tab:bytesChanged', ({ tab }) => { cache.delete(tab); hideMarker(); });
}
