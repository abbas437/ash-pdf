// Measure tools: Distance, Perimeter and Area. Each click places a point in page points; the object
// in progress is drawn as a preview that carries `measure`, so it shows the running value.
//   Distance  : click, click; or press, drag, release. Under 1 pt is ignored.
//   Perimeter : click vertex by vertex; double-click or Enter finishes (2+ points), Backspace removes
//   Area        the last vertex, Esc cancels. Area finishes with 3+ points. A click on the last vertex
//               adds nothing, so a double-click there finishes without a duplicate vertex.
// Shift holds the current segment to 0/45/90° from the previous point. Every point first goes through
// snapHook(tab, page, pt, event) => pt (identity here; measure-snap.js installs object snapping).
// The finished object is one annotations.add (one undo step) and is selected.
// Each tool keeps its own colour and width: onActivate swaps them into the shared state.toolStyle and
// onDeactivate puts the shared values back (remembered in settings 'measure.toolStyle').
import { bus } from '../bus.js';
import { state, activeTab } from '../state.js';
import { isTyping } from './dom.js';
import { dialogOpen } from './dialogs.js';
import { registerTool } from './toolbar.js';
import { annotations } from './annotations.js';
import { scaleChip } from './measure-scale.js';
import { snapAngle } from './measure-scale-lib.js';
import { withValue } from './measure-lib.js';

const MIN_PT = 1;        // shorter distances are ignored
const DRAG_PX = 3;       // a press-release that moved less is a click
const SAME_PX = 3;       // a click this close to the last vertex adds nothing
const DBL_MS = 400;      // second click of a double-click
const STYLE_KEY = 'measure.toolStyle';

const svg = (inner) => `<svg class="icon" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`;
const TOOLS = {
  distance: { id: 'measure-distance', label: 'Measure distance', type: 'line', min: 2, color: '#d32f2f',
    icon: svg('<path d="M2 8h12M2 5.5v5M14 5.5v5M4 8l1.5-1.2M4 8l1.5 1.2M12 8l-1.5-1.2M12 8l-1.5 1.2"/>') },
  perimeter: { id: 'measure-perimeter', label: 'Measure perimeter', type: 'polyline', min: 2, color: '#1565c0',
    icon: svg('<path d="M2 12.5L6 4l4.5 6L14 3.5"/><path d="M1.2 11.6l1.6 1.8M5.1 4.3l1.8-.6M9.9 10.6l1.2-1.2M13.2 3l1.6 1"/>') },
  area: { id: 'measure-area', label: 'Measure area', type: 'polygon', min: 3, color: '#2e7d32',
    icon: svg('<path d="M2.5 12.5L4 3.5l8.5 1.5 1 7.5z"/><path d="M4.3 9L8 5.2M5 11.8l6-6M8.5 12.2l4.2-4.2" stroke-width="0.8"/>') },
};

// ---------------------------------------------------------------- snap hook
let snapHook = (tab, page, pt) => pt;
/** Install the point filter every measure point goes through (before Shift), called with the pointer
 *  event as its 4th argument; null restores identity. */
export function setSnapHook(fn) { snapHook = typeof fn === 'function' ? fn : (tab, page, pt) => pt; }

// ---------------------------------------------------------------- per-tool style
const own = Object.fromEntries(Object.entries(TOOLS).map(([k, t]) => [k, { color: t.color, strokeWidth: 1.5 }]));
let shared = null; // the shared colour and width while a measure tool is active
function swapIn(kind) {
  shared = { color: state.toolStyle.color, strokeWidth: state.toolStyle.strokeWidth };
  Object.assign(state.toolStyle, own[kind]);
  bus.emit('state:changed', { key: 'toolStyle', value: state.toolStyle });
}
function swapOut(kind) {
  if (!shared) return;
  own[kind] = { color: state.toolStyle.color, strokeWidth: state.toolStyle.strokeWidth };
  Object.assign(state.toolStyle, shared);
  shared = null;
  bus.emit('state:changed', { key: 'toolStyle', value: state.toolStyle });
  window.api?.settingsSet?.(STYLE_KEY, own)?.catch?.(() => {});
}

// ---------------------------------------------------------------- one tool
function measureTool(kind) {
  const def = TOOLS[kind];
  let g = null; // {tab, page, scale, pts: [[x,y]], cursor: [x,y]|null, down: {x, y}|null, lastClick: {t, x, y}}
  let quiet = null; // the click that finished by double-click: its repeat does not start a new measurement
  const point = (e) => {
    const raw = annotations.toPage(g.tab, g.page, e.clientX, e.clientY);
    const p = snapHook(g.tab, g.page, raw, e);
    const prev = g.pts[g.pts.length - 1];
    return e.shiftKey && prev ? snapAngle({ x: prev[0], y: prev[1] }, p) : p;
  };
  const build = (pts, scale) => {
    const style = { stroke: state.toolStyle.color, strokeWidth: state.toolStyle.strokeWidth };
    const measure = { kind, scale };
    if (def.type === 'line') return { type: 'line', x1: pts[0][0], y1: pts[0][1], x2: pts[1][0], y2: pts[1][1], ...style, measure };
    return { type: def.type, points: pts.map((p) => [...p]), ...style, ...(def.type === 'polygon' ? { fill: null } : {}), measure };
  };
  const preview = () => {
    const pts = g.cursor ? [...g.pts, g.cursor] : g.pts;
    annotations.renderPreview(g.tab, g.page, pts.length >= 2 ? { ...build(pts, g.scale), page: g.page } : null);
  };
  const cancel = () => { if (g) { annotations.renderPreview(g.tab, g.page, null); g = null; } };
  const finish = () => {
    if (!g) return;
    const { tab, page, pts, scale } = g;
    cancel();
    if (pts.length < def.min) return;
    if (def.type === 'line' && Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) < MIN_PT) return;
    const obj = build(pts, scale);
    const o = annotations.add(tab, { ...obj, measure: withValue(obj), page });
    annotations.select(tab, [o.id]);
  };
  const px = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  return {
    onPointerDown(e, { tab, hit }) {
      if (e.button !== 0 || tab.readOnly) return;
      if (g && g.tab !== tab) cancel();
      if (!g && !hit) return;
      e.preventDefault();
      try { e.target.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
      const now = performance.now(), here = { x: e.clientX, y: e.clientY };
      if (!g) {
        if (quiet && now - quiet.t < DBL_MS && px(quiet, here) <= SAME_PX) return;
        quiet = null;
        if (annotations.getSelection(tab).length) annotations.select(tab, []);
        g = { tab, page: hit.pageIndex, scale: annotations.measureScaleOf(tab, hit.pageIndex).scale, pts: [], cursor: null, down: here, lastClick: null };
        const p = point(e);
        g.pts.push([p.x, p.y]);
        g.lastClick = { t: now, ...here };
        preview();
        return;
      }
      if (def.type === 'line') { // second click of click-click
        const p = point(e);
        g.pts = [g.pts[0], [p.x, p.y]];
        finish();
        return;
      }
      const dbl = g.lastClick && now - g.lastClick.t < DBL_MS && px(g.lastClick, here) <= SAME_PX;
      g.lastClick = { t: now, ...here };
      if (dbl) { quiet = g.lastClick; finish(); return; }
      const p = point(e), last = g.pts[g.pts.length - 1];
      const scale = g.tab.zoom * (96 / 72);
      if (Math.hypot(p.x - last[0], p.y - last[1]) * scale > SAME_PX) g.pts.push([p.x, p.y]);
      g.cursor = null;
      preview();
    },
    onPointerMove(e, { tab }) {
      if (!g || g.tab !== tab) return;
      const p = point(e);
      g.cursor = [p.x, p.y];
      preview();
    },
    onPointerUp(e, { tab }) {
      if (!g || g.tab !== tab || def.type !== 'line' || !g.down) return;
      const dragged = px(g.down, { x: e.clientX, y: e.clientY }) >= DRAG_PX;
      g.down = null;
      if (!dragged) return; // click: wait for the second click
      const p = point(e);
      g.pts = [g.pts[0], [p.x, p.y]];
      finish();
    },
    onKey(e) {
      if (!g) return false;
      if (e.key === 'Escape') cancel();
      else if (e.key === 'Enter') finish();
      else if (e.key === 'Backspace' && def.type !== 'line') {
        if (g.pts.length > 1) { g.pts.pop(); preview(); } else cancel();
      } else return false;
      return true;
    },
    cancel,
  };
}

// ---------------------------------------------------------------- init
export function initMeasureTools() {
  const handlers = {};
  for (const [kind, t] of Object.entries(TOOLS)) {
    const m = measureTool(kind);
    handlers[t.id] = m;
    registerTool({
      id: t.id, label: t.label, icon: t.icon, cursor: 'crosshair', options: [scaleChip(), 'color', 'strokeWidth'],
      onPointerDown: m.onPointerDown, onPointerMove: m.onPointerMove, onPointerUp: m.onPointerUp,
      onActivate: () => swapIn(kind),
      onDeactivate: () => { m.cancel(); swapOut(kind); },
    });
  }
  window.addEventListener('keydown', (e) => {
    const m = handlers[state.tool];
    if (!m || e.ctrlKey || e.metaKey || e.altKey || dialogOpen() || isTyping(e.target) || !activeTab()) return;
    if (m.onKey(e)) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  window.api?.settingsGet?.(STYLE_KEY)?.then?.((v) => {
    if (!v || typeof v !== 'object') return;
    for (const k of Object.keys(own)) {
      const s = v[k];
      if (s && /^#[0-9a-f]{6}$/i.test(s.color ?? '') && Number(s.strokeWidth) > 0) own[k] = { color: s.color, strokeWidth: Number(s.strokeWidth) };
    }
  }, () => {});
}
