// Crop pages > "Draw on page": a crop box on one page of the viewer. Drag on the page to draw it,
// drag its edges/corners (8 handles) to resize, drag inside to move; outside the box is dimmed and
// the box size is shown in the dialog's unit. Enter applies, Esc cancels (both handled here, before
// the dialog's own keys). The box is in page space (points, /Rotate applied, top-left origin): the
// SVG uses the overlay's viewBox and view-rotation transform, so view rotation needs no extra maths.
import { bus } from '../bus.js';
import { rectFromPoints, dragRect, sizeLabel } from './crop-lib.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const svgEl = (tag, attrs = {}) => { const e = document.createElementNS(SVG_NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e; };

/**
 * Start drawing on page i of `tab`. rect: initial box or null. unit(): 'mm' | 'pt'.
 * onChange(rect) on every change by the pointer; onKey('apply' | 'cancel') for Enter / Esc.
 * Returns {setRect(rect|null), refresh(), stop()}.
 */
export function startCropDraw(viewer, tab, i, { rect = null, unit, onChange, onKey }) {
  const pageEl = viewer.getPageEl(tab, i);
  const ref = viewer.getOverlaySvg(tab, i);
  const { width, height } = viewer.pageSize(tab, i);
  const size = { width, height };
  const layer = document.createElement('div');
  layer.className = 'crop-draw';
  layer.dataset.pageIndex = String(i);
  const svg = svgEl('svg', { class: 'overlay-svg crop-svg', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none' });
  const dim = svgEl('path', { class: 'crop-dim', 'fill-rule': 'evenodd' });
  const box = svgEl('rect', { class: 'crop-box', 'data-h': 'move' });
  const handles = HANDLES.map((hd) => svgEl('rect', { class: `crop-handle crop-h-${hd}`, 'data-h': hd }));
  svg.append(dim, box, ...handles);
  const readout = document.createElement('div');
  readout.className = 'crop-readout';
  layer.append(svg, readout);
  pageEl.append(layer);
  let cur = rect, drag = null;

  function toPage(e) {
    const r = pageEl.getBoundingClientRect();
    const [ux, uy] = viewer.getViewport(tab, i).convertToPdfPoint(e.clientX - r.left, e.clientY - r.top);
    const [x, y] = tab.pages[i].getViewport({ scale: 1 }).convertToViewportPoint(ux, uy);
    return { x, y };
  }
  function paint() {
    svg.style.width = ref.style.width; svg.style.height = ref.style.height;
    if (ref.dataset.viewRotation) svg.dataset.viewRotation = ref.dataset.viewRotation; else delete svg.dataset.viewRotation;
    const show = !!cur;
    for (const e of [box, ...handles]) e.style.display = show ? '' : 'none';
    readout.hidden = !show;
    if (!show) { dim.setAttribute('d', ''); return; }
    const { x0, y0, x1, y1 } = cur;
    dim.setAttribute('d', `M0 0H${width}V${height}H0Z M${x0} ${y0}H${x1}V${y1}H${x0}Z`);
    Object.entries({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }).forEach(([k, v]) => box.setAttribute(k, String(v)));
    const s = 8 / viewer.scale(tab); // handles stay 8 CSS px at any zoom
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    const at = { nw: [x0, y0], n: [mx, y0], ne: [x1, y0], e: [x1, my], se: [x1, y1], s: [mx, y1], sw: [x0, y1], w: [x0, my] };
    handles.forEach((el, k) => { const [x, y] = at[HANDLES[k]]; el.setAttribute('x', x - s / 2); el.setAttribute('y', y - s / 2); el.setAttribute('width', s); el.setAttribute('height', s); });
    readout.textContent = sizeLabel(cur, unit());
  }
  layer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const p = toPage(e);
    const hd = e.target.dataset?.h;
    drag = hd && cur ? { hd, p, start: cur } : { hd: 'new', p };
    layer.setPointerCapture(e.pointerId);
  });
  layer.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = toPage(e);
    cur = drag.hd === 'new' ? rectFromPoints(drag.p, p, size) : dragRect(drag.start, drag.hd, p.x - drag.p.x, p.y - drag.p.y, size);
    paint(); onChange(cur);
  });
  const end = () => { drag = null; };
  layer.addEventListener('pointerup', end);
  layer.addEventListener('pointercancel', end);
  function onKeyDown(e) {
    if (e.key !== 'Enter' && e.key !== 'Escape') return;
    e.preventDefault(); e.stopPropagation();
    onKey(e.key === 'Enter' ? 'apply' : 'cancel');
  }
  window.addEventListener('keydown', onKeyDown, true); // before the dialog's document-level handler
  const offZoom = bus.on('zoom:changed', ({ tab: t }) => { if (t === tab) paint(); });
  paint();
  return {
    setRect(r) { cur = r; paint(); },
    refresh: paint,
    stop() { window.removeEventListener('keydown', onKeyDown, true); offZoom(); layer.remove(); },
  };
}
