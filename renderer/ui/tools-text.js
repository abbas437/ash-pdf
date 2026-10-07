// Text tool: type text onto a page with an in-place <textarea>, stored as a core `text` overlay
// object ({type:'text', page, x,y,w,h, text, fontSize, font, bold, italic, color, align,
// lineHeight}) and flattened on save by src/core/annotate.js. Also "Replace text…" (Tools menu):
// a whiteout over the original text plus a new text box in the same rectangle.
//
// Geometry: the editor lives in div.text-edit-layer inside the page overlay, positioned in visible
// page space with calc(var(--scale-factor) * Npx) and rotated for the view rotation like
// svg.overlay-svg, so zoom and view rotation need no re-layout. Line wrapping and the box height
// come from the core's measureText, so the overlay, the editor and the saved PDF wrap alike.
//
// Exports: initTextTools(app), openTextEditor(tab, pageIndex, boxPts, opts), registerTextObjectType().
import { bus } from '../bus.js';
import { state, activeTab } from '../state.js';
import { h, isTyping } from './dom.js';
import { viewer } from './viewer.js';
import { dialogOpen } from './dialogs.js';
import { registerTool, setTool } from './toolbar.js';
import { annotations, resizeBox } from './annotations.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MIN_W = 40;          // points
const DEFAULT_W = 200;     // points, box width for a plain click
const MIN_DRAG_PX = 4;     // smaller drags are clicks
const LINE_HEIGHT = 1.2;
const FONTS = ['Helvetica', 'Times', 'Courier'];
const FAMILY = {
  Helvetica: 'Helvetica, Arial, "Liberation Sans", sans-serif',
  Times: '"Times", "Times New Roman", "Liberation Serif", serif',
  Courier: '"Courier", "Courier New", "Liberation Mono", monospace',
};
const TEXT_KEYS = ['font', 'fontSize', 'bold', 'italic', 'color', 'align'];

let core = null;
const loadCore = () => import('../../src/core/index.js').then((m) => { core = m; return m; });
let editor = null;         // the open editor (one at a time)
let editingId = null;      // text object hidden while it is being re-edited
let replaceArmed = false;  // next drag of the Text tool is a "Replace text" rectangle
let swallow = null;        // pointerdown event that only committed an open editor

const px = (n) => `calc(var(--scale-factor) * ${Math.round(n * 1000) / 1000}px)`;
const r3 = (n) => Math.round(n * 1000) / 1000;
const fontOf = (f) => (FONTS.includes(f) ? f : 'Helvetica');

/** Lines and metrics exactly as the core lays them out (fallback before the core has loaded). */
function measure(text, s, maxWidth) {
  const opts = { font: fontOf(s.font), bold: !!s.bold, italic: !!s.italic, fontSize: s.fontSize > 0 ? s.fontSize : 12, maxWidth, lineHeight: s.lineHeight > 0 ? s.lineHeight : LINE_HEIGHT };
  if (core) return core.measureText(text ?? '', opts);
  const lh = opts.fontSize * opts.lineHeight, lines = String(text ?? '').split('\n');
  return { lines, lineHeight: lh, height: lines.length * lh, firstBaseline: (lh - opts.fontSize * 0.93) / 2 + opts.fontSize * 0.72 };
}
/** Box height that fits the text (at least one line). */
const fitH = (text, s, w) => { const m = measure(text, s, w); return Math.max(m.height, m.lineHeight); };
function styleFrom(s = state.toolStyle) {
  return { font: fontOf(s.font), fontSize: Number(s.fontSize) > 0 ? Number(s.fontSize) : 12, bold: !!s.bold, italic: !!s.italic, color: s.color ?? '#000000', align: s.align ?? 'left', lineHeight: s.lineHeight > 0 ? s.lineHeight : LINE_HEIGHT };
}

// ---------------------------------------------------------------- object type
function svgEl(name, attrs, parent) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  parent?.append(el);
  return el;
}
const fontAttrs = (o) => ({ 'font-family': FAMILY[fontOf(o.font)], 'font-size': r3(o.fontSize > 0 ? o.fontSize : 12), 'font-weight': o.bold ? 'bold' : 'normal', 'font-style': o.italic ? 'italic' : 'normal' });

const textType = {
  render(o, parent) {
    const g = svgEl('g', { class: 'ann-text' }, parent);
    if (o.id && o.id === editingId) return g;
    const m = measure(o.text, o, o.w);
    const align = o.align === 'center' || o.align === 'right' ? o.align : 'left';
    const ax = align === 'center' ? o.x + o.w / 2 : align === 'right' ? o.x + o.w : o.x;
    const t = svgEl('text', { ...fontAttrs(o), fill: o.color ?? '#000000', 'text-anchor': { left: 'start', center: 'middle', right: 'end' }[align], opacity: o.opacity }, g);
    m.lines.forEach((line, i) => {
      if (line === '') return;
      svgEl('tspan', { x: r3(ax), y: r3(o.y + m.firstBaseline + i * m.lineHeight) }, t).textContent = line;
    });
    return g;
  },
  bbox: (o) => ({ x: o.x, y: o.y, w: o.w, h: o.h }),
  handles: (o) => [{ id: 'w', x: o.x, y: o.y + o.h / 2 }, { id: 'e', x: o.x + o.w, y: o.y + o.h / 2 }],
  hit: (o, x, y, tol) => x >= o.x - tol && x <= o.x + o.w + tol && y >= o.y - tol && y <= o.y + o.h + tol,
  move: (o, dx, dy) => ({ x: o.x + dx, y: o.y + dy }),
  resize(o, handle, dx) {
    const b = resizeBox(o, handle, dx, 0);
    let { x, w } = b;
    if (w < MIN_W) { if (handle === 'w') x = o.x + o.w - MIN_W; w = MIN_W; }
    return { x, w, h: fitH(o.text, o, w) };
  },
  style(o, s, keys) {
    const p = {};
    const ns = styleFrom(s);
    for (const k of TEXT_KEYS) if (keys.includes(k)) p[k] = ns[k];
    if (['font', 'fontSize', 'bold', 'italic'].some((k) => k in p)) p.h = fitH(o.text, { ...o, ...p }, o.w);
    return p;
  },
};
let registered = false;
export function registerTextObjectType() {
  if (registered) return;
  registered = true;
  annotations.registerObjectType('text', textType);
}

// ---------------------------------------------------------------- in-place editor
function layerFor(tab, i) {
  const overlay = viewer.getOverlayEl(tab, i);
  if (!overlay) return null;
  let layer = overlay.querySelector(':scope > .text-edit-layer');
  if (!layer) {
    const { width, height } = viewer.pageSize(tab, i);
    layer = h('div.text-edit-layer', { style: { width: px(width), height: px(height) } });
    overlay.append(layer);
  }
  layer.dataset.viewRotation = String(tab.viewRotation ?? 0);
  return layer;
}

function checkWinAnsi(text, warn) {
  const norm = String(text).replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
  warn.hidden = !core || core.sanitizeText(norm) === norm;
}

/**
 * Open the in-place editor over boxPts {x, y, w, h?} (points) on page `pageIndex`.
 * opts: {text = '', style ({font,fontSize,bold,italic,color,align,lineHeight}, default
 * state.toolStyle), onCommit(text, boxPts), onCancel()}. Ctrl+Enter or a click outside commits,
 * Esc cancels. boxPts.h passed to onCommit is the height that fits the text.
 * Returns {textarea, commit(), cancel(), setStyle(style)}; any editor already open is committed.
 */
export function openTextEditor(tab, pageIndex, boxPts, { text = '', style, onCommit, onCancel } = {}) {
  editor?.commit();
  const layer = layerFor(tab, pageIndex);
  if (!layer) return null;
  let s = styleFrom({ ...state.toolStyle, ...style });
  const box = { x: boxPts.x, y: boxPts.y, w: Math.max(MIN_W, boxPts.w || 0) };
  const ta = h('textarea.text-editor', { spellcheck: 'false', 'aria-label': 'Text', wrap: 'soft' });
  const warn = h('div.form-warn.text-editor-warn', { role: 'status', hidden: true }, 'Some characters cannot be saved with the standard PDF fonts and will appear as "?".');
  ta.value = text;
  const layout = () => {
    box.h = fitH(ta.value, s, box.w);
    Object.assign(ta.style, {
      left: px(box.x), top: px(box.y), width: px(box.w), height: px(box.h),
      fontFamily: FAMILY[s.font], fontSize: px(s.fontSize), lineHeight: px(s.fontSize * s.lineHeight),
      fontWeight: s.bold ? 'bold' : 'normal', fontStyle: s.italic ? 'italic' : 'normal', color: s.color, textAlign: s.align,
    });
    Object.assign(warn.style, { left: px(box.x), top: px(box.y + box.h + 2), minWidth: px(box.w) });
    checkWinAnsi(ta.value, warn);
  };
  let done = false;
  const close = () => {
    done = true;
    if (editor === handle) editor = null;
    ta.remove();
    warn.remove();
    if (!layer.childElementCount) layer.remove();
  };
  const handle = {
    textarea: ta, tab, pageIndex,
    commit() {
      if (done) return;
      const value = ta.value.replace(/\r\n?/g, '\n');
      const b = { ...box, h: fitH(value, s, box.w) };
      close();
      onCommit?.(value, b, s);
    },
    cancel() { if (done) return; close(); onCancel?.(); },
    setStyle(ns) { s = styleFrom({ ...s, ...ns }); layout(); },
  };
  ta.addEventListener('input', layout);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); handle.cancel(); } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); handle.commit(); }
  });
  // Keep pointer events on the editor away from the tool dispatch (select tool would start a move).
  for (const t of ['pointerdown', 'pointermove', 'pointerup', 'dblclick']) ta.addEventListener(t, (e) => e.stopPropagation());
  ta.addEventListener('blur', (e) => {
    if (e.relatedTarget?.closest?.('.options-bar') || !ta.isConnected) return;
    // Window blur (switching apps) keeps the editor open.
    setTimeout(() => { if (!done && document.hasFocus() && document.activeElement !== ta && !document.activeElement?.closest?.('.options-bar')) handle.commit(); }, 0);
  });
  layer.append(ta, warn);
  layout();
  editor = handle;
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  return handle;
}

// ---------------------------------------------------------------- create / re-edit
function createAt(tab, page, box, extra = {}) {
  const style = styleFrom({ ...state.toolStyle, ...extra.style });
  return openTextEditor(tab, page, box, {
    style,
    onCommit(text, b, s) {
      if (!text.trim()) { extra.onEmpty?.(); return; }
      const o = annotations.add(tab, { type: 'text', page, x: b.x, y: b.y, w: b.w, h: b.h, text, ...s });
      annotations.select(tab, [o.id]);
    },
    onCancel: () => extra.onEmpty?.(),
  });
}

function reEdit(tab, o) {
  editingId = o.id;
  annotations.select(tab, []);
  showTextOptions(o);
  const restore = () => { editingId = null; annotations.render(tab, [o.page]); };
  const ed = openTextEditor(tab, o.page, o, {
    text: o.text,
    style: { font: o.font, fontSize: o.fontSize, bold: o.bold, italic: o.italic, color: o.color, align: o.align, lineHeight: o.lineHeight },
    onCommit(text, b) {
      editingId = null;
      if (!text.trim()) { annotations.remove(tab, [o.id]); return; }
      if (text !== o.text || b.h !== o.h) annotations.update(tab, o.id, { text, h: b.h });
      else annotations.render(tab, [o.page]);
      annotations.select(tab, [o.id]);
    },
    onCancel: restore,
  });
  if (ed) { ed.objectId = o.id; annotations.render(tab, [o.page]); } else restore();
  return ed;
}

function textObjectAt(tab, clientX, clientY) {
  const hit = viewer.clientToPage(tab, clientX, clientY);
  if (!hit) return null;
  const tol = 3 / viewer.scale(tab);
  const list = annotations.list(tab, hit.pageIndex);
  for (let k = list.length - 1; k >= 0; k--) if (list[k].type === 'text' && textType.hit(list[k], hit.x, hit.y, tol)) return list[k];
  return null;
}

// ---------------------------------------------------------------- Text tool
let drag = null;
const textTool = {
  onPointerDown(e, { tab, hit }) {
    if (e === swallow || e.button !== 0 || !hit || tab.readOnly) return;
    e.preventDefault();
    try { e.target.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
    if (annotations.getSelection(tab).length) annotations.select(tab, []);
    drag = { tab, page: hit.pageIndex, start: annotations.toPage(tab, hit.pageIndex, e.clientX, e.clientY), cx: e.clientX, cy: e.clientY };
  },
  onPointerMove(e, { tab }) {
    if (!drag || drag.tab !== tab) return;
    const p = annotations.toPage(tab, drag.page, e.clientX, e.clientY);
    annotations.renderPreview(tab, drag.page, { type: 'rect', ...boxOf(drag.start, p), stroke: '#1a73e8', strokeWidth: 0.75, dash: 'dashed', fill: null });
  },
  onPointerUp(e, { tab }) {
    if (!drag || drag.tab !== tab) return;
    const g = drag;
    drag = null;
    annotations.renderPreview(tab, g.page, null);
    const p = annotations.toPage(tab, g.page, e.clientX, e.clientY);
    const dragged = Math.hypot(e.clientX - g.cx, e.clientY - g.cy) >= MIN_DRAG_PX;
    if (replaceArmed) {
      if (!dragged) return;
      replaceArmed = false;
      replaceIn(tab, g.page, boxOf(g.start, p));
      return;
    }
    let box;
    if (dragged) box = boxOf(g.start, p);
    else {
      const { width } = viewer.pageSize(tab, g.page);
      box = { x: g.start.x, y: g.start.y, w: Math.max(MIN_W, Math.min(DEFAULT_W, width - g.start.x)) };
    }
    createAt(tab, g.page, box);
  },
};
function boxOf(a, b) { return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }; }

// ---------------------------------------------------------------- Replace text
function replaceIn(tab, page, rect) {
  const wo = annotations.add(tab, { type: 'whiteout', page, ...rect, color: '#ffffff' });
  const fontSize = Math.max(6, Math.round(rect.h * 0.8 * 2) / 2);
  createAt(tab, page, rect, { style: { fontSize }, onEmpty: () => annotations.remove(tab, [wo.id]) });
}
async function replaceTextDialog(app) {
  const tab = activeTab();
  if (!tab || tab.readOnly) return;
  const body = h('div', {},
    h('p', {}, 'Drag a rectangle over the text you want to replace, then type the new text.'),
    h('p.pt-hint', {}, 'This covers the original text with a white box; it does not delete it from the file. The original stays in the PDF and can still be found, selected or copied. For confidential redaction, share a flattened or printed copy instead.'));
  const v = await app.showDialog({ title: 'Replace text', body, buttons: [{ label: 'Cancel', value: 'cancel', cancel: true }, { label: 'Draw rectangle', value: 'ok', primary: true }] });
  if (v !== 'ok') return;
  setTool('text');
  replaceArmed = true;
  app.toast('Drag a rectangle over the text to replace');
}

// ---------------------------------------------------------------- options bar
function setStyleKey(key, value) {
  state.toolStyle[key] = value;
  bus.emit('state:changed', { key: 'toolStyle', value: state.toolStyle });
}
function fontCtl(c) {
  c.append(h('label.opt', {}, h('span', {}, 'Font'), h('select.opt-text-font', { onchange: (e) => setStyleKey('font', e.target.value) },
    FONTS.map((f) => h('option', { value: f, selected: fontOf(state.toolStyle.font) === f }, f)))));
}
function sizeCtl(c) {
  c.append(h('label.opt', {}, h('span', {}, 'Size'), h('input.opt-font', { type: 'number', min: '4', max: '144', step: '0.5', value: String(state.toolStyle.fontSize), onchange: (e) => setStyleKey('fontSize', Number(e.target.value) || 12) })));
}
function toggles(c) {
  const seg = h('div.opt-seg', { role: 'group', 'aria-label': 'Text style' });
  for (const [key, label, glyph] of [['bold', 'Bold', 'B'], ['italic', 'Italic', 'I']]) {
    seg.append(h(`button.tb-btn.opt-text-${key}`, { type: 'button', title: label, 'aria-label': label, 'aria-pressed': String(!!state.toolStyle[key]),
      onclick: (e) => { const on = !state.toolStyle[key]; e.currentTarget.setAttribute('aria-pressed', String(on)); setStyleKey(key, on); } }, h(`span.opt-glyph-${key}`, {}, glyph)));
  }
  c.append(seg);
}
function colorCtl(c) {
  c.append(h('label.opt', {}, h('span', {}, 'Colour'), h('input.opt-color', { type: 'color', value: state.toolStyle.color, oninput: (e) => setStyleKey('color', e.target.value) })));
}
const ALIGN_ICON = {
  left: '<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>',
  center: '<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>',
  right: '<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>',
};
function alignCtl(c) {
  const seg = h('div.opt-seg', { role: 'group', 'aria-label': 'Alignment' });
  for (const a of ['left', 'center', 'right']) {
    seg.append(h('button.tb-btn.opt-text-align', { type: 'button', title: `Align ${a}`, 'aria-label': `Align ${a}`, 'aria-pressed': String((state.toolStyle.align ?? 'left') === a), dataset: { align: a },
      html: `<svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true" focusable="false">${ALIGN_ICON[a]}</svg>`,
      onclick: () => { for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.align === a)); setStyleKey('align', a); } }));
  }
  c.append(seg);
}
const TEXT_OPTIONS = [fontCtl, sizeCtl, toggles, colorCtl, alignCtl];

/** Select tool with only text objects selected: show the text controls with their style. */
function onSelection({ tab, ids }) {
  if (state.tool !== 'select' || tab !== activeTab() || !ids.length) return;
  const objs = ids.map((id) => annotations.getObject(tab, id));
  if (!objs.every((o) => o?.type === 'text')) return;
  showTextOptions(objs[0]);
}
/** Load a text object's style into state.toolStyle (silently: it matches the object) and show the text controls. */
function showTextOptions(o) {
  const s = styleFrom(o);
  for (const k of TEXT_KEYS) state.toolStyle[k] = s[k];
  const bar = document.querySelector('.options-bar');
  if (!bar) return;
  bar.replaceChildren();
  for (const f of TEXT_OPTIONS) f(bar);
  bar.hidden = false;
}

// ---------------------------------------------------------------- init
export function initTextTools(app) {
  registerTextObjectType();
  loadCore().then(() => { for (const t of state.tabs) if (t.objects?.some((o) => o.type === 'text')) annotations.render(t); }).catch((err) => console.warn('[text] core not loaded', err));
  state.toolStyle.font ??= 'Helvetica';
  state.toolStyle.bold ??= false;
  state.toolStyle.italic ??= false;
  state.toolStyle.align ??= 'left';
  state.toolStyle.fontSize ??= 12;
  bus.emit('state:changed', { key: 'toolStyle', value: state.toolStyle });

  registerTool({
    id: 'text', label: 'Text', icon: 'text', shortcut: 'T', cursor: 'text', options: TEXT_OPTIONS,
    ...textTool,
    onActivate: () => document.body.classList.add('text-tool'),
    onDeactivate: () => { document.body.classList.remove('text-tool'); replaceArmed = false; if (drag) { annotations.renderPreview(drag.tab, drag.page, null); drag = null; } },
  });
  app.registerMenuItem('Tools', { separator: true });
  app.registerMenuItem('Tools', { id: 'replace-text', label: 'Replace text…', action: () => replaceTextDialog(app), enabled: () => !!activeTab() && !activeTab().readOnly });

  // A click anywhere outside the open editor (and outside the options bar) commits it.
  document.addEventListener('pointerdown', (e) => {
    if (!editor || e.target === editor.textarea || e.target.closest?.('.options-bar, .dialog, .menu')) return;
    editor.commit();
    swallow = e;
  }, true);
  // Double-click on a text object re-opens the editor.
  document.addEventListener('dblclick', (e) => {
    const tab = activeTab();
    if (!tab || tab.readOnly || (state.tool !== 'select' && state.tool !== 'text') || !e.target.closest?.('.page')) return;
    const o = textObjectAt(tab, e.clientX, e.clientY);
    if (!o) return;
    e.preventDefault();
    window.getSelection?.()?.removeAllRanges();
    reEdit(tab, o);
  });
  // Options changed while editing: restyle the editor (the object is updated on commit / via style()).
  bus.on('state:changed', ({ key }) => {
    if (key !== 'toolStyle' || !editor) return;
    const s = styleFrom();
    editor.setStyle(s);
    if (editor.objectId) {
      const o = annotations.getObject(editor.tab, editor.objectId);
      if (o) {
        const patch = {};
        for (const k of TEXT_KEYS) if (o[k] !== s[k]) patch[k] = s[k];
        if (Object.keys(patch).length) annotations.update(editor.tab, o.id, patch, { coalesce: `text-style:${o.id}` });
      }
    }
  });
  bus.on('annotations:selection', onSelection);
  bus.on('rotation:changed', ({ tab }) => {
    for (let i = 0; i < (tab.numPages ?? 0); i++) viewer.getOverlayEl(tab, i)?.querySelector(':scope > .text-edit-layer')?.setAttribute('data-view-rotation', String(tab.viewRotation));
  });
  bus.on('tab:activated', () => editor?.commit());
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || dialogOpen() || isTyping(e.target) || !activeTab()) return;
    if (e.key.toLowerCase() === 't') { e.preventDefault(); setTool('text'); }
  });
}
