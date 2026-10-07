// Review mark-up: the Callout tool (C) and the Markup + comment tool (M).
//
// A callout is a core `callout` overlay object ({type:'callout', page, x,y,w,h, text, tx,ty, stroke,
// color, fill, fontSize, dash, strokeWidth}) flattened on save by src/core/annotate.js: a comment
// box with wrapped text and a leader line from the box edge nearest the tip to the tip (tx,ty).
// Callout tool: press on the item, drag to where the comment should sit, type, click away.
// Markup tool: drag a dotted ellipse/rectangle over the item, then type a short comment in a box
// placed beside it; shape + comment are one undo step. The blue chip is for follow-up comments.
//
// Exports: initCalloutTools(app), calloutTools (test/inspection helpers).
import { bus } from '../bus.js';
import { state, activeTab } from '../state.js';
import { h, isTyping } from './dom.js';
import { viewer } from './viewer.js';
import { dialogOpen } from './dialogs.js';
import { registerTool, setTool } from './toolbar.js';
import { annotations, resizeBox, dashArray } from './annotations.js';
import { openTextEditor } from './tools-text.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PAD = 4;            // points, same default as the core
const LINE_HEIGHT = 1.2;  // core default
const DEFAULT_W = 160;    // points
const MIN_W = 40;
const GAP = 24;           // points between a markup shape and its comment box
const MARGIN = 4;         // keep comment boxes this far inside the page
const MIN_DRAG_PX = 4;
const MARKUP_WIDTH = 1.5;
const FAMILY = 'Helvetica, Arial, "Liberation Sans", sans-serif';
export const COLORS = [['#d62828', 'Red'], ['#1d4ed8', 'Rev. comment (blue)'], ['#1b7f3b', 'Green'], ['#d97706', 'Orange']];
const FILLS = [['#ffffff', 'White'], ['none', 'None'], ['#fff9c4', 'Pale yellow']];
const HINT = 'Dotted markup + short comment; use the blue chip for follow-up review comments';

let core = null;
const r3 = (n) => Math.round(n * 1000) / 1000;
const paint = (c) => (c && c !== 'none' ? c : 'none');
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const fsOf = (o) => (o.fontSize > 0 ? o.fontSize : 10);
const swOf = (o) => (Number.isFinite(o.strokeWidth) ? o.strokeWidth : 1);

function svgEl(name, attrs, parent) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  parent?.append(el);
  return el;
}

// ---------------------------------------------------------------- layout (same wrap as the core)
function measure(text, fontSize, maxWidth) {
  const opts = { font: 'Helvetica', fontSize, maxWidth, lineHeight: LINE_HEIGHT };
  if (core) return core.measureText(text ?? '', opts);
  const lh = fontSize * LINE_HEIGHT, lines = String(text ?? '').split('\n');
  return { lines, lineHeight: lh, height: lines.length * lh, firstBaseline: (lh - fontSize * 0.93) / 2 + fontSize * 0.72 };
}
/** Box height that fits the text inside the padding (at least one line). */
function fitH(text, fontSize, w) {
  const m = measure(text, fontSize, Math.max(1, w - 2 * PAD));
  return r3(Math.max(m.height, m.lineHeight) + 2 * PAD);
}
/** Leader start: the point of the box nearest the tip (null when the tip is inside the box). */
function leaderStart(o) {
  if (!Number.isFinite(o.tx) || !Number.isFinite(o.ty)) return null;
  const sx = clamp(o.tx, o.x, o.x + o.w), sy = clamp(o.ty, o.y, o.y + o.h);
  return sx === o.tx && sy === o.ty ? null : { x: sx, y: sy };
}
function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, L = dx * dx + dy * dy;
  const t = L ? clamp(((px - x1) * dx + (py - y1) * dy) / L, 0, 1) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// ---------------------------------------------------------------- object type
const calloutType = {
  render(o, parent) {
    const g = svgEl('g', { class: 'ann-callout', opacity: Number.isFinite(o.opacity) ? clamp(o.opacity, 0, 1) : null }, parent);
    const stroke = paint(o.stroke ?? '#ff0000'), sw = swOf(o);
    const s = leaderStart(o);
    if (s) {
      const dx = o.tx - s.x, dy = o.ty - s.y, len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len;
      const hl = Math.min(Math.max(6, sw * 4), len), hw = hl * 0.4;
      const bx = o.tx - ux * hl, by = o.ty - uy * hl;
      svgEl('line', { class: 'ann-callout-leader', x1: r3(s.x), y1: r3(s.y), x2: r3(o.tx - ux * hl * 0.5), y2: r3(o.ty - uy * hl * 0.5), stroke, 'stroke-width': sw, 'stroke-dasharray': dashArray(o.dash, sw) }, g);
      svgEl('path', { class: 'ann-callout-head', d: `M${r3(o.tx)} ${r3(o.ty)}L${r3(bx - uy * hw)} ${r3(by + ux * hw)}L${r3(bx + uy * hw)} ${r3(by - ux * hw)}Z`, fill: stroke, stroke: 'none' }, g);
    }
    svgEl('rect', { class: 'ann-callout-box', x: o.x, y: o.y, width: o.w, height: o.h, fill: paint(o.fill === undefined ? '#ffffff' : o.fill), stroke, 'stroke-width': sw, 'stroke-dasharray': dashArray(o.dash, sw) }, g);
    if (o.text) {
      const fs = fsOf(o), m = measure(o.text, fs, Math.max(1, o.w - 2 * PAD));
      const t = svgEl('text', { 'font-family': FAMILY, 'font-size': r3(fs), fill: o.color ?? o.stroke ?? '#000000' }, g);
      m.lines.forEach((line, i) => {
        if (line !== '') svgEl('tspan', { x: r3(o.x + PAD), y: r3(o.y + PAD + m.firstBaseline + i * m.lineHeight) }, t).textContent = line;
      });
    }
    return g;
  },
  bbox(o) {
    const has = Number.isFinite(o.tx) && Number.isFinite(o.ty);
    const x0 = has ? Math.min(o.x, o.tx) : o.x, y0 = has ? Math.min(o.y, o.ty) : o.y;
    const x1 = has ? Math.max(o.x + o.w, o.tx) : o.x + o.w, y1 = has ? Math.max(o.y + o.h, o.ty) : o.y + o.h;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  },
  handles(o) {
    const { x, y, w, h: hh } = o;
    const hs = [['nw', x, y], ['n', x + w / 2, y], ['ne', x + w, y], ['e', x + w, y + hh / 2], ['se', x + w, y + hh], ['s', x + w / 2, y + hh], ['sw', x, y + hh], ['w', x, y + hh / 2]]
      .map(([id, hx, hy]) => ({ id, x: hx, y: hy }));
    // Tip first: the handle lookup returns the first match, so the tip wins where they overlap.
    return Number.isFinite(o.tx) && Number.isFinite(o.ty) ? [{ id: 'tip', x: o.tx, y: o.ty }, ...hs] : hs;
  },
  hit(o, x, y, tol) {
    if (x >= o.x - tol && x <= o.x + o.w + tol && y >= o.y - tol && y <= o.y + o.h + tol) return true;
    const s = leaderStart(o);
    return !!s && segDist(x, y, s.x, s.y, o.tx, o.ty) <= tol + swOf(o) / 2;
  },
  move: (o, dx, dy) => ({ x: o.x + dx, y: o.y + dy, ...(Number.isFinite(o.tx) ? { tx: o.tx + dx, ty: o.ty + dy } : {}) }),
  resize(o, handle, dx, dy) {
    if (handle === 'tip') return { tx: o.tx + dx, ty: o.ty + dy };
    const b = resizeBox(o, handle, dx, dy);
    let { x, w } = b;
    if (w < MIN_W) { if (handle.includes('w')) x = o.x + o.w - MIN_W; w = MIN_W; }
    return { x, y: b.y, w, h: fitH(o.text, fsOf(o), w) };
  },
  /** Option changes on selected callouts: callout keys (co*) and the shared Select-tool keys. */
  style(o, s, keys) {
    const p = {};
    if (keys.includes('color')) { p.stroke = s.color; p.color = s.color; }
    if (keys.includes('coDash')) p.dash = s.coDash; else if (keys.includes('dash')) p.dash = s.dash;
    if (keys.includes('coFill')) p.fill = s.coFill === 'none' ? null : s.coFill; else if (keys.includes('fill')) p.fill = s.fill ?? null;
    if (keys.includes('coFontSize')) p.fontSize = s.coFontSize;
    if (keys.includes('strokeWidth')) p.strokeWidth = s.strokeWidth;
    if (keys.includes('opacity')) p.opacity = s.opacity;
    if ('fontSize' in p) p.h = fitH(o.text, p.fontSize, o.w);
    return p;
  },
};

// ---------------------------------------------------------------- geometry helpers
/** Point on the edge of a rect/ellipse on the ray from its centre towards p. */
export function edgePoint(shape, p) {
  const cx = shape.x + shape.w / 2, cy = shape.y + shape.h / 2, rx = shape.w / 2, ry = shape.h / 2;
  let dx = p.x - cx, dy = p.y - cy;
  if (!dx && !dy) dx = 1;
  if (shape.type === 'ellipse') {
    const t = Math.atan2(dy / (ry || 1), dx / (rx || 1));
    return { x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) };
  }
  const k = Math.min(dx ? rx / Math.abs(dx) : Infinity, dy ? ry / Math.abs(dy) : Infinity);
  return { x: cx + dx * k, y: cy + dy * k };
}
/** Comment box beside a markup shape: right of it, else left, clamped inside the page. */
function besideBox(tab, page, shape, h0) {
  const { width, height } = viewer.pageSize(tab, page);
  const w = Math.min(DEFAULT_W, width - 2 * MARGIN);
  let x = shape.x + shape.w + GAP;
  if (x + w > width - MARGIN) x = shape.x - GAP - w;
  x = clamp(x, MARGIN, width - MARGIN - w);
  const y = clamp(shape.y + shape.h / 2 - h0 / 2, MARGIN, Math.max(MARGIN, height - MARGIN - h0));
  return { x, y, w };
}
const tipFor = (shape, box) => edgePoint(shape, { x: box.x + box.w / 2, y: box.y + box.h / 2 });

// ---------------------------------------------------------------- style
function calloutStyle() {
  const s = state.toolStyle;
  return { stroke: s.color, color: s.color, fill: s.coFill === 'none' ? null : s.coFill, fontSize: s.coFontSize, dash: s.coDash, strokeWidth: 1 };
}
const editorStyle = (st) => ({ font: 'Helvetica', fontSize: st.fontSize, bold: false, italic: false, color: st.color, align: 'left', lineHeight: LINE_HEIGHT });

// ---------------------------------------------------------------- preview + in-place editing
function previewLayer(tab, page) { return viewer.getOverlaySvg(tab, page)?.querySelector(':scope > g.ann-preview') ?? null; }
function showPreview(tab, page, shape, callout) {
  annotations.renderPreview(tab, page, shape ?? null); // also creates the preview layer
  const L = callout && previewLayer(tab, page);
  if (L) calloutType.render(callout, L);
}

let session = null;     // the open comment editor {tab, page, ed, refresh()}
let swallowEv = null;   // pointerdown that only committed the open comment editor

/**
 * Open the comment editor for a callout at box {x,y,w} with tip (tx,ty). With `shape`, the tip is
 * re-aimed at the shape edge as the box grows, and commit adds shape + callout as one undo step.
 */
function editComment(tab, page, box, tip, { shape = null } = {}) {
  let st = calloutStyle();
  const h0 = fitH('', st.fontSize, box.w);
  const build = (text) => {
    const b = { x: box.x, y: box.y, w: box.w, h: fitH(text, st.fontSize, box.w) };
    const t = shape ? tipFor(shape, b) : tip;
    return { type: 'callout', page, ...b, text, tx: r3(t.x), ty: r3(t.y), ...st };
  };
  const refresh = () => { if (session?.ed) showPreview(tab, page, shape, { ...build(session.ed.textarea.value), text: '' }); };
  const finish = () => { session = null; annotations.renderPreview(tab, page, null); };
  const ed = openTextEditor(tab, page, { x: box.x + PAD, y: box.y + PAD, w: box.w - 2 * PAD, h: h0 - 2 * PAD }, {
    style: editorStyle(st),
    onCommit(text) {
      finish();
      if (!text.trim()) { if (shape) annotations.select(tab, [annotations.add(tab, shape).id]); return; }
      const co = build(text);
      const ids = [];
      annotations.batch(tab, () => {
        if (shape) ids.push(annotations.add(tab, shape).id);
        ids.push(annotations.add(tab, co).id);
      });
      annotations.select(tab, ids);
    },
    onCancel() { finish(); if (shape) annotations.select(tab, [annotations.add(tab, shape).id]); },
  });
  if (!ed) { if (shape) annotations.add(tab, shape); return null; }
  session = { tab, page, ed, refresh, restyle() { st = calloutStyle(); ed.setStyle(editorStyle(st)); refresh(); } };
  ed.textarea.classList.add('callout-editor');
  ed.textarea.addEventListener('input', refresh);
  refresh();
  return ed;
}

// ---------------------------------------------------------------- tools
function boxFromDrag(tip, p, h0) {
  const w = DEFAULT_W;
  return { x: p.x >= tip.x ? p.x : p.x - w, y: p.y >= tip.y ? p.y : p.y - h0, w };
}
function pointerTool(onDone, previewOf) {
  let g = null;
  return {
    onPointerDown(e, { tab, hit }) {
      if (e === swallowEv || e.button !== 0 || !hit || tab.readOnly) return;
      e.preventDefault();
      try { e.target.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
      if (annotations.getSelection(tab).length) annotations.select(tab, []);
      g = { tab, page: hit.pageIndex, start: annotations.toPage(tab, hit.pageIndex, e.clientX, e.clientY), cx: e.clientX, cy: e.clientY };
    },
    onPointerMove(e, { tab }) {
      if (!g || g.tab !== tab) return;
      previewOf(g, annotations.toPage(tab, g.page, e.clientX, e.clientY));
    },
    onPointerUp(e, { tab }) {
      if (!g || g.tab !== tab) return;
      const d = g;
      g = null;
      annotations.renderPreview(tab, d.page, null);
      onDone(d, annotations.toPage(tab, d.page, e.clientX, e.clientY), Math.hypot(e.clientX - d.cx, e.clientY - d.cy) >= MIN_DRAG_PX);
    },
    cancel() { if (g) { annotations.renderPreview(g.tab, g.page, null); g = null; } },
  };
}

const calloutTool = pointerTool((d, p, dragged) => {
  const st = calloutStyle(), h0 = fitH('', st.fontSize, DEFAULT_W);
  const end = dragged ? p : { x: d.start.x + 30, y: d.start.y - 30 };
  editComment(d.tab, d.page, boxFromDrag(d.start, end, h0), d.start);
}, (d, p) => {
  const st = calloutStyle(), h0 = fitH('', st.fontSize, DEFAULT_W);
  showPreview(d.tab, d.page, null, { type: 'callout', ...boxFromDrag(d.start, p, h0), h: h0, text: '', tx: d.start.x, ty: d.start.y, ...st });
});

function markupShape(a, b) {
  return { type: state.toolStyle.mkShape === 'rect' ? 'rect' : 'ellipse', x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y),
    stroke: state.toolStyle.color, strokeWidth: MARKUP_WIDTH, fill: null, dash: 'dotted', opacity: 1 };
}
const markupTool = pointerTool((d, p, dragged) => {
  if (!dragged) return;
  const shape = { ...markupShape(d.start, p), page: d.page };
  if (!(shape.w > 0 && shape.h > 0)) return;
  const st = calloutStyle(), h0 = fitH('', st.fontSize, DEFAULT_W);
  const box = besideBox(d.tab, d.page, shape, h0);
  editComment(d.tab, d.page, box, tipFor(shape, { ...box, h: h0 }), { shape });
}, (d, p) => annotations.renderPreview(d.tab, d.page, { ...markupShape(d.start, p), page: d.page }));

// ---------------------------------------------------------------- options bar
function setStyleKey(key, value) {
  state.toolStyle[key] = value;
  bus.emit('state:changed', { key: 'toolStyle', value: state.toolStyle });
}
const labelled = (text, control, props = {}) => h('label.opt', props, h('span', {}, text), control);
function hintCtl(c) { c.title = HINT; c.append(h('span.co-hint', { title: HINT, 'aria-label': HINT, tabindex: '0' }, 'Review mark-up')); }
const svgIcon = (inner) => `<svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`;
function shapeCtl(c) {
  const seg = h('div.opt-seg', { role: 'group', 'aria-label': 'Markup shape' });
  for (const [id, label, ic] of [['ellipse', 'Ellipse', '<ellipse cx="12" cy="12" rx="8.5" ry="6.5" stroke-dasharray="1.5 2.5"/>'], ['rect', 'Rectangle', '<rect x="4" y="6" width="16" height="12" stroke-dasharray="1.5 2.5"/>']]) {
    seg.append(h('button.tb-btn.co-shape', { type: 'button', title: label, 'aria-label': label, 'aria-pressed': String((state.toolStyle.mkShape ?? 'ellipse') === id), dataset: { shape: id }, html: svgIcon(ic),
      onclick: () => { state.toolStyle.mkShape = id; for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.shape === id)); } }));
  }
  c.append(seg);
}
function dashCtl(c) {
  c.append(labelled('Border', h('select.co-dash', { onchange: (e) => setStyleKey('coDash', e.target.value) },
    ['solid', 'dotted', 'dashed'].map((d) => h('option', { value: d, selected: state.toolStyle.coDash === d }, d[0].toUpperCase() + d.slice(1))))));
}
function colorCtl(c) {
  const seg = h('div.opt-seg.co-chips', { role: 'group', 'aria-label': 'Colour', title: HINT });
  const input = h('input.co-color', { type: 'color', 'aria-label': 'Custom colour', value: state.toolStyle.color });
  const mark = (v) => { for (const b of seg.querySelectorAll('.co-chip')) b.setAttribute('aria-pressed', String(b.dataset.color === v)); input.value = v; };
  const pick = (v) => { mark(v); setStyleKey('color', v); };
  for (const [hex, label] of COLORS) {
    seg.append(h('button.tb-btn.co-chip', { type: 'button', title: label, 'aria-label': label, 'aria-pressed': String(state.toolStyle.color === hex), dataset: { color: hex }, style: { '--chip': hex }, onclick: () => pick(hex) }));
  }
  input.addEventListener('input', (e) => pick(e.target.value));
  seg.append(input);
  c.append(seg);
}
function fillCtl(c) {
  c.append(labelled('Fill', h('select.co-fill', { onchange: (e) => setStyleKey('coFill', e.target.value) },
    FILLS.map(([v, label]) => h('option', { value: v, selected: (state.toolStyle.coFill ?? '#ffffff') === v }, label)))));
}
function sizeCtl(c) {
  c.append(labelled('Size', h('input.co-size', { type: 'number', min: '4', max: '72', step: '0.5', value: String(state.toolStyle.coFontSize),
    onchange: (e) => setStyleKey('coFontSize', Number(e.target.value) > 0 ? Number(e.target.value) : 10) })));
}
const CALLOUT_OPTIONS = [hintCtl, colorCtl, dashCtl, fillCtl, sizeCtl];
const MARKUP_OPTIONS = [hintCtl, shapeCtl, colorCtl, dashCtl, fillCtl, sizeCtl];

// ---------------------------------------------------------------- init
let inited = false;
export function initCalloutTools() {
  if (inited) return;
  inited = true;
  annotations.registerObjectType('callout', calloutType);
  import('../../src/core/index.js').then((m) => { core = m; for (const t of state.tabs) if (t.objects?.some((o) => o.type === 'callout')) annotations.render(t); })
    .catch((err) => console.warn('[callout] core not loaded', err));
  Object.assign(state.toolStyle, { coDash: 'dotted', coFill: '#ffffff', coFontSize: 10, mkShape: 'ellipse', color: state.toolStyle.color ?? '#d62828' });
  bus.emit('state:changed', { key: 'toolStyle', value: state.toolStyle });

  const reg = (id, label, icon, shortcut, tool, options) => registerTool({
    id, label, icon, shortcut, cursor: 'crosshair', options,
    onPointerDown: tool.onPointerDown, onPointerMove: tool.onPointerMove, onPointerUp: tool.onPointerUp,
    onActivate: () => document.body.classList.add('callout-tool'),
    onDeactivate: () => { document.body.classList.remove('callout-tool'); tool.cancel(); },
  });
  reg('callout', 'Callout comment', 'callout', 'C', calloutTool, CALLOUT_OPTIONS);
  reg('markup', 'Markup + comment', svgIcon('<ellipse cx="8.5" cy="14" rx="5.5" ry="4.5" stroke-dasharray="1.4 2.2"/><path d="M13 4.5h7.5v5.5H13z"/><path d="M13 10l-1.5 2"/>'), 'M', markupTool, MARKUP_OPTIONS);
  const cb = document.querySelector('.tb-tools [data-tool="callout"]'), mb = document.querySelector('.tb-tools [data-tool="markup"]');
  if (cb && mb) cb.after(mb);

  // A pointerdown that commits the open comment editor must not also start a new callout.
  window.addEventListener('pointerdown', (e) => { if (session && e.target !== session.ed.textarea && !e.target.closest?.('.options-bar, .dialog, .menu')) swallowEv = e; }, true);
  // tools-text restyles any open editor to the Text tool style; put the comment style back.
  bus.on('state:changed', ({ key }) => { if (key === 'toolStyle' && session) session.restyle(); });
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || dialogOpen() || isTyping(e.target) || !activeTab()) return;
    const tool = { c: 'callout', m: 'markup' }[e.key.toLowerCase()];
    if (tool) { e.preventDefault(); setTool(tool); }
  });
}

export const calloutTools = { fitH, edgePoint, PAD, DEFAULT_W, isEditing: () => !!session };
