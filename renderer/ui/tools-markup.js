// Text markup tools (Highlight text H, Underline U, Strikeout K, Squiggly G), Sticky note (N) and
// "Add comment" (Enter / Edit > Comment…) for any selected object. Objects follow
// docs/CORE-API.md: text markups carry `quads` in visible page space (text-frame corner order,
// see markup-geom.js); notes are {x, y, w, h, icon, color, note}; any object may carry `note`.
// Text markups select TEXT like a text selection: a drag runs from the char boundary under the
// press to the one under the release in reading order (markup-geom.js character model built from
// the page's text content); double-click marks a word; a plain click does nothing. Text selected
// with the Select tool first is converted the same way when the tool is picked. Text markups are
// fixed to their text: they can be selected, restyled, commented and deleted, never moved.
import { bus } from '../bus.js';
import { state, activeTab } from '../state.js';
import { h, isTyping } from './dom.js';
import { dialogOpen } from './dialogs.js';
import { registerTool, setTool, toggleTool } from './toolbar.js';
import { viewer } from './viewer.js';
import { annotations, getAuthor } from './annotations.js';
import { quadsBox, buildCharModel, caretAt, wordAt, rangeQuads } from './markup-geom.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const TEXT_TYPES = {
  textHighlight: { tool: 'text-highlight', label: 'Highlight text', key: 'H', color: '#ffd400', opacity: 0.4, icon: '<path d="M4 20h16"/><path d="M7 15l7-9 4 3-7 9H7z"/>' },
  underline: { tool: 'underline', label: 'Underline text', key: 'U', color: '#2e8b57', opacity: 1, icon: '<path d="M7 4v7a5 5 0 0 0 10 0V4"/><path d="M5 20h14"/>' },
  strikeout: { tool: 'strikeout', label: 'Strikeout text', key: 'K', color: '#d62828', opacity: 1, icon: '<path d="M16 6.5A4 3 0 0 0 8 7c0 4 8 3 8 7a4 3 0 0 1-8 .5"/><path d="M4 12h16"/>' },
  squiggly: { tool: 'squiggly', label: 'Squiggly underline', key: 'G', color: '#2e8b57', opacity: 1, icon: '<path d="M7 4v7a5 5 0 0 0 10 0V4"/><path d="M4 20l2-2 2 2 2-2 2 2 2-2 2 2 2-2 2 2"/>' },
};
const styles = Object.fromEntries(Object.entries(TEXT_TYPES).map(([t, d]) => [t, { color: d.color, opacity: d.opacity }]));
const NOTE_ICON = '<path d="M4 5h16v11H10l-4 4v-4H4z"/><path d="M8 9h8M8 12h5"/>';
// Sticky note icons (the core writes the name as /Name; the overlay draws one glyph per name).
const NOTE_ICONS = {
  Comment: NOTE_ICON,
  Note: '<path d="M6 4h9l3 3v13H6z"/><path d="M9 10h6M9 13h6M9 16h4"/>',
  Key: '<circle cx="8" cy="12" r="3.5"/><path d="M11.5 12H20M17 12v3M20 12v2"/>',
  Help: '<circle cx="12" cy="12" r="8"/><path d="M9.5 9.5a2.5 2.5 0 0 1 4.8 1c0 1.7-2.3 2-2.3 3.5"/><path d="M12 17h.01"/>',
  Paragraph: '<path d="M13 4v16M17 4v16M19 4h-9a4 4 0 0 0 0 8h3"/>',
  Insert: '<path d="M6 17l6-10 6 10"/>',
};
const noteStyle = { icon: 'Comment' };
const iconSelect = (cls, value, onchange) => h(`select.${cls}`, { 'aria-label': 'Note icon', onchange }, Object.keys(NOTE_ICONS).map((n) => h('option', { value: n, selected: n === value }, n)));
const svgIcon = (inner) => `<svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`;
const r3 = (v) => Math.round(v * 1000) / 1000;
function svgEl(name, attrs, parent) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  parent?.append(el);
  return el;
}

// ---------------------------------------------------------------- object types
const qPt = (q, i) => [q[2 * i], q[2 * i + 1]]; // 0 TL, 1 TR, 2 BL, 3 BR
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const qHeight = (q) => Math.hypot(q[4] - q[0], q[5] - q[1]);
function renderMarkup(o, parent) {
  const g = svgEl('g', { class: `ann-tm ann-${o.type}`, opacity: Number.isFinite(o.opacity) ? o.opacity : 1 }, parent);
  for (const q of o.quads ?? []) {
    const [TL, TR, BL, BR] = [0, 1, 2, 3].map((i) => qPt(q, i));
    if (o.type === 'textHighlight') {
      svgEl('path', { d: `M${r3(TL[0])} ${r3(TL[1])}L${r3(TR[0])} ${r3(TR[1])}L${r3(BR[0])} ${r3(BR[1])}L${r3(BL[0])} ${r3(BL[1])}Z`, fill: o.color ?? '#ffd400' }, g);
      continue;
    }
    const sw = Number.isFinite(o.strokeWidth) ? o.strokeWidth : qHeight(q) / 14;
    if (o.type === 'squiggly') { // zigzag along the bottom edge, as the core's appearance stream draws it
      const hgt = qHeight(q) || 1, len = Math.hypot(BR[0] - BL[0], BR[1] - BL[1]) || 1, step = hgt / 6;
      const u = [(TL[0] - BL[0]) / hgt, (TL[1] - BL[1]) / hgt], v = [(BR[0] - BL[0]) / len, (BR[1] - BL[1]) / len];
      const pts = [];
      for (let d = 0, i = 0; d <= len; d += step, i++) { const up = (i % 2 ? step : 0) + sw / 2; pts.push(`${r3(BL[0] + v[0] * d + u[0] * up)},${r3(BL[1] + v[1] * d + u[1] * up)}`); }
      svgEl('polyline', { points: pts.join(' '), fill: 'none', stroke: o.color ?? '#000000', 'stroke-width': r3(sw), 'stroke-linejoin': 'round' }, g);
      continue;
    }
    const t = o.type === 'strikeout' ? 0.5 : 1 - sw / 2 / (qHeight(q) || 1);
    const a = lerp(TL, BL, t), b = lerp(TR, BR, t);
    svgEl('line', { x1: r3(a[0]), y1: r3(a[1]), x2: r3(b[0]), y2: r3(b[1]), stroke: o.color ?? '#000000', 'stroke-width': r3(sw) }, g);
  }
  // Transparent hit area so the whole marked text is clickable.
  for (const q of o.quads ?? []) svgEl('path', { d: `M${q[0]} ${q[1]}L${q[2]} ${q[3]}L${q[6]} ${q[7]}L${q[4]} ${q[5]}Z`, fill: 'transparent' }, g);
  return g;
}
const markupType = {
  render: renderMarkup,
  fixed: true, // attached to its text: never moved or resized
  bbox: (o) => quadsBox(o.quads),
  outline: (o) => o.quads.map((q) => [0, 1, 3, 2].map((i) => qPt(q, i))),
  hit: (o, x, y, tol) => o.quads.some((q) => { const b = quadsBox([q]); return x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol; }),
  handles: () => [],
  move: (o, dx, dy) => ({ quads: o.quads.map((q) => q.map((v, i) => v + (i % 2 ? dy : dx))) }),
  resize: () => ({}),
  style: () => ({}),
};
const noteBox = (o) => ({ x: o.x, y: o.y, w: o.w ?? 20, h: o.h ?? 20 });
const noteType = {
  render(o, parent) {
    const b = noteBox(o), s = b.w / 24;
    const name = NOTE_ICONS[o.icon] ? o.icon : 'Comment';
    const g = svgEl('g', { class: 'ann-note', 'data-icon': name, transform: `translate(${r3(b.x)} ${r3(b.y)}) scale(${r3(s)})` }, parent);
    svgEl('rect', { x: 0.5, y: 0.5, width: 23, height: 23, rx: 4, fill: o.color ?? '#ffd400', stroke: '#16261f', 'stroke-width': 1 }, g);
    const ic = svgEl('g', { fill: 'none', stroke: '#16261f', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
    ic.innerHTML = NOTE_ICONS[name];
    return g;
  },
  bbox: noteBox,
  handles: () => [],
  move: (o, dx, dy) => ({ x: o.x + dx, y: o.y + dy }),
  resize: () => ({}),
  style: () => ({}),
};

// ---------------------------------------------------------------- text -> quads
const models = new WeakMap(); // textContent -> character model (one per page, rebuilt with the text cache)
let measureCtx = null;
function measure(chars, family) {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  measureCtx.font = `100px ${family}`;
  return chars.map((ch) => measureCtx.measureText(ch).width);
}
async function pageModel(tab, i) {
  const tc = await viewer.getTextContent(tab, i);
  if (!tc) return null;
  if (!models.has(tc)) {
    const vp = tab.pages[i].getViewport({ scale: 1 });
    models.set(tc, buildCharModel(tc.items, tc.styles, (x, y) => vp.convertToViewportPoint(x, y), measure));
  }
  return models.get(tc);
}
/** Add one markup of `type` per page from {page: quads}; selects and returns the new objects. */
function addMarkups(tab, type, byPage) {
  const made = [];
  annotations.batch(tab, () => {
    for (const [page, quads] of byPage) if (quads.length) made.push(annotations.add(tab, { type, page, quads, ...styles[type] }));
  });
  if (made.length) annotations.select(tab, made.map((o) => o.id));
  return made;
}
/** Convert the browser's text-layer selection (made with the Select tool) into markups; returns the new objects. */
async function applyTextMarkup(tab, type) {
  const sel = window.getSelection();
  if (!tab || tab.readOnly || !sel || sel.isCollapsed || !sel.rangeCount) return [];
  const range = sel.getRangeAt(0);
  const caret = (node, off, end) => {
    const r = document.createRange();
    r.setStart(node, off); r.setEnd(node, off);
    const rects = [...r.getClientRects()];
    let cr = rects[0] ?? r.getBoundingClientRect();
    if (!cr.width && !cr.height) { const el = node.nodeType === 3 ? node.parentElement : node; cr = el?.getBoundingClientRect(); if (!cr) return null; return { x: end ? cr.right : cr.left, y: cr.top + cr.height / 2 }; }
    return { x: cr.left, y: cr.top + cr.height / 2 };
  };
  const p0 = caret(range.startContainer, range.startOffset, false), p1 = caret(range.endContainer, range.endOffset, true);
  if (!p0 || !p1) return [];
  const h0 = viewer.clientToPage(tab, p0.x, p0.y), h1 = viewer.clientToPage(tab, p1.x, p1.y);
  if (!h0 || !h1) return [];
  const byPage = new Map();
  for (let i = h0.pageIndex; i <= h1.pageIndex; i++) {
    const m = await pageModel(tab, i);
    if (!m?.chars.length) continue;
    const a = i === h0.pageIndex ? caretAt(m, h0.x, h0.y) : 0, b = i === h1.pageIndex ? caretAt(m, h1.x, h1.y) : m.chars.length;
    byPage.set(i, rangeQuads(m, a, b));
  }
  sel.removeAllRanges();
  return addMarkups(tab, type, byPage);
}

// Drag selection: press -> caret, live preview while dragging, release -> one markup.
let drag = null;
function endDrag(e) {
  const g = drag;
  if (!g || (e && e.pointerId !== g.pointerId)) return;
  drag = null;
  window.removeEventListener('pointermove', g.onMove, true);
  window.removeEventListener('pointerup', endDrag, true);
  window.removeEventListener('pointercancel', endDrag, true);
  annotations.renderPreview(g.tab, g.page, null);
  if (!e || e.type !== 'pointerup' || !g.moved) return;
  g.ready.then(() => {
    const b = g.model && g.a != null ? caretAt(g.model, ...g.at(e)) : null;
    if (b != null && b !== g.a) addMarkups(g.tab, g.type, new Map([[g.page, rangeQuads(g.model, g.a, b)]]));
  });
}
function startDrag(e, tab, type, page) {
  endDrag(null);
  const at = (ev) => { const p = annotations.toPage(tab, page, ev.clientX, ev.clientY); return [p.x, p.y]; };
  const g = { tab, type, page, pointerId: e.pointerId, x: e.clientX, y: e.clientY, at, model: null, a: null, moved: false };
  g.ready = pageModel(tab, page).then((m) => {
    if (!m) return;
    g.model = m;
    const [x, y] = at(e), L = m.lines[0];
    g.a = caretAt(m, x, y, L ? 1.5 * (L.c1 - L.c0) : 0); // the press must be on or next to text
  });
  g.onMove = (ev) => {
    if (ev.pointerId !== g.pointerId) return;
    if (!g.moved && Math.hypot(ev.clientX - g.x, ev.clientY - g.y) < 3) return;
    g.moved = true;
    if (!g.model || g.a == null) return;
    const quads = rangeQuads(g.model, g.a, caretAt(g.model, ...at(ev)));
    annotations.renderPreview(tab, page, quads.length ? { type, page, quads, ...styles[type] } : null);
  };
  window.addEventListener('pointermove', g.onMove, true);
  window.addEventListener('pointerup', endDrag, true);
  window.addEventListener('pointercancel', endDrag, true);
  drag = g;
}
const textToolHandlers = (type) => ({
  onPointerDown(e, { tab, hit }) {
    if (e.button !== 0 || !hit || tab.readOnly || e.target.closest?.('.mk-popup')) return;
    e.preventDefault();
    window.getSelection()?.removeAllRanges();
    startDrag(e, tab, type, hit.pageIndex);
  },
});
/** Double-click with a text tool: mark the word under the pointer. */
async function markWord(tab, type, clientX, clientY) {
  const hit = viewer.clientToPage(tab, clientX, clientY);
  if (!hit || tab.readOnly) return [];
  const m = await pageModel(tab, hit.pageIndex);
  const w = m && wordAt(m, hit.x, hit.y);
  return w ? addMarkups(tab, type, new Map([[hit.pageIndex, rangeQuads(m, ...w)]])) : [];
}

// ---------------------------------------------------------------- comment / note popup
let popup = null;
function closePopup(save) {
  if (!popup) return;
  const { el, tab, id, ta, before, iconSel, iconBefore } = popup;
  popup = null;
  el.remove();
  const patch = {};
  if (ta.value !== before) patch.note = ta.value;
  if (iconSel && iconSel.value !== iconBefore) patch.icon = iconSel.value;
  if (save && annotations.getObject(tab, id) && Object.keys(patch).length) annotations.update(tab, id, patch);
}
/** Inline editor for obj.note (the sticky note text, or any object's comment). */
async function openComment(tab, id) {
  closePopup(true);
  const o = annotations.getObject(tab, id);
  if (!o || tab.readOnly) return;
  const author = o.author || await getAuthor();
  const b = o.quads ? quadsBox(o.quads) : { x: o.x ?? o.x1 ?? 0, y: o.y ?? o.y1 ?? 0, w: o.w ?? 0, h: o.h ?? 0 };
  const c = viewer.pageToClient(tab, o.page, b.x + b.w, b.y);
  const date = new Date(o.modified || o.created || Date.now());
  const ta = h('textarea.mk-popup-text', { rows: 5, 'aria-label': o.type === 'note' ? 'Note text' : 'Comment', placeholder: o.type === 'note' ? 'Note…' : 'Comment…' });
  ta.value = o.note ?? '';
  const iconSel = o.type === 'note' ? iconSelect('mk-popup-icon', o.icon, () => {}) : null;
  const el = h('div.mk-popup', { role: 'dialog', 'aria-label': o.type === 'note' ? 'Sticky note' : 'Comment' },
    h('div.mk-popup-head', {}, h('span.mk-popup-author', {}, author), h('span.mk-popup-date', {}, date.toLocaleString())),
    ta,
    h('div.mk-popup-actions', {}, iconSel,
      h('button.mk-popup-btn', { type: 'button', onclick: () => closePopup(false) }, 'Cancel'),
      h('button.mk-popup-btn.primary', { type: 'button', onclick: () => closePopup(true) }, 'Save')));
  el.style.left = `${Math.max(8, Math.min(c.clientX + 8, window.innerWidth - 268))}px`;
  el.style.top = `${Math.max(8, Math.min(c.clientY, window.innerHeight - 200))}px`;
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); closePopup(false); } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); closePopup(true); }
  });
  document.body.append(el);
  popup = { el, tab, id, ta, before: ta.value, iconSel, iconBefore: iconSel?.value };
  ta.focus();
}

// ---------------------------------------------------------------- tools
function noteAt(tab, clientX, clientY) {
  const hit = viewer.clientToPage(tab, clientX, clientY);
  if (!hit) return null;
  return annotations.list(tab, hit.pageIndex).reverse().find((o) => o.type === 'note' && hit.x >= o.x && hit.x <= o.x + (o.w ?? 20) && hit.y >= o.y && hit.y <= o.y + (o.h ?? 20)) ?? null;
}
const noteTool = {
  onPointerDown(e, { tab, hit }) {
    if (e.button !== 0 || !hit || tab.readOnly || e.target.closest?.('.mk-popup')) return;
    e.preventDefault();
    const existing = noteAt(tab, e.clientX, e.clientY);
    if (existing) { annotations.select(tab, [existing.id]); openComment(tab, existing.id); return; }
    const p = annotations.toPage(tab, hit.pageIndex, e.clientX, e.clientY);
    const o = annotations.add(tab, { type: 'note', page: hit.pageIndex, x: p.x - 10, y: p.y - 10, w: 20, h: 20, icon: noteStyle.icon, color: '#ffd400', note: '' });
    annotations.select(tab, [o.id]);
    openComment(tab, o.id);
  },
};

const textSelected = () => { const s = window.getSelection(); return !!(s && !s.isCollapsed && s.anchorNode?.parentElement?.closest('.textLayer')); };
let inited = false;
export function initMarkupTools(app) {
  if (inited) return;
  inited = true;
  for (const t of Object.keys(TEXT_TYPES)) annotations.registerObjectType(t, markupType);
  annotations.registerObjectType('note', noteType);
  for (const [type, d] of Object.entries(TEXT_TYPES)) {
    const colorCtl = (c) => c.append(h('label.opt', {}, h('span', {}, 'Colour'), h('input.opt-tm-color', { type: 'color', value: styles[type].color, oninput: (e) => { styles[type].color = e.target.value; } })));
    const opacityCtl = (c) => c.append(h('label.opt', {}, h('span', {}, 'Opacity'), h('input.opt-tm-opacity', { type: 'range', min: '0.1', max: '1', step: '0.05', value: String(styles[type].opacity), oninput: (e) => { styles[type].opacity = Number(e.target.value); } })));
    registerTool({
      id: d.tool, label: d.label, icon: svgIcon(d.icon), shortcut: d.key === 'H' ? 'H with text selected' : d.key, cursor: 'text', options: [colorCtl, opacityCtl],
      onActivate: () => applyTextMarkup(activeTab(), type),
      onDeactivate: () => endDrag(null),
      ...textToolHandlers(type),
    });
  }
  app?.registerMenuItem?.('Tools', { id: 'squiggly', label: 'Squiggly underline', shortcut: 'G', action: () => setTool('squiggly') });
  const noteIconCtl = (c) => c.append(h('label.opt', {}, h('span', {}, 'Icon'), iconSelect('opt-note-icon', noteStyle.icon, (e) => { noteStyle.icon = e.target.value; })));
  registerTool({ id: 'note', label: 'Sticky note', icon: svgIcon(NOTE_ICON), shortcut: 'N', cursor: 'copy', options: [noteIconCtl], ...noteTool, onDeactivate: () => closePopup(true) });
  const selected = () => { const t = activeTab(); const s = t ? annotations.getSelection(t) : []; return s.length === 1 ? s[0] : null; };
  app?.registerMenuItem?.('Edit', { id: 'add-comment', label: 'Comment on selection…', shortcut: 'Enter', action: () => { const id = selected(); if (id) openComment(activeTab(), id); }, enabled: () => !!selected() });
  window.addEventListener('pointerdown', (e) => { if (popup && !e.target.closest?.('.mk-popup')) closePopup(true); }, true);
  const typeOfTool = Object.fromEntries(Object.entries(TEXT_TYPES).map(([t, d]) => [d.tool, t]));
  bus.on('tool:changed', ({ tool }) => document.body.classList.toggle('tm-text', !!typeOfTool[tool]));
  document.addEventListener('dblclick', (e) => {
    const tab = activeTab();
    const n = tab && e.target.closest?.('.page') && noteAt(tab, e.clientX, e.clientY);
    if (n) { annotations.select(tab, [n.id]); openComment(tab, n.id); return; }
    if (tab && typeOfTool[state.tool] && e.button === 0 && e.target.closest?.('.page')) markWord(tab, typeOfTool[state.tool], e.clientX, e.clientY);
  });
  bus.on('tab:activated', () => closePopup(true));
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || dialogOpen() || isTyping(e.target) || !activeTab()) return;
    if (e.key === 'Enter' && selected()) { e.preventDefault(); openComment(activeTab(), selected()); return; }
    // H highlights selected text; without a text selection it stays the area Highlight (tools-shapes).
    const k = e.key.toLowerCase();
    if (k === 'h' && !textSelected()) return;
    const tool = { h: 'text-highlight', u: 'underline', k: 'strikeout', g: 'squiggly', n: 'note' }[k];
    if (tool) { e.preventDefault(); e.stopImmediatePropagation(); toggleTool(tool); }
  }, true);
}

export const markupTools = { applyTextMarkup, markWord, openComment, closePopup, styles, noteStyle, NOTE_ICONS };
