// Text tool: type text onto a page with an in-place rich-text editor (contenteditable), stored as a core `text` overlay
// object ({type:'text', page, x,y,w,h, text, fontSize, font, bold, italic, color, align,
// lineHeight}) and flattened on save by src/core/annotate.js. Also "Replace text…" (Tools menu):
// a whiteout over the original text plus a new text box in the same rectangle.
//
// Geometry: the editor lives in div.text-edit-layer inside the page overlay, positioned in visible
// page space with calc(var(--scale-factor) * Npx) and rotated for the view rotation like
// svg.overlay-svg, so zoom and view rotation need no re-layout. Line wrapping and the box height
// come from the core's measureText, so the overlay, the editor and the saved PDF wrap alike.
//
// Exports: initTextTools(app), openTextEditor(tab, pageIndex, boxPts, opts), activeTextEditor(), registerTextObjectType(),
// addTextBox(tab, page, x, y, text) (paste of plain text).
import { bus } from '../bus.js';
import { state, activeTab } from '../state.js';
import { h, isTyping } from './dom.js';
import { viewer } from './viewer.js';
import { dialogOpen } from './dialogs.js';
import { registerTool, setTool, toggleTool } from './toolbar.js';
import { annotations, resizeBox } from './annotations.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MIN_W = 40;          // points
const DEFAULT_W = 200;     // points, box width for a plain click
const MIN_DRAG_PX = 4;     // smaller drags are clicks
const LINE_HEIGHT = 1.2;
const FONTS = ['Helvetica', 'Times', 'Courier'];
const FAMILY = {
  Helvetica: '"ASH Helvetica", Helvetica, Arial, "Liberation Sans", sans-serif',
  Times: '"ASH Times", "Times", "Times New Roman", "Liberation Serif", serif',
  Courier: '"ASH Courier", "Courier", "Courier New", "Liberation Mono", monospace',
};
// "ASH <font>" faces: a local look-alike with its ascent/descent overridden to the standard PDF
// font's AFM metrics. CSS centres ascent+descent in each line box, so with the look-alike's own
// (taller) metrics the editor's baseline sat ~0.08em below the core's firstBaseline (3 pt at 36 pt).
const LOCAL = {
  Helvetica: ['Helvetica', 'Arial', 'Liberation Sans', 'TeX Gyre Heros', 'Nimbus Sans'],
  Times: ['Times', 'Times New Roman', 'Liberation Serif', 'TeX Gyre Termes', 'Nimbus Roman'],
  Courier: ['Courier', 'Courier New', 'Liberation Mono', 'TeX Gyre Cursor', 'Nimbus Mono PS'],
};
function addMetricFaces() {
  for (const font of FONTS) for (const bold of [false, true]) for (const italic of [false, true]) {
    const { ascent, descent } = core.measureText('', { font, bold, italic, fontSize: 100 });
    const sfx = (o) => `${bold ? ' Bold' : ''}${italic ? ` ${o}` : ''}`;
    const names = LOCAL[font].flatMap((n) => (bold || italic ? [n + sfx('Italic'), n + sfx('Oblique')] : [n, `${n} Regular`, `${n} Roman`]));
    const face = new FontFace(`ASH ${font}`, names.map((n) => `local("${n}")`).join(', '),
      { weight: bold ? '700' : '400', style: italic ? 'italic' : 'normal', ascentOverride: `${ascent}%`, descentOverride: `${descent}%`, lineGapOverride: '0%', display: 'swap' });
    document.fonts.add(face);
    face.load().catch(() => document.fonts.delete(face));
  }
}
const TEXT_KEYS = ['font', 'fontSize', 'bold', 'italic', 'color', 'align'];
const FORMAT_KEYS = { b: 'bold', i: 'italic', u: 'underline', x: 'strike' }; // Ctrl+<key> in the editor (x with Shift)
const FORMAT_UI = '.options-bar, .text-format-bar, .menu'; // focus / clicks there keep the editor open
// Floating bar colours: black + the callout tool's review colours (tools-callout.js COLORS, copied: importing it would be circular).
const SWATCHES = [['#000000', 'Black'], ['#d62828', 'Red'], ['#1d4ed8', 'Rev. comment (blue)'], ['#1b7f3b', 'Green'], ['#d97706', 'Orange']];

let core = null;
const loadCore = () => import('../../src/core/index.js').then((m) => { core = m; addMetricFaces(); return m; });
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
const fitH = (text, s, w, runs) => {
  const m = measure(text, s, w);
  if (core && Array.isArray(runs) && runs.length) return Math.max(core.layoutRich({ ...s, text, runs }, w).height, m.lineHeight);
  return Math.max(m.height, m.lineHeight);
};
/** Box height: the text's, but never below the height the user dragged the box to (`minH`). */
const boxH = (text, s, w, minH, runs) => Math.max(fitH(text, s, w, runs), Number(minH) > 0 ? Number(minH) : 0);
/**
 * Word-style resize of a text box by `handle` (nw..w): width and height follow the drag, text
 * re-wraps, the dragged height is kept as `minH` (0 when it is at or below the text height).
 * Dragging a top/left handle moves that edge and keeps the opposite one fixed.
 */
export function resizeTextBox(o, handle, dx, dy, fit) {
  let { x, w } = resizeBox(o, handle, dx, 0);
  if (w < MIN_W) { if (handle.includes('w')) x = o.x + o.w - MIN_W; w = MIN_W; }
  const needed = fit(w);
  const vertical = handle.includes('n') || handle.includes('s');
  // The height never flips: dragging past the opposite edge stops at the text's height.
  const userH = handle.includes('n') ? o.h - dy : handle.includes('s') ? o.h + dy : o.h;
  const minH = vertical ? (userH > needed ? userH : 0) : o.minH;
  const h = Math.max(needed, minH || 0);
  const y = handle.includes('n') ? o.y + o.h - h : o.y;
  return vertical ? { x, y, w, h, minH } : { x, y, w, h };
}
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

/** Rich text: one tspan per layoutRich fragment, underline / strike as thin rects (same positions as the PDF appearance). Also used by callouts (with their padding). */
export function renderRuns(o, g, lib = core) {
  const L = lib.layoutRich(o, o.w, { x: o.x, y: o.y });
  const t = svgEl('text', { opacity: o.opacity, style: 'white-space: pre' }, g);
  for (const line of L.lines) for (const f of line.fragments) {
    if (f.text === '') continue;
    svgEl('tspan', { x: r3(f.x), y: r3(f.baseline), ...fontAttrs(f.style), fill: f.style.color }, t).textContent = f.text;
    for (const d of f.decorations) {
      svgEl('rect', { class: `ann-text-${d.type}`, x: r3(f.x), y: r3(d.y - d.thickness / 2), width: r3(f.width), height: r3(d.thickness), fill: f.style.color, opacity: o.opacity }, g);
    }
  }
}

const textType = {
  render(o, parent) {
    const g = svgEl('g', { class: 'ann-text' }, parent);
    if (o.id && o.id === editingId) return g;
    if (core && Array.isArray(o.runs) && o.runs.length) { renderRuns(o, g); return g; }
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
  handles: (o) => ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((id) => ({
    id, x: id.includes('w') ? o.x : id.includes('e') ? o.x + o.w : o.x + o.w / 2, y: id.includes('n') ? o.y : id.includes('s') ? o.y + o.h : o.y + o.h / 2,
  })),
  hit: (o, x, y, tol) => x >= o.x - tol && x <= o.x + o.w + tol && y >= o.y - tol && y <= o.y + o.h + tol,
  move: (o, dx, dy) => ({ x: o.x + dx, y: o.y + dy }),
  resize: (o, handle, dx, dy) => resizeTextBox(o, handle, dx, dy, (w) => fitH(o.text, o, w, o.runs)),
  style(o, s, keys) {
    const p = {};
    const ns = styleFrom(s);
    for (const k of TEXT_KEYS) if (keys.includes(k)) p[k] = ns[k];
    if (['font', 'fontSize', 'bold', 'italic'].some((k) => k in p)) p.h = boxH(o.text, { ...o, ...p }, o.w, o.minH, o.runs);
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

/** CSS for one run's overrides (the box style is the editor's own style, except underline / strike:
 * a decoration on the editor element could not be cancelled by a run, so every run span carries its own). */
function runCss(r, s, deco) {
  const c = {};
  if (r.font && r.font !== s.font) c.fontFamily = FAMILY[fontOf(r.font)];
  if (r.fontSize > 0 && r.fontSize !== s.fontSize) { c.fontSize = px(r.fontSize); c.lineHeight = px(r.fontSize * s.lineHeight); }
  if (r.bold != null && !!r.bold !== !!s.bold) c.fontWeight = r.bold ? 'bold' : 'normal';
  if (r.italic != null && !!r.italic !== !!s.italic) c.fontStyle = r.italic ? 'italic' : 'normal';
  if (r.color) c.color = r.color;
  const u = r.underline ?? deco.underline, k = r.strike ?? deco.strike;
  c.textDecorationLine = [u && 'underline', k && 'line-through'].filter(Boolean).join(' ') || 'none';
  return c;
}
const hex2 = (n) => Number(n).toString(16).padStart(2, '0');
const cssHex = (c) => { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c); return m ? `#${hex2(m[1])}${hex2(m[2])}${hex2(m[3])}` : c; };
const BLOCK = /^(DIV|P|LI|H[1-6])$/;

/**
 * Open the in-place rich-text editor (a contenteditable div.text-editor) over boxPts {x, y, w, h?}
 * (points) on page `pageIndex`. opts: {text = '', runs, style ({font,fontSize,bold,italic,color,
 * align,lineHeight,underline,strike}, default state.toolStyle), onCommit(text, boxPts, style, runs),
 * onCancel(), toggleFormat(key) (Ctrl+B / I / U / Shift+X; default: applyStyle toggling key at the selection)}.
 * Ctrl+Enter or a click outside (other than the options bar / div.text-format-bar) commits, Esc cancels. boxPts.h passed to onCommit is the
 * height that fits the text; runs is undefined when the text is uniform.
 * Returns {el, commit(), cancel(), setStyle(style), getText(), getRuns(), getSelection() → {start, end},
 * setSelection(start, end), applyStyle(patch), styleAtSelection()}; any editor already open is committed.
 * Edits go through `beforeinput` into a {text, runs} model (new text takes the style before the caret,
 * paste is plain text); IME composition and other native edits are read back from the DOM.
 */
export function openTextEditor(tab, pageIndex, boxPts, { text = '', runs, style, onCommit, onCancel, toggleFormat } = {}) {
  editor?.commit();
  const layer = layerFor(tab, pageIndex);
  if (!layer) return null;
  let s = styleFrom({ ...state.toolStyle, ...style });
  let deco = { underline: !!style?.underline, strike: !!style?.strike };
  const box = { x: boxPts.x, y: boxPts.y, w: Math.max(MIN_W, boxPts.w || 0) };
  const minH = boxPts.minH;
  const el = h('div.text-editor', { contenteditable: 'true', spellcheck: 'false', role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'Text' });
  const warn = h('div.form-warn.text-editor-warn', { role: 'status', hidden: true }, 'Some characters cannot be saved with the standard PDF fonts and will appear as "?".');
  const obj = () => ({ type: 'text', ...s, ...deco, text: model.text, runs: model.runs });
  let model = { text: String(text ?? '') };
  model.runs = core && runs ? core.normalizeRuns(core.runsOf({ ...obj(), runs }), obj()) : undefined;
  const undo = [], redo = [];
  let lastKind = null, lastSel = { start: model.text.length, end: model.text.length }, composing = false;

  // ---- DOM <-> character offsets: text nodes count their length, <br> and block starts count '\n'
  const pieces = () => {
    const out = [];
    let pos = 0;
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) { out.push({ node: c, start: pos, len: c.data.length }); pos += c.data.length; } else if (c.nodeName === 'BR') {
          if (c.classList.contains('te-end')) continue;
          out.push({ node: c, start: pos, len: 1, br: true }); pos += 1;
        } else if (c.nodeType === 1) {
          if (BLOCK.test(c.nodeName) && pos > 0 && !out.at(-1)?.br) { out.push({ node: c, start: pos, len: 1, block: true }); pos += 1; }
          walk(c);
        }
      }
    };
    walk(el);
    return out;
  };
  const toOffset = (node, off) => {
    const P = pieces();
    if (node.nodeType === 3) { const p = P.find((q) => q.node === node); if (p) return p.start + Math.min(off, p.len); }
    const r = document.createRange();
    try { r.setStart(node, off); } catch { return model.text.length; }
    let pos = 0;
    for (const p of P) {
      const before = p.node.nodeType === 3 ? r.comparePoint(p.node, p.len) <= 0 : r.comparePoint(p.node.parentNode, [...p.node.parentNode.childNodes].indexOf(p.node)) < 0;
      if (before) pos = p.start + p.len; else break;
    }
    return pos;
  };
  const toPoint = (i) => {
    const P = pieces().filter((p) => p.node.nodeType === 3);
    const p = P.find((q) => i > q.start && i <= q.start + q.len) ?? P.find((q) => i <= q.start);
    return p ? [p.node, Math.max(0, i - p.start)] : [el, el.childNodes.length];
  };
  const selIn = () => {
    const sel = window.getSelection();
    if (!sel?.rangeCount || !el.contains(sel.anchorNode) || !el.contains(sel.focusNode)) return null;
    const a = toOffset(sel.anchorNode, sel.anchorOffset), b = toOffset(sel.focusNode, sel.focusOffset);
    return { start: Math.min(a, b), end: Math.max(a, b) };
  };
  // Focus in a format control: re-rendering leaves the DOM selection collapsed in el; keep lastSel.
  const domSel = () => (document.activeElement === el ? selIn() : null);
  const setDomSel = ({ start, end }) => {
    const sel = window.getSelection();
    sel?.setBaseAndExtent(...toPoint(start), ...toPoint(end));
  };

  // ---- model -> DOM, DOM -> model
  const render = () => {
    const parts = core ? core.runsOf(obj()) : [{ text: model.text }];
    el.replaceChildren(...parts.filter((r) => r.text).map((r) => h('span', { style: runCss(r, s, deco) }, r.text)));
    if (!model.text || model.text.endsWith('\n')) el.append(h('br.te-end'));
  };
  const parse = () => {
    if (!core) return { text: pieces().map((p) => (p.node.nodeType === 3 ? p.node.data : '\n')).join('') };
    const base = getComputedStyle(el), basePx = parseFloat(base.fontSize) || 1;
    const out = [];
    for (const p of pieces()) {
      const t = p.node.nodeType === 3 ? p.node.data : '\n';
      if (p.node.nodeType !== 3) { out.push({ ...(out.at(-1) ?? {}), text: t }); continue; }
      const cs = getComputedStyle(p.node.parentNode);
      const fam = /Times/.test(cs.fontFamily) ? 'Times' : /Courier/.test(cs.fontFamily) ? 'Courier' : 'Helvetica';
      const pt = Math.round((parseFloat(cs.fontSize) / basePx) * s.fontSize * 100) / 100;
      // Decorations from the elements below the editor (run spans); text straight in the editor (or in
      // an element the browser made without any) has the box decoration.
      const lines = new Set();
      let styled = false;
      for (let n = p.node.parentNode; n && n !== el; n = n.parentNode) {
        if (n.style?.textDecorationLine) styled = true;
        for (const v of getComputedStyle(n).textDecorationLine.split(' ')) lines.add(v);
      }
      if (!styled) { if (deco.underline) lines.add('underline'); if (deco.strike) lines.add('line-through'); }
      out.push({ text: t, font: fam, fontSize: Math.abs(pt - s.fontSize) < 0.01 ? s.fontSize : pt, bold: Number(cs.fontWeight) >= 600, italic: cs.fontStyle !== 'normal', color: cssHex(cs.color), underline: lines.has('underline'), strike: lines.has('line-through') });
    }
    const t = out.map((r) => r.text).join('');
    return { text: t, runs: core.normalizeRuns(out, { ...obj(), text: t }) };
  };
  const snapshot = () => ({ text: model.text, runs: model.runs, sel: domSel() ?? lastSel });
  const push = (kind, at) => {
    if (!(kind === 'type' && lastKind === 'type' && at === lastSel.end)) undo.push(snapshot());
    redo.length = 0;
    lastKind = kind;
  };
  const show = (sel) => { render(); lastSel = sel; if (document.activeElement === el) setDomSel(sel); layout(); };
  const replace = (a, b, str, kind) => {
    push(kind, a);
    const keep = a < b && core ? core.styleAt(obj(), a) : undefined;
    let m = a < b && core ? core.deleteRange(obj(), a, b) : { text: model.text.slice(0, a) + model.text.slice(b), runs: model.runs };
    if (str) m = core ? core.insertText({ ...obj(), ...m }, a, str, keep) : { text: m.text.slice(0, a) + str + m.text.slice(a) };
    model = m;
    show({ start: a + str.length, end: a + str.length });
  };
  const history = (from, to) => {
    if (!from.length) return;
    to.push(snapshot());
    const st = from.pop();
    model = { text: st.text, runs: st.runs };
    lastKind = null;
    show(st.sel);
  };

  const layout = () => {
    box.h = boxH(model.text, s, box.w, minH, model.runs);
    Object.assign(el.style, {
      left: px(box.x), top: px(box.y), width: px(box.w), height: px(box.h),
      fontFamily: FAMILY[s.font], fontSize: px(s.fontSize), lineHeight: px(s.fontSize * s.lineHeight),
      fontWeight: s.bold ? 'bold' : 'normal', fontStyle: s.italic ? 'italic' : 'normal', color: s.color, textAlign: s.align,
      textDecorationLine: 'none', // on the run spans (runCss)
    });
    Object.assign(warn.style, { left: px(box.x), top: px(box.y + box.h + 2), minWidth: px(box.w) });
    checkWinAnsi(model.text, warn);
  };
  let done = false;
  const close = () => {
    done = true;
    if (editor === handle) editor = null;
    document.removeEventListener('selectionchange', track);
    el.remove();
    warn.remove();
    if (!layer.childElementCount) layer.remove();
  };
  const handle = {
    el, tab, pageIndex,
    getText: () => model.text,
    getRuns: () => model.runs,
    getSelection: () => ({ ...(domSel() ?? lastSel) }),
    setSelection(start, end = start) {
      const n = model.text.length, c = (v) => Math.min(Math.max(0, Math.trunc(Number(v) || 0)), n);
      lastSel = { start: Math.min(c(start), c(end)), end: Math.max(c(start), c(end)) };
      if (document.activeElement !== el) el.focus();
      setDomSel(lastSel);
    },
    styleAtSelection() {
      const { start, end } = handle.getSelection();
      return core ? core.styleAt(obj(), end > start ? start : Math.max(0, start - 1)) : { ...s, ...deco };
    },
    applyStyle(patch) {
      if (!core) return;
      const sel = handle.getSelection();
      const [a, b] = sel.end > sel.start ? [sel.start, sel.end] : [0, model.text.length];
      push('style');
      model = core.applyStyleToRange(obj(), a, b, patch);
      show(sel);
    },
    commit() {
      if (done) return;
      if (composing) model = parse();
      const value = model.text.replace(/\r\n?/g, '\n');
      const b = { ...box, h: boxH(value, s, box.w, minH, model.runs) };
      const r = model.runs;
      close();
      onCommit?.(value, b, s, r);
    },
    cancel() { if (done) return; close(); onCancel?.(); },
    setStyle(ns) {
      s = styleFrom({ ...s, ...ns });
      deco = { underline: !!(ns.underline ?? deco.underline), strike: !!(ns.strike ?? deco.strike) };
      const sel = handle.getSelection();
      show(sel);
    },
  };
  const track = () => { const v = domSel(); if (v) lastSel = v; };
  document.addEventListener('selectionchange', track);
  el.addEventListener('beforeinput', (e) => {
    const t = e.inputType;
    if (composing || e.isComposing || t === 'insertCompositionText') return;
    if (t === 'historyUndo' || t === 'historyRedo') { e.preventDefault(); if (t === 'historyUndo') history(undo, redo); else history(redo, undo); return; }
    if (/^format|List$|^insertHorizontalRule|^insertLink/.test(t)) { e.preventDefault(); return; }
    let str = null;
    if (t === 'insertParagraph' || t === 'insertLineBreak') str = '\n';
    else if (t.startsWith('insert')) str = String(e.data ?? e.dataTransfer?.getData('text/plain') ?? '').replace(/\r\n?/g, '\n');
    else if (!t.startsWith('delete')) return;
    e.preventDefault();
    const tr = e.getTargetRanges?.()[0];
    let r = tr ? { start: toOffset(tr.startContainer, tr.startOffset), end: toOffset(tr.endContainer, tr.endOffset) } : domSel() ?? lastSel;
    if (str == null && r.start === r.end) r = t.includes('Backward') ? { start: Math.max(0, r.start - 1), end: r.start } : { start: r.start, end: Math.min(model.text.length, r.start + 1) };
    if (str == null && r.start === r.end) return;
    replace(r.start, r.end, str ?? '', str === null ? 'delete' : t === 'insertText' ? 'type' : 'insert');
  });
  el.addEventListener('paste', (e) => {
    e.preventDefault();
    const dt = e.clipboardData;
    let str = dt?.getData('text/plain') ?? '';
    if (!str && dt?.getData('text/html')) str = new DOMParser().parseFromString(dt.getData('text/html'), 'text/html').body.textContent ?? '';
    const r = domSel() ?? lastSel;
    if (str || r.end > r.start) replace(r.start, r.end, str.replace(/\r\n?/g, '\n'), 'insert');
  });
  el.addEventListener('compositionstart', () => { composing = true; });
  el.addEventListener('compositionend', () => { composing = false; const sel = domSel() ?? lastSel; push('ime'); model = parse(); show(sel); });
  // Edits the browser made itself (IME, execCommand): read the DOM back.
  el.addEventListener('input', () => {
    const sel = domSel() ?? lastSel;
    if (composing) { model = parse(); layout(); return; }
    push('native');
    model = parse();
    show(sel);
  });
  el.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); handle.cancel(); } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); handle.commit(); } else if ((e.ctrlKey || e.metaKey) && !e.altKey && (k === 'z' || k === 'y')) {
      e.preventDefault(); e.stopPropagation();
      if (k === 'z' && !e.shiftKey) history(undo, redo); else history(redo, undo);
    } else if ((e.ctrlKey || e.metaKey) && !e.altKey && FORMAT_KEYS[k] && e.shiftKey === (k === 'x')) {
      e.preventDefault(); e.stopPropagation();
      const key = FORMAT_KEYS[k];
      if (toggleFormat) toggleFormat(key); else handle.applyStyle({ [key]: !handle.styleAtSelection()[key] });
    }
  });
  // Keep pointer events on the editor away from the tool dispatch (select tool would start a move).
  for (const t of ['pointerdown', 'pointermove', 'pointerup', 'dblclick']) el.addEventListener(t, (e) => e.stopPropagation());
  el.addEventListener('blur', (e) => {
    // selectionchange is async: take the selection now, before a format control has the focus.
    const v = selIn();
    if (v) lastSel = v;
    if (e.relatedTarget?.closest?.(FORMAT_UI) || !el.isConnected) return;
    // Window blur (switching apps) keeps the editor open.
    setTimeout(() => { if (!done && document.hasFocus() && document.activeElement !== el && !document.activeElement?.closest?.(FORMAT_UI)) handle.commit(); }, 0);
  });
  render();
  layer.append(el, warn);
  layout();
  editor = handle;
  el.focus();
  setDomSel(lastSel);
  return handle;
}
/** The open text editor handle (see openTextEditor), or null. */
export const activeTextEditor = () => editor;

// ---------------------------------------------------------------- create / re-edit
function createAt(tab, page, box, extra = {}) {
  const style = styleFrom({ ...state.toolStyle, ...extra.style });
  return attachFormatBar(openTextEditor(tab, page, box, {
    style, toggleFormat,
    onCommit(text, b, s, runs) {
      if (!text.trim()) { extra.onEmpty?.(); return; }
      const o = annotations.add(tab, { type: 'text', page, x: b.x, y: b.y, w: b.w, h: b.h, text, ...s, ...(runs ? { runs } : {}) });
      annotations.select(tab, [o.id]);
    },
    onCancel: () => extra.onEmpty?.(),
  }));
}

let widthCtx = null;
/** Paste: a text box with `text` at page point (x, y) in the current text style, kept inside the page; returns it. */
export function addTextBox(tab, page, x, y, text) {
  const s = styleFrom(), P = viewer.pageSize(tab, page);
  widthCtx ??= document.createElement('canvas').getContext('2d');
  widthCtx.font = `${s.italic ? 'italic ' : ''}${s.bold ? 'bold ' : ''}${s.fontSize}px ${FAMILY[s.font]}`;
  const natural = Math.max(...String(text).split('\n').map((l) => widthCtx.measureText(l).width)) + 2;
  const w = Math.max(MIN_W, Math.min(natural, P.width));
  const h = fitH(text, s, w);
  const bx = Math.min(Math.max(0, x), Math.max(0, P.width - w)), by = Math.min(Math.max(0, y), Math.max(0, P.height - h));
  const o = annotations.add(tab, { type: 'text', page, x: bx, y: by, w, h, text, ...s });
  annotations.select(tab, [o.id]);
  return o;
}

function reEdit(tab, o) {
  editingId = o.id;
  annotations.select(tab, []);
  showTextOptions(o);
  const restore = () => { editingId = null; annotations.render(tab, [o.page]); };
  const ed = openTextEditor(tab, o.page, o, {
    text: o.text, runs: o.runs, toggleFormat,
    style: { font: o.font, fontSize: o.fontSize, bold: o.bold, italic: o.italic, color: o.color, align: o.align, lineHeight: o.lineHeight, underline: o.underline, strike: o.strike },
    onCommit(text, b, s, runs) {
      editingId = null;
      if (!text.trim()) { annotations.remove(tab, [o.id]); return; }
      if (text !== o.text || b.h !== o.h || JSON.stringify(runs) !== JSON.stringify(o.runs)) annotations.update(tab, o.id, { text, h: b.h, runs });
      else annotations.render(tab, [o.page]);
      annotations.select(tab, [o.id]);
    },
    onCancel: restore,
  });
  if (ed) { ed.objectId = o.id; annotations.render(tab, [o.page]); attachFormatBar(ed); } else restore();
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
// Format controls (main options bar and the floating bar) carry data-fmt=<key>. While the Text tool's
// editor is open they style its selection (applyStyle) and keep it: buttons never take focus,
// selects / inputs hand focus and the selection back after a change. Without a selection (collapsed
// caret) or without an editor they set the box style (state.toolStyle), as before; underline /
// strike have no box style and style the whole text instead (disabled without an editor).
const DECO = new Set(['underline', 'strike']);
const FMT_TOGGLES = [['bold', 'Bold (Ctrl+B)', 'B'], ['italic', 'Italic (Ctrl+I)', 'I'], ['underline', 'Underline (Ctrl+U)', 'U'], ['strike', 'Strikethrough (Ctrl+Shift+X)', 'S']];
const toSelection = (key) => { const sel = editor?.getSelection(); return !!editor && (sel.end > sel.start || DECO.has(key)); };
function applyFormat(patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (toSelection(key)) editor.applyStyle({ [key]: value });
    else if (!DECO.has(key)) setStyleKey(key, value);
  }
  syncFormatControls();
}
const toggleFormat = (key) => applyFormat({ [key]: !(toSelection(key) ? editor.styleAtSelection() : state.toolStyle)[key] });
/** After a select / input took focus: back into the editor with its selection shown. */
function refocusEditor() { if (!editor) return; const { start, end } = editor.getSelection(); editor.setSelection(start, end); }
/** Show the style at the editor's selection (or the box style without an editor) on every format control. */
function syncFormatControls() {
  const st = editor ? editor.styleAtSelection() : styleFrom();
  for (const c of document.querySelectorAll('.options-bar [data-fmt], .text-format-bar [data-fmt]')) {
    const k = c.dataset.fmt;
    if (c.dataset.color) c.setAttribute('aria-pressed', String(c.dataset.color === String(st.color).toLowerCase()));
    else if (c.tagName === 'BUTTON') { c.setAttribute('aria-pressed', String(!!st[k])); if (DECO.has(k)) c.disabled = !editor; } else if (document.activeElement !== c) c.value = k === 'font' ? fontOf(st.font) : String(st[k]);
  }
}
const fmtButton = (key, label, glyph, cls) => h(`button.tb-btn.${cls}`, { type: 'button', title: label, 'aria-label': label.replace(/ \(.*/, ''), 'aria-pressed': String(!!state.toolStyle[key]), disabled: DECO.has(key) && !editor, dataset: { fmt: key },
  onmousedown: (e) => e.preventDefault(), onclick: () => toggleFormat(key) }, h(`span.opt-glyph-${key}`, {}, glyph));
const fontSelect = (cls) => h(`select.${cls}`, { dataset: { fmt: 'font' }, onchange: (e) => { applyFormat({ font: e.target.value }); refocusEditor(); } },
  FONTS.map((f) => h('option', { value: f, selected: fontOf(state.toolStyle.font) === f }, f)));
const sizeInput = (cls) => h(`input.${cls}`, { type: 'number', min: '4', max: '144', step: '0.5', value: String(state.toolStyle.fontSize), dataset: { fmt: 'fontSize' },
  onchange: (e) => { applyFormat({ fontSize: Number(e.target.value) || 12 }); refocusEditor(); } });
const colorInput = (cls, label) => h(`input.${cls}`, { type: 'color', 'aria-label': label, value: state.toolStyle.color, dataset: { fmt: 'color' },
  oninput: (e) => applyFormat({ color: e.target.value }), onchange: refocusEditor });
function fontCtl(c) {
  c.append(h('label.opt', {}, h('span', {}, 'Font'), fontSelect('opt-text-font')));
}
function sizeCtl(c) {
  c.append(h('label.opt', {}, h('span', {}, 'Size'), sizeInput('opt-font')));
}
function toggles(c) {
  c.append(h('div.opt-seg', { role: 'group', 'aria-label': 'Text style' }, FMT_TOGGLES.map(([k, label, glyph]) => fmtButton(k, label, glyph, `opt-text-${k}`))));
}
function colorCtl(c) {
  c.append(h('label.opt', {}, h('span', {}, 'Colour'), colorInput('opt-color')));
}
/**
 * Floating format bar (div.text-format-bar) for the open editor `ed`: font, size, B / I / U / S and
 * colour, just above the box (below it when there is no room above), following it on scroll / zoom
 * every frame; removed when the editor closes. Returns ed.
 */
function attachFormatBar(ed) {
  if (!ed) return ed;
  const bar = h('div.text-format-bar', { role: 'toolbar', 'aria-label': 'Text format' },
    fontSelect('tfb-font'), sizeInput('tfb-size'),
    ...FMT_TOGGLES.map(([k, label, glyph]) => fmtButton(k, label, glyph, `tfb-${k}`)),
    h('span.tfb-sep'),
    ...SWATCHES.map(([hex, label]) => h('button.tb-btn.tfb-swatch', { type: 'button', title: label, 'aria-label': label, dataset: { fmt: 'color', color: hex }, style: { background: hex },
      onmousedown: (e) => e.preventDefault(), onclick: () => applyFormat({ color: hex }) })),
    colorInput('tfb-color', 'Custom colour'));
  bar.querySelector('.tfb-font').setAttribute('aria-label', 'Font');
  bar.querySelector('.tfb-size').setAttribute('aria-label', 'Font size');
  document.body.append(bar);
  syncFormatControls();
  const GAP = 6;
  const place = () => {
    if (editor !== ed) { bar.remove(); syncFormatControls(); return; }
    const r = ed.el.getBoundingClientRect();
    const v = viewer.getScrollEl(ed.tab)?.getBoundingClientRect() ?? { top: 0, left: 0, bottom: innerHeight, right: innerWidth };
    bar.hidden = !(r.bottom > v.top && r.top < v.bottom && r.right > v.left && r.left < v.right);
    if (!bar.hidden) {
      const bh = bar.offsetHeight, bw = bar.offsetWidth;
      let top = r.top - bh - GAP;
      if (top < v.top) top = Math.min(r.bottom + GAP, v.bottom - bh);
      const left = Math.max(v.left, Math.min(r.left, v.right - bw));
      bar.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    }
    requestAnimationFrame(place);
  };
  place();
  return ed;
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
      onmousedown: (e) => e.preventDefault(), onclick: () => { for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.align === a)); setStyleKey('align', a); } }));
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
  syncFormatControls();
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
    if (!editor || editor.el.contains(e.target) || e.target.closest?.(`${FORMAT_UI}, .dialog, .menu`)) return;
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
  // B / I / U / S, font, size and colour show the style at the caret / selection while editing.
  document.addEventListener('selectionchange', () => { if (editor && document.activeElement === editor.el) syncFormatControls(); });
  bus.on('rotation:changed', ({ tab }) => {
    for (let i = 0; i < (tab.numPages ?? 0); i++) viewer.getOverlayEl(tab, i)?.querySelector(':scope > .text-edit-layer')?.setAttribute('data-view-rotation', String(tab.viewRotation));
  });
  bus.on('tab:activated', () => editor?.commit());
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || dialogOpen() || isTyping(e.target) || !activeTab()) return;
    if (e.key.toLowerCase() === 't') { e.preventDefault(); toggleTool('text'); }
  });
}
