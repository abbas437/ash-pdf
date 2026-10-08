// Markup tools for the annotation layer: Select, Shapes (rectangle / ellipse / cloud / line / arrow),
// Draw (freehand ink), Highlight, Whiteout and Redact (marks only, saved as /Redact). Objects go through ui/annotations.js.
// Defaults suit review mark-up of drawings: red #d62828, 1.5 pt, no fill; dotted is one click away.
import { bus } from '../bus.js';
import { state, activeTab } from '../state.js';
import { h, isTyping } from './dom.js';
import { dialogOpen } from './dialogs.js';
import { registerTool, setTool, toggleTool } from './toolbar.js';
import { annotations, selectHandlers } from './annotations.js';

const SHAPES = [
  ['rect', 'Rectangle', 'R', '<rect x="4" y="6" width="16" height="12" rx="1"/>'],
  ['ellipse', 'Ellipse', 'E', '<ellipse cx="12" cy="12" rx="8.5" ry="6.5"/>'],
  ['cloud', 'Cloud (revision cloud)', 'O', '<path d="M7 18a3 3 0 0 1-2.6-4.5A3 3 0 0 1 6 8a3 3 0 0 1 5-2 3 3 0 0 1 5 0 3 3 0 0 1 3.6 3.9A3 3 0 0 1 18 18a3 3 0 0 1-5.5 0A3 3 0 0 1 7 18z"/>'],
  ['line', 'Line', 'L', '<path d="M5 19L19 5"/>'],
  ['arrow', 'Arrow', 'A', '<path d="M5 19L19 5"/><path d="M11 5h8v8"/>'],
];
const MIN_PX = 3;        // smaller drags are treated as clicks
const INK_MIN_STEP = 1.5; // points between ink samples
const MARKUP_TOOLS = new Set(['shapes', 'draw', 'highlight', 'whiteout', 'redact']);
let shapeKind = 'rect';

const svgIcon = (inner) => `<svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`;

function setStyleKey(key, value) {
  state.toolStyle[key] = value;
  bus.emit('state:changed', { key: 'toolStyle', value: state.toolStyle });
}

// ---------------------------------------------------------------- option controls
function shapePicker(c) {
  const seg = h('div.opt-seg', { role: 'group', 'aria-label': 'Shape' });
  for (const [id, label, key, ic] of SHAPES) {
    seg.append(h('button.tb-btn.opt-shape', {
      type: 'button', title: `${label} (${key})`, 'aria-label': label, 'aria-pressed': String(shapeKind === id),
      dataset: { shape: id }, html: svgIcon(ic),
      onclick: () => { shapeKind = id; for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.shape === id)); },
    }));
  }
  c.append(seg);
}
let lastFill = '#ffffff';
function fillCtl(c) {
  const on = !!state.toolStyle.fill;
  const col = h('input.opt-fill-color', { type: 'color', 'aria-label': 'Fill colour', value: state.toolStyle.fill || lastFill, disabled: !on, oninput: (e) => { lastFill = e.target.value; setStyleKey('fill', e.target.value); } });
  const cb = h('input.opt-fill', { type: 'checkbox', 'aria-label': 'Fill', checked: on, onchange: (e) => { col.disabled = !e.target.checked; setStyleKey('fill', e.target.checked ? col.value : null); } });
  c.append(h('label.opt', {}, h('span', {}, 'Fill'), cb, col));
}
const rangeCtl = (label, cls, key, min, max) => (c) => c.append(h('label.opt', {}, h('span', {}, label),
  h(`input.${cls}`, { type: 'range', min: String(min), max: String(max), step: '0.05', value: String(state.toolStyle[key]), oninput: (e) => setStyleKey(key, Number(e.target.value)) })));
const opacityCtl = rangeCtl('Opacity', 'opt-opacity', 'opacity', 0.1, 1);
const hlColorCtl = (c) => c.append(h('label.opt', {}, h('span', {}, 'Colour'), h('input.opt-hl-color', { type: 'color', value: state.toolStyle.hlColor, oninput: (e) => setStyleKey('hlColor', e.target.value) })));
const hlOpacityCtl = rangeCtl('Opacity', 'opt-hl-opacity', 'hlOpacity', 0.1, 0.5);
/** Last factory of the Select tool: no selection -> empty (hidden) options bar. */
function onlyWithSelection(c) {
  const tab = activeTab();
  const sel = tab ? annotations.getSelection(tab).map((id) => annotations.getObject(tab, id)) : [];
  if (!sel.length) { c.replaceChildren(); return; }
  if (sel.every((o) => o.type === 'highlight')) { c.replaceChildren(); hlColorCtl(c); hlOpacityCtl(c); }
}

// ---------------------------------------------------------------- drag-to-create
function styleOf() {
  const s = state.toolStyle;
  return { stroke: s.color, strokeWidth: s.strokeWidth, dash: s.dash, opacity: s.opacity };
}
function constrainBox(a, b, shift) {
  let dx = b.x - a.x, dy = b.y - a.y;
  if (shift) { const m = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * m; dy = Math.sign(dy || 1) * m; }
  return { x: Math.min(a.x, a.x + dx), y: Math.min(a.y, a.y + dy), w: Math.abs(dx), h: Math.abs(dy) };
}
function constrainLine(a, b, shift) {
  if (!shift) return { x2: b.x, y2: b.y };
  const len = Math.hypot(b.x - a.x, b.y - a.y), ang = Math.round(Math.atan2(b.y - a.y, b.x - a.x) / (Math.PI / 4)) * (Math.PI / 4);
  return { x2: a.x + len * Math.cos(ang), y2: a.y + len * Math.sin(ang) };
}
const BUILD = {
  shapes(a, b, shift) {
    if (shapeKind === 'line' || shapeKind === 'arrow') return { type: shapeKind, x1: a.x, y1: a.y, ...constrainLine(a, b, shift), ...styleOf() };
    return { type: shapeKind, ...constrainBox(a, b, shift), ...styleOf(), fill: state.toolStyle.fill ?? null };
  },
  highlight: (a, b, shift) => ({ type: 'highlight', ...constrainBox(a, b, shift), color: state.toolStyle.hlColor, opacity: state.toolStyle.hlOpacity }),
  whiteout: (a, b, shift) => ({ type: 'whiteout', ...constrainBox(a, b, shift), color: '#ffffff' }),
  redact: (a, b, shift) => ({ type: 'redactMark', ...constrainBox(a, b, shift), fill: '#000000' }),
};
function bigEnough(o, scale) {
  if ('x1' in o) return Math.hypot(o.x2 - o.x1, o.y2 - o.y1) * scale >= MIN_PX;
  return Math.max(o.w, o.h) * scale >= MIN_PX && Math.min(o.w, o.h) > 0;
}
/** Light smoothing: 3-point moving average, endpoints kept. */
function smoothPoints(pts) {
  if (pts.length < 3) return pts;
  return pts.map((p, i) => (i === 0 || i === pts.length - 1 ? p : [(pts[i - 1][0] + p[0] + pts[i + 1][0]) / 3, (pts[i - 1][1] + p[1] + pts[i + 1][1]) / 3]));
}

function creator(toolId) {
  let g = null;
  const current = (e) => {
    const p = annotations.toPage(g.tab, g.page, e.clientX, e.clientY);
    if (toolId !== 'draw') return BUILD[toolId](g.start, p, e.shiftKey);
    const last = g.points[g.points.length - 1];
    if (Math.hypot(p.x - last[0], p.y - last[1]) >= INK_MIN_STEP) g.points.push([p.x, p.y]);
    return { type: 'ink', points: g.points, smooth: true, ...styleOf() };
  };
  return {
    onPointerDown(e, { tab, hit }) {
      if (e.button !== 0 || !hit || tab.readOnly) return;
      e.preventDefault();
      try { e.target.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
      if (annotations.getSelection(tab).length) annotations.select(tab, []);
      const start = annotations.toPage(tab, hit.pageIndex, e.clientX, e.clientY);
      g = { tab, page: hit.pageIndex, start, points: [[start.x, start.y]] };
    },
    onPointerMove(e, { tab }) {
      if (!g || g.tab !== tab) return;
      annotations.renderPreview(tab, g.page, { ...current(e), page: g.page });
    },
    onPointerUp(e, { tab }) {
      if (!g || g.tab !== tab) return;
      const obj = current(e);
      const { page } = g;
      g = null;
      annotations.renderPreview(tab, page, null);
      const scale = tab.zoom * (96 / 72);
      if (obj.type === 'ink') {
        if (obj.points.length < 2) return;
        obj.points = smoothPoints(obj.points);
      } else if (!bigEnough(obj, scale)) return;
      const o = annotations.add(tab, { ...obj, page });
      annotations.select(tab, [o.id]);
    },
    cancel(tab) { if (g) { annotations.renderPreview(g.tab, g.page, null); g = null; } else if (tab) annotations.renderPreview(tab, 0, null); },
  };
}

// ---------------------------------------------------------------- init
export function initShapeTools() {
  Object.assign(state.toolStyle, { color: '#d62828', strokeWidth: 1.5, dash: state.toolStyle.dash ?? 'solid', fill: null, opacity: 1, hlColor: '#ffff00', hlOpacity: 0.35 });
  bus.emit('state:changed', { key: 'toolStyle', value: state.toolStyle });
  registerTool({ id: 'select', label: 'Select', icon: 'select', shortcut: 'V', cursor: 'auto', ...selectHandlers, options: ['color', 'strokeWidth', 'dash', fillCtl, opacityCtl, onlyWithSelection] });
  const mk = (id, label, icon, shortcut, options) => {
    const c = creator(id);
    registerTool({ id, label, icon, shortcut, cursor: 'crosshair', options, onPointerDown: c.onPointerDown, onPointerMove: c.onPointerMove, onPointerUp: c.onPointerUp, onDeactivate: () => c.cancel(activeTab()) });
  };
  mk('shapes', 'Shapes: rectangle, ellipse, cloud, line, arrow', 'shapes', 'R / E / O / L / A', [shapePicker, 'dash', 'color', 'strokeWidth', fillCtl, opacityCtl]);
  mk('draw', 'Draw (freehand)', 'draw', 'P', ['dash', 'color', 'strokeWidth', opacityCtl]);
  mk('highlight', 'Highlight area', 'highlight', 'H', [hlColorCtl, hlOpacityCtl]);
  mk('whiteout', 'Whiteout (covers, does not redact)', 'whiteout', 'W', null);
  mk('redact', 'Redact: mark areas to remove', 'redact', 'X', null);
  bus.on('tool:changed', ({ tool }) => document.body.classList.toggle('ann-drawing', MARKUP_TOOLS.has(tool)));
  document.body.classList.toggle('ann-drawing', MARKUP_TOOLS.has(state.tool));
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || dialogOpen() || isTyping(e.target) || !activeTab()) return;
    const k = e.key.toLowerCase();
    const shape = SHAPES.find((s) => s[2].toLowerCase() === k);
    if (shape) { e.preventDefault(); const again = state.tool === 'shapes' && shapeKind === shape[0]; shapeKind = shape[0]; if (again) setTool('select'); else { setTool('shapes'); setTool('shapes'); } return; }
    const tool = { v: 'select', p: 'draw', h: 'highlight', w: 'whiteout', x: 'redact' }[k];
    if (tool) { e.preventDefault(); toggleTool(tool); }
  });
}

export const shapeTools = { setShape: (kind) => { shapeKind = kind; if (state.tool === 'shapes') setTool('shapes'); }, getShape: () => shapeKind };
