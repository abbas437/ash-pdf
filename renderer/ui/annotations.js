// Annotation layer: per-tab store of core overlay objects (docs/CORE-API.md, flattenObjects),
// undo/redo history, SVG rendering in each page's overlay and the selection/move/resize engine.
//
// Coordinates are always visible page space in POINTS (origin top-left, /Rotate applied); the
// overlay SVG's viewBox is that space, so zoom and view rotation never touch stored objects.
//
// Public API (window.ashStudio.annotations is the same object):
//   annotations.add(tab, obj)                      -> obj (id/page filled in), selected=false
//   annotations.update(tab, id, patch, {coalesce}) -> undoable; same `coalesce` key as the
//                                                     previous update merges into one undo step
//   annotations.remove(tab, ids)
//   annotations.select(tab, ids) / getSelection(tab) -> ids[] / getObject(tab, id) / list(tab, page?)
//   annotations.undo(tab) / redo(tab) / batch(tab, fn)  (batch: one undo step for every change in fn)
//   annotations.newId()
//   annotations.remapPages(tab, Map<oldIndex, newIndex|null>)  (also on bus 'pages:remapped' {tab, map})
//   annotations.registerObjectType(type, { render(obj, svgParent) -> SVGElement,
//       bbox(obj) -> {x,y,w,h}, handles(obj) -> [{id,x,y}], hit?(obj,x,y,tol) -> bool,
//       move(obj, dx, dy) -> patch, resize(obj, handleId, dx, dy) -> patch,
//       style?(obj, toolStyle, changedKeys) -> patch })
//     move/resize receive the object as it was when the drag started plus the TOTAL delta and
//     return a patch (they must not mutate). Box types use handles nw,n,ne,e,se,s,sw,w.
//   annotations.applyStyle(tab, changedKeys)  -> applies state.toolStyle keys to the selection
//   annotations.toPage(tab, pageIndex, clientX, clientY) -> {x, y} in that page's points
//
// Save: a beforeSave hook flattens tab.objects into the bytes being written. tab.bytes is NOT
// replaced by the flattened output (the hook restores it), so the objects stay editable and the
// next save flattens again from the unflattened bytes. Limitation: a saved file shows the
// objects as page content; reopening it does not make them editable again.
import { bus } from '../bus.js';
import { state, activeTab, markDirty } from '../state.js';
import { viewer } from './viewer.js';
import { h, isTyping } from './dom.js';
import { dialogOpen } from './dialogs.js';
import { setTool } from './toolbar.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_HISTORY = 200;
const HANDLE_PX = 8;     // handle size on screen
const HIT_PX = 5;        // hit tolerance on screen
const PASTE_OFFSET = 12; // points

const types = new Map();
const selections = new WeakMap(); // tab -> Set<id>
let idSeq = 0;
let clipboard = [];
let pasteCount = 0;
let gesture = null;      // active select-tool drag
let batchDepth = 0;
let batchCmds = null;

// ---------------------------------------------------------------- helpers
function svgEl(name, attrs = {}, parent = null) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, String(v));
  parent?.append(el);
  return el;
}
const r3 = (n) => Math.round(n * 1000) / 1000;
const clone = (o) => ({ ...o, ...(o.points ? { points: o.points.map((p) => [...p]) } : {}) });
const paint = (c) => (c && c !== 'none' ? c : 'none');
const opacityOf = (o, d = 1) => (Number.isFinite(o) ? Math.min(1, Math.max(0, o)) : d);
/** Same dash arrays as the core library: s = max(width, 1); dotted [s, 2s], dashed [5s, 3s]. */
export function dashArray(dash, width) {
  const s = Math.max(width || 1, 1);
  if (dash === 'dotted') return `${r3(s)} ${r3(2 * s)}`;
  if (dash === 'dashed') return `${r3(5 * s)} ${r3(3 * s)}`;
  return null;
}
function ensureTab(tab) {
  tab.objects ??= [];
  tab.undo ??= [];
  tab.redo ??= [];
  if (!selections.has(tab)) selections.set(tab, new Set());
  return tab;
}
const selOf = (tab) => ensureTab(tab) && selections.get(tab);
const scaleOf = (tab) => viewer.scale(tab); // CSS px per point

// ---------------------------------------------------------------- built-in object types
const BOX_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
function boxHandles(b) {
  const { x, y, w, h: hh } = b;
  const P = { nw: [x, y], n: [x + w / 2, y], ne: [x + w, y], e: [x + w, y + hh / 2], se: [x + w, y + hh], s: [x + w / 2, y + hh], sw: [x, y + hh], w: [x, y + hh / 2] };
  return BOX_HANDLES.map((id) => ({ id, x: P[id][0], y: P[id][1] }));
}
/** Resize box {x,y,w,h} by dragging `handle` by (dx,dy); result normalised to w,h >= 0. */
export function resizeBox(b, handle, dx, dy) {
  let { x, y, w, h: hh } = b;
  if (handle.includes('w')) { x += dx; w -= dx; }
  if (handle.includes('e')) w += dx;
  if (handle.includes('n')) { y += dy; hh -= dy; }
  if (handle.includes('s')) hh += dy;
  if (w < 0) { x += w; w = -w; }
  if (hh < 0) { y += hh; hh = -hh; }
  return { x, y, w, h: hh };
}
const boxType = (render, extra = {}) => ({
  render,
  bbox: (o) => ({ x: o.x, y: o.y, w: o.w, h: o.h }),
  handles: (o) => boxHandles(o),
  hit: (o, x, y, tol) => x >= o.x - tol && x <= o.x + o.w + tol && y >= o.y - tol && y <= o.y + o.h + tol,
  move: (o, dx, dy) => ({ x: o.x + dx, y: o.y + dy }),
  resize: (o, handle, dx, dy) => resizeBox(o, handle, dx, dy),
  ...extra,
});
function strokeAttrs(o, defWidth = 1) {
  const sw = Number.isFinite(o.strokeWidth) ? o.strokeWidth : defWidth;
  return { stroke: paint(o.stroke ?? '#000000'), 'stroke-width': sw, 'stroke-dasharray': dashArray(o.dash, sw), opacity: opacityOf(o.opacity) };
}
const shapeStyle = (o, s, keys) => {
  const p = {};
  if (keys.includes('color')) p.stroke = s.color;
  if (keys.includes('strokeWidth')) p.strokeWidth = s.strokeWidth;
  if (keys.includes('dash')) p.dash = s.dash;
  if (keys.includes('opacity')) p.opacity = s.opacity;
  if (keys.includes('fill') && (o.type === 'rect' || o.type === 'ellipse')) p.fill = s.fill ?? null;
  return p;
};
function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / L)) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
function lineType(isArrow) {
  return {
    render(o, parent) {
      const g = svgEl('g', { opacity: opacityOf(o.opacity) }, parent);
      const sw = Number.isFinite(o.strokeWidth) ? o.strokeWidth : 1;
      const dx = o.x2 - o.x1, dy = o.y2 - o.y1, len = Math.hypot(dx, dy);
      let x2 = o.x2, y2 = o.y2;
      if (isArrow && len > 0) {
        const hl = Math.min(Number.isFinite(o.headSize) ? o.headSize : Math.max(8, sw * 4), len);
        const ux = dx / len, uy = dy / len, bx = o.x2 - ux * hl, by = o.y2 - uy * hl, hw = hl * 0.45;
        svgEl('path', { d: `M${r3(o.x2)} ${r3(o.y2)}L${r3(bx - uy * hw)} ${r3(by + ux * hw)}L${r3(bx + uy * hw)} ${r3(by - ux * hw)}Z`, fill: paint(o.stroke ?? '#000000') }, g);
        x2 = o.x2 - ux * hl * 0.5; y2 = o.y2 - uy * hl * 0.5;
      }
      svgEl('line', { x1: o.x1, y1: o.y1, x2, y2, stroke: paint(o.stroke ?? '#000000'), 'stroke-width': sw, 'stroke-dasharray': dashArray(o.dash, sw), 'stroke-linecap': o.dash && o.dash !== 'solid' ? 'butt' : 'round' }, g);
      return g;
    },
    bbox: (o) => ({ x: Math.min(o.x1, o.x2), y: Math.min(o.y1, o.y2), w: Math.abs(o.x2 - o.x1), h: Math.abs(o.y2 - o.y1) }),
    handles: (o) => [{ id: 'p1', x: o.x1, y: o.y1 }, { id: 'p2', x: o.x2, y: o.y2 }],
    hit: (o, x, y, tol) => segDist(x, y, o.x1, o.y1, o.x2, o.y2) <= tol + (o.strokeWidth || 1) / 2,
    move: (o, dx, dy) => ({ x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy }),
    resize: (o, handle, dx, dy) => (handle === 'p1' ? { x1: o.x1 + dx, y1: o.y1 + dy } : { x2: o.x2 + dx, y2: o.y2 + dy }),
    style: shapeStyle,
  };
}
/** SVG path through points; smooth = the core's Catmull-Rom -> cubic Bezier. */
export function polyPath(pts, smooth) {
  if (!pts?.length) return '';
  let d = `M${r3(pts[0][0])} ${r3(pts[0][1])}`;
  if (!smooth || pts.length < 3) { for (const p of pts.slice(1)) d += `L${r3(p[0])} ${r3(p[1])}`; return d; }
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${r3(c1[0])} ${r3(c1[1])} ${r3(c2[0])} ${r3(c2[1])} ${r3(p2[0])} ${r3(p2[1])}`;
  }
  return d;
}
function pointsBox(pts) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
const polyType = {
  render: (o, parent) => svgEl('path', { d: polyPath(o.points, o.smooth), fill: 'none', 'stroke-linejoin': 'round', 'stroke-linecap': 'round', ...strokeAttrs(o, 2) }, parent),
  bbox: (o) => pointsBox(o.points),
  handles: (o) => boxHandles(pointsBox(o.points)),
  hit: (o, x, y, tol) => o.points.some((p, i) => i > 0 && segDist(x, y, o.points[i - 1][0], o.points[i - 1][1], p[0], p[1]) <= tol + (o.strokeWidth ?? 2) / 2),
  move: (o, dx, dy) => ({ points: o.points.map(([x, y]) => [x + dx, y + dy]) }),
  resize(o, handle, dx, dy) {
    const b = pointsBox(o.points), nb = resizeBox(b, handle, dx, dy);
    const sx = b.w ? nb.w / b.w : 1, sy = b.h ? nb.h / b.h : 1;
    // A flipped box mirrors the points.
    const fx = handle.includes('w') ? b.x + dx > b.x + b.w : handle.includes('e') && b.w + dx < 0;
    const fy = handle.includes('n') ? b.y + dy > b.y + b.h : handle.includes('s') && b.h + dy < 0;
    return { points: o.points.map(([x, y]) => [nb.x + (fx ? b.x + b.w - x : x - b.x) * sx, nb.y + (fy ? b.y + b.h - y : y - b.y) * sy]) };
  },
  style: shapeStyle,
};
function registerBuiltins() {
  registerObjectType('rect', boxType((o, p) => svgEl('rect', { x: o.x, y: o.y, width: o.w, height: o.h, fill: paint(o.fill), ...strokeAttrs(o) }, p), { style: shapeStyle }));
  registerObjectType('ellipse', boxType((o, p) => svgEl('ellipse', { cx: o.x + o.w / 2, cy: o.y + o.h / 2, rx: o.w / 2, ry: o.h / 2, fill: paint(o.fill), ...strokeAttrs(o) }, p), { style: shapeStyle }));
  registerObjectType('line', lineType(false));
  registerObjectType('arrow', lineType(true));
  registerObjectType('polyline', polyType);
  registerObjectType('ink', polyType);
  registerObjectType('highlight', boxType((o, p) => svgEl('rect', { class: 'ann-highlight', x: o.x, y: o.y, width: o.w, height: o.h, fill: paint(o.color ?? '#ffff00'), opacity: Math.min(opacityOf(o.opacity, 0.4), 0.5) }, p), {
    style: (o, s, keys) => ({ ...(keys.includes('hlColor') ? { color: s.hlColor } : {}), ...(keys.includes('hlOpacity') ? { opacity: s.hlOpacity } : {}) }),
  }));
  registerObjectType('whiteout', boxType((o, p) => {
    const g = svgEl('g', {}, p);
    svgEl('rect', { x: o.x, y: o.y, width: o.w, height: o.h, fill: paint(o.color ?? '#ffffff') }, g);
    // Editor-only outline so a white box on a white page stays visible; not flattened.
    svgEl('rect', { class: 'ann-whiteout-hint', x: o.x, y: o.y, width: o.w, height: o.h, fill: 'none' }, g);
    return g;
  }, { style: () => ({}) }));
}

export function registerObjectType(type, def) {
  if (!type || typeof def?.render !== 'function') throw new TypeError('registerObjectType: type and render() required');
  types.set(type, def);
}

// ---------------------------------------------------------------- history
function applyCmd(tab, cmd, dir) { // dir: 'do' | 'undo'
  const objs = tab.objects;
  if (cmd.kind === 'batch') {
    const list = dir === 'do' ? cmd.cmds : [...cmd.cmds].reverse();
    for (const c of list) applyCmd(tab, c, dir);
  } else if ((cmd.kind === 'add' || cmd.kind === 'remove') && (cmd.kind === 'add') === (dir === 'do')) { // insert
    for (const it of [...cmd.items].sort((a, b) => a.index - b.index)) objs.splice(Math.min(it.index, objs.length), 0, clone(it.obj));
  } else if (cmd.kind === 'add' || cmd.kind === 'remove') { // delete
    const ids = new Set(cmd.items.map((it) => it.obj.id));
    tab.objects = objs.filter((o) => !ids.has(o.id));
    for (const id of ids) selOf(tab).delete(id);
  } else if (cmd.kind === 'update') {
    for (const c of cmd.changes) {
      const o = objs.find((x) => x.id === c.id);
      if (o) Object.assign(o, clone(dir === 'do' ? c.after : c.before));
    }
  }
}
function commit(tab, cmd, coalesce = null) {
  if (batchDepth) { batchCmds.push(cmd); return; }
  const top = tab.undo[tab.undo.length - 1];
  if (coalesce && cmd.kind === 'update' && top?.kind === 'update' && top.coalesce === coalesce
      && top.changes.length === cmd.changes.length && top.changes.every((c, k) => c.id === cmd.changes[k].id)) {
    top.changes.forEach((c, k) => { c.before = { ...cmd.changes[k].before, ...c.before }; c.after = { ...c.after, ...cmd.changes[k].after }; });
  } else {
    tab.undo.push({ ...cmd, coalesce });
    if (tab.undo.length > MAX_HISTORY) tab.undo.shift();
  }
  tab.redo.length = 0;
  changed(tab);
}
function changed(tab, pages = null) {
  markDirty(tab);
  renderAll(tab, pages);
  bus.emit('annotations:changed', { tab });
}

// ---------------------------------------------------------------- store API
export function newId() { return `ann-${Date.now().toString(36)}-${(++idSeq).toString(36)}`; }

function add(tab, obj) {
  ensureTab(tab);
  if (!types.has(obj?.type)) throw new TypeError(`annotations.add: unknown type ${obj?.type}`);
  const o = clone({ ...obj, id: obj.id ?? newId(), page: obj.page ?? tab.currentPage });
  tab.objects.push(o);
  commit(tab, { kind: 'add', items: [{ obj: clone(o), index: tab.objects.length - 1 }] });
  return o;
}
function addMany(tab, list) {
  ensureTab(tab);
  const items = list.map((obj) => { const o = clone({ ...obj, id: newId() }); tab.objects.push(o); return { obj: clone(o), index: tab.objects.length - 1 }; });
  if (items.length) commit(tab, { kind: 'add', items });
  return items.map((it) => it.obj.id);
}
function updateMany(tab, patches, { coalesce } = {}) { // patches: Map<id, patch>
  ensureTab(tab);
  const changes = [];
  for (const [id, patch] of patches) {
    const o = tab.objects.find((x) => x.id === id);
    if (!o || !patch) continue;
    const keys = Object.keys(patch).filter((k) => k !== 'id');
    if (!keys.length) continue;
    const before = clone(Object.fromEntries(keys.map((k) => [k, o[k]])));
    Object.assign(o, clone(Object.fromEntries(keys.map((k) => [k, patch[k]]))));
    changes.push({ id, before, after: clone(Object.fromEntries(keys.map((k) => [k, o[k]]))) });
  }
  if (changes.length) commit(tab, { kind: 'update', changes }, coalesce ?? null);
}
function update(tab, id, patch, opts = {}) { updateMany(tab, new Map([[id, patch]]), opts); }
function remove(tab, ids) {
  ensureTab(tab);
  const set = new Set([ids].flat());
  const items = tab.objects.flatMap((o, index) => (set.has(o.id) ? [{ obj: clone(o), index }] : []));
  if (!items.length) return;
  tab.objects = tab.objects.filter((o) => !set.has(o.id));
  for (const id of set) selOf(tab).delete(id);
  commit(tab, { kind: 'remove', items });
  selectionChanged(tab);
}
function select(tab, ids) {
  const s = selOf(tab);
  s.clear();
  for (const id of [ids ?? []].flat()) if (tab.objects.some((o) => o.id === id)) s.add(id);
  renderAll(tab);
  selectionChanged(tab);
}
const getSelection = (tab) => [...selOf(tab)];
const getObject = (tab, id) => ensureTab(tab).objects.find((o) => o.id === id) ?? null;
const list = (tab, page) => ensureTab(tab).objects.filter((o) => page == null || o.page === page);

function undo(tab) {
  ensureTab(tab);
  const cmd = tab.undo.pop();
  if (!cmd) return false;
  applyCmd(tab, cmd, 'undo');
  tab.redo.push(cmd);
  changed(tab);
  selectionChanged(tab);
  return true;
}
function redo(tab) {
  ensureTab(tab);
  const cmd = tab.redo.pop();
  if (!cmd) return false;
  applyCmd(tab, cmd, 'do');
  tab.undo.push(cmd);
  changed(tab);
  selectionChanged(tab);
  return true;
}
/** Run fn(); every add/update/remove inside it becomes ONE undo step. */
function batch(tab, fn) {
  ensureTab(tab);
  if (batchDepth++ === 0) batchCmds = [];
  try { fn(); } finally {
    if (--batchDepth === 0) {
      const cmds = batchCmds;
      batchCmds = null;
      if (cmds.length) commit(tab, { kind: 'batch', cmds });
    }
  }
}
function remapPages(tab, map) {
  ensureTab(tab);
  const before = tab.objects.length;
  tab.objects = tab.objects.filter((o) => !map.has(o.page) || map.get(o.page) != null);
  for (const o of tab.objects) if (map.has(o.page)) o.page = map.get(o.page);
  // Snapshots in the history refer to old page indices: page operations reset the history.
  tab.undo.length = 0;
  tab.redo.length = 0;
  for (const id of [...selOf(tab)]) if (!getObject(tab, id)) selOf(tab).delete(id);
  if (before !== tab.objects.length || tab.objects.length) changed(tab);
  else renderAll(tab);
  selectionChanged(tab);
}

// ---------------------------------------------------------------- rendering
function layers(tab, i) {
  const svg = viewer.getOverlaySvg(tab, i);
  if (!svg) return null;
  let objs = svg.querySelector(':scope > g.ann-objects');
  if (!objs) {
    objs = svgEl('g', { class: 'ann-objects' }, svg);
    svgEl('g', { class: 'ann-preview' }, svg);
    svgEl('g', { class: 'ann-selection' }, svg);
  }
  return { svg, objs, preview: svg.querySelector(':scope > g.ann-preview'), sel: svg.querySelector(':scope > g.ann-selection') };
}
function renderPage(tab, i) {
  const L = layers(tab, i);
  if (!L) return;
  ensureTab(tab);
  L.objs.replaceChildren();
  L.sel.replaceChildren();
  const sel = selOf(tab);
  const px = 1 / scaleOf(tab);
  for (const o of tab.objects) {
    if (o.page !== i) continue;
    const def = types.get(o.type);
    if (!def) continue;
    const el = def.render(o, L.objs);
    if (el && !el.parentNode) L.objs.append(el);
    el?.setAttribute('data-obj-id', o.id);
  }
  const selected = tab.objects.filter((o) => o.page === i && sel.has(o.id));
  for (const o of selected) {
    const def = types.get(o.type);
    const b = def.bbox?.(o);
    if (!b) continue;
    const pad = 3 * px;
    svgEl('rect', { class: 'ann-bbox', x: b.x - pad, y: b.y - pad, width: b.w + 2 * pad, height: b.h + 2 * pad }, L.sel);
  }
  if (selected.length === 1) {
    const o = selected[0];
    const hs = HANDLE_PX * px;
    for (const hd of types.get(o.type).handles?.(o) ?? []) {
      svgEl('rect', { class: 'ann-handle', 'data-handle': hd.id, x: hd.x - hs / 2, y: hd.y - hs / 2, width: hs, height: hs }, L.sel);
    }
  }
}
function renderAll(tab, pages = null) {
  if (!tab?.view) return;
  for (let i = 0; i < tab.numPages; i++) if (!pages || pages.includes(i)) renderPage(tab, i);
  updateChrome();
}

/** Draw `obj` (or nothing, when null) as the in-progress preview on page i. */
function renderPreview(tab, i, obj) {
  for (let k = 0; k < (tab.numPages ?? 0); k++) layers(tab, k)?.preview.replaceChildren();
  if (!obj) return;
  const L = layers(tab, i);
  const el = L && types.get(obj.type)?.render(obj, L.preview);
  if (el && !el.parentNode) L.preview.append(el);
}

// ---------------------------------------------------------------- pointer helpers
/**
 * Client point -> page-space point ON PAGE i. viewer.clientToPage picks the page under the
 * pointer; when that is another page (drag past the edge) the page's affine map is inverted.
 */
export function toPage(tab, i, clientX, clientY) {
  const hit = viewer.clientToPage(tab, clientX, clientY);
  if (hit && hit.pageIndex === i) return { x: hit.x, y: hit.y };
  const o = viewer.pageToClient(tab, i, 0, 0), a = viewer.pageToClient(tab, i, 1, 0), b = viewer.pageToClient(tab, i, 0, 1);
  const ax = a.clientX - o.clientX, ay = a.clientY - o.clientY, bx = b.clientX - o.clientX, by = b.clientY - o.clientY;
  const det = ax * by - ay * bx, dx = clientX - o.clientX, dy = clientY - o.clientY;
  return { x: (dx * by - dy * bx) / det, y: (ax * dy - ay * dx) / det };
}
function objectAt(tab, page, x, y) {
  const tol = HIT_PX / scaleOf(tab);
  const objs = tab.objects.filter((o) => o.page === page);
  for (let k = objs.length - 1; k >= 0; k--) {
    const o = objs[k], def = types.get(o.type);
    const hit = def?.hit ? def.hit(o, x, y, tol) : (() => { const b = def?.bbox?.(o); return b && x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol; })();
    if (hit) return o;
  }
  return null;
}
function handleAt(tab, page, x, y) {
  const ids = getSelection(tab);
  if (ids.length !== 1) return null;
  const o = getObject(tab, ids[0]);
  if (!o || o.page !== page) return null;
  const tol = (HANDLE_PX / 2 + 2) / scaleOf(tab);
  const hd = types.get(o.type)?.handles?.(o)?.find((p) => Math.abs(p.x - x) <= tol && Math.abs(p.y - y) <= tol);
  return hd ? { obj: o, handle: hd.id } : null;
}
function capture(e) { try { e.target.setPointerCapture?.(e.pointerId); } catch { /* element gone */ } }

// Select tool handlers (installed by tools-shapes.js through registerTool).
export const selectHandlers = {
  onPointerDown(e, { tab, hit }) {
    if (e.button !== 0 || !hit) return;
    const p = toPage(tab, hit.pageIndex, e.clientX, e.clientY);
    const hd = handleAt(tab, hit.pageIndex, p.x, p.y);
    let mode = null, objs = [];
    if (hd) { mode = 'resize'; objs = [hd.obj]; } else {
      const o = objectAt(tab, hit.pageIndex, p.x, p.y);
      if (!o) { if (!e.shiftKey && selOf(tab).size) select(tab, []); return; }
      const s = selOf(tab);
      if (e.shiftKey) { s.has(o.id) ? s.delete(o.id) : s.add(o.id); select(tab, [...s]); if (!s.has(o.id)) return; } else if (!s.has(o.id)) select(tab, [o.id]);
      mode = 'move';
      objs = tab.objects.filter((x) => s.has(x.id));
    }
    e.preventDefault();
    capture(e);
    document.body.classList.add('ann-gesture');
    gesture = { tab, page: hit.pageIndex, mode, handle: hd?.handle, start: p, orig: new Map(objs.map((o) => [o.id, clone(o)])), moved: false };
  },
  onPointerMove(e, { tab }) {
    if (!gesture || gesture.tab !== tab) { hover(e, tab); return; }
    const p = toPage(tab, gesture.page, e.clientX, e.clientY);
    const dx = p.x - gesture.start.x, dy = p.y - gesture.start.y;
    if (!gesture.moved && Math.hypot(dx, dy) * scaleOf(tab) < 2) return;
    gesture.moved = true;
    window.getSelection?.()?.removeAllRanges();
    for (const [id, o0] of gesture.orig) {
      const o = getObject(tab, id), def = types.get(o0.type);
      if (!o || !def) continue;
      Object.assign(o, gesture.mode === 'move' ? def.move(o0, dx, dy) : def.resize(o0, gesture.handle, dx, dy));
    }
    renderAll(tab, [gesture.page]);
  },
  onPointerUp(e, { tab }) { if (gesture?.tab === tab) endGesture(true); },
};
function endGesture(commitIt) {
  const g = gesture;
  gesture = null;
  document.body.classList.remove('ann-gesture');
  if (!g?.moved) return;
  const patches = new Map();
  for (const [id, o0] of g.orig) {
    const o = getObject(g.tab, id);
    if (!o) continue;
    const keys = Object.keys(o).filter((k) => k !== 'id' && JSON.stringify(o[k]) !== JSON.stringify(o0[k]));
    patches.set(id, Object.fromEntries(keys.map((k) => [k, o[k]])));
    Object.assign(o, clone(o0)); // restore, then apply as one undoable update
  }
  if (commitIt) updateMany(g.tab, patches);
  else renderAll(g.tab);
}
function hover(e, tab) {
  if (e.buttons) return;
  const hit = viewer.clientToPage(tab, e.clientX, e.clientY);
  const sc = viewer.getScrollEl(tab);
  if (!hit || !sc) return;
  const hd = handleAt(tab, hit.pageIndex, hit.x, hit.y);
  sc.style.cursor = hd ? 'crosshair' : objectAt(tab, hit.pageIndex, hit.x, hit.y) ? 'move' : '';
}

// ---------------------------------------------------------------- style, clipboard, keyboard
let lastStyle = { ...state.toolStyle };
/** Apply the given state.toolStyle keys to the selected objects (one coalesced undo step). */
function applyStyle(tab, keys) {
  if (!tab || !keys.length) return;
  const patches = new Map();
  for (const id of getSelection(tab)) {
    const o = getObject(tab, id);
    const def = types.get(o?.type);
    const patch = def?.style ? def.style(o, state.toolStyle, keys) : {
      ...(keys.includes('color') ? { color: state.toolStyle.color } : {}),
      ...(keys.includes('opacity') ? { opacity: state.toolStyle.opacity } : {}),
      ...(keys.includes('fontSize') && 'fontSize' in o ? { fontSize: state.toolStyle.fontSize } : {}),
    };
    if (Object.keys(patch).length) patches.set(id, patch);
  }
  if (patches.size) updateMany(tab, patches, { coalesce: `style:${keys.join(',')}` });
}
function selectionChanged(tab) {
  // Show the selection's style in the options bar (single stroked object only).
  const ids = getSelection(tab);
  const o = ids.length === 1 ? getObject(tab, ids[0]) : null;
  if (o && o.stroke !== undefined) {
    Object.assign(state.toolStyle, { color: o.stroke ?? state.toolStyle.color, strokeWidth: o.strokeWidth ?? state.toolStyle.strokeWidth, dash: o.dash ?? 'solid', opacity: o.opacity ?? 1, ...('fill' in o ? { fill: o.fill ?? null } : {}) });
    lastStyle = { ...state.toolStyle };
  }
  if (state.tool === 'select') setTool('select'); // re-renders the options bar
  bus.emit('annotations:selection', { tab, ids });
  updateChrome();
}
function copySel(tab) {
  clipboard = getSelection(tab).map((id) => clone(getObject(tab, id)));
  pasteCount = 0;
  return clipboard.length > 0;
}
function paste(tab) {
  if (!clipboard.length) return;
  const d = PASTE_OFFSET * ++pasteCount;
  const objs = clipboard.map((o) => {
    const def = types.get(o.type);
    const page = o.page < tab.numPages ? o.page : tab.currentPage;
    return { ...clone(o), ...(def?.move ? def.move(o, d, d) : {}), page };
  });
  select(tab, addMany(tab, objs));
}
function onKey(e) {
  const tab = activeTab();
  if (!tab || dialogOpen() || isTyping(e.target) || e.altKey) return;
  if (e.target.closest?.('.tabstrip, .menubar')) return;
  ensureTab(tab);
  const ctrl = e.ctrlKey || e.metaKey, k = e.key.toLowerCase(), sel = getSelection(tab);
  const run = (fn) => { e.preventDefault(); e.stopPropagation(); fn(); };
  if (ctrl && k === 'z' && !e.shiftKey) return run(() => undo(tab));
  if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) return run(() => redo(tab));
  if (ctrl && k === 'c' && sel.length) return run(() => copySel(tab));
  if (ctrl && k === 'v' && clipboard.length) return run(() => paste(tab));
  if (ctrl && k === 'd' && sel.length) return run(() => { copySel(tab); paste(tab); });
  if (ctrl) return;
  if (e.key === 'Escape') {
    if (gesture) return run(() => endGesture(false));
    if (sel.length || state.tool !== 'select') return run(() => { select(tab, []); setTool('select'); });
    return;
  }
  if (!sel.length) return;
  if (e.key === 'Delete' || e.key === 'Backspace') return run(() => remove(tab, sel));
  const step = e.shiftKey ? 10 : 1;
  const dir = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (dir) return run(() => {
    const patches = new Map(sel.map((id) => { const o = getObject(tab, id); return [id, types.get(o.type).move(o, dir[0], dir[1])]; }));
    updateMany(tab, patches, { coalesce: `nudge:${sel.join(',')}` });
  });
}

// ---------------------------------------------------------------- chrome (undo/redo, status)
let undoBtn = null, redoBtn = null, statusEl = null;
const UNDO_SVG = '<svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9 7L4.5 11.5 9 16"/><path d="M4.5 11.5H15a4.5 4.5 0 0 1 0 9h-3"/></svg>';
const REDO_SVG = UNDO_SVG.replace('<path d="M9 7L4.5 11.5 9 16"/><path d="M4.5 11.5H15a4.5 4.5 0 0 1 0 9h-3"/>', '<path d="M15 7l4.5 4.5L15 16"/><path d="M19.5 11.5H9a4.5 4.5 0 0 0 0 9h3"/>');
function buildChrome() {
  const tools = document.querySelector('.toolbar .tb-tools');
  if (tools && !document.getElementById('btn-undo')) {
    undoBtn = h('button.tb-btn#btn-undo', { type: 'button', title: 'Undo (Ctrl+Z)', 'aria-label': 'Undo (Ctrl+Z)', html: UNDO_SVG, onclick: () => { const t = activeTab(); if (t) undo(t); } });
    redoBtn = h('button.tb-btn#btn-redo', { type: 'button', title: 'Redo (Ctrl+Y)', 'aria-label': 'Redo (Ctrl+Y)', html: REDO_SVG, onclick: () => { const t = activeTab(); if (t) redo(t); } });
    tools.before(h('div.tb-group', { role: 'group', 'aria-label': 'History' }, undoBtn, redoBtn), h('span.tb-sep', { role: 'separator' }));
  }
  const bar = document.querySelector('footer.statusbar');
  if (bar && !statusEl) { statusEl = h('span.st-annots', { hidden: true, title: 'Annotations are burned into the page content when you save; they stay editable until the tab is closed.' }); bar.append(statusEl); }
  updateChrome();
}
function updateChrome() {
  const tab = activeTab();
  if (tab) ensureTab(tab);
  if (undoBtn) undoBtn.disabled = !tab?.undo.length;
  if (redoBtn) redoBtn.disabled = !tab?.redo.length;
  if (statusEl) {
    const n = tab?.objects.length ?? 0;
    statusEl.hidden = !n;
    statusEl.textContent = n ? `${n} annotation${n === 1 ? '' : 's'} (flattened on save)` : '';
  }
}

// ---------------------------------------------------------------- save hook
async function beforeSave(tab) {
  ensureTab(tab);
  if (!tab.objects.length) return undefined;
  const base = tab.bytes;
  const { flattenObjects } = await import('../../src/core/index.js');
  const out = await flattenObjects(base, tab.objects.map(clone));
  // saveTab() assigns the returned bytes to tab.bytes; put the unflattened bytes back right after
  // so the objects stay editable and the next save never flattens them twice.
  setTimeout(() => { if (tab.bytes === out) tab.bytes = base; }, 0);
  return out;
}
beforeSave.id = 'annotations';
/** Keep the hook last (after forms and any other bytes-producing hook). */
function placeHook() {
  const hooks = state.hooks.beforeSave;
  const k = hooks.indexOf(beforeSave);
  if (k >= 0) hooks.splice(k, 1);
  hooks.push(beforeSave);
}

// ---------------------------------------------------------------- init
let inited = false;
export function initAnnotations() {
  if (inited) return annotations;
  inited = true;
  registerBuiltins();
  placeHook();
  buildChrome();
  document.addEventListener('keydown', onKey);
  bus.on('page:rendered', ({ tab, pageIndex }) => renderPage(tab, pageIndex));
  bus.on('tab:loaded', ({ tab }) => renderAll(tab));
  bus.on('zoom:changed', ({ tab }) => renderAll(tab));
  bus.on('tab:opened', ({ tab }) => { ensureTab(tab); placeHook(); });
  bus.on('tab:activated', ({ tab }) => {
    if (gesture) endGesture(false);
    for (const t of state.tabs) if (t !== tab && selections.get(t)?.size) { selections.get(t).clear(); renderAll(t); }
    if (tab) selectionChanged(tab);
    updateChrome();
  });
  bus.on('pages:remapped', ({ tab, map }) => remapPages(tab, map));
  bus.on('state:changed', ({ key }) => {
    if (key !== 'toolStyle') return;
    const keys = Object.keys(state.toolStyle).filter((k) => state.toolStyle[k] !== lastStyle[k]);
    lastStyle = { ...state.toolStyle };
    const tab = activeTab();
    if (tab && keys.length) applyStyle(tab, keys);
  });
  return annotations;
}

export const annotations = {
  add, update, remove, select, getSelection, getObject, list, undo, redo, batch, newId, remapPages,
  registerObjectType, applyStyle, toPage, render: renderAll, renderPreview,
  /** Internal for tools: add several objects as one undo step, returns their ids. */
  addMany,
};
