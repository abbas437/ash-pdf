// Text markup tools (Highlight text H, Underline U, Strikeout K), Sticky note (N) and
// "Add comment" (Enter / Edit > Comment…) for any selected object. Objects follow
// docs/CORE-API.md: text markups carry `quads` in visible page space (text-frame corner order,
// see markup-geom.js); notes are {x, y, w, h, icon, color, note}; any object may carry `note`.
// Text markups read the browser selection on the pdf.js text layer: drag across text with the
// tool active, or select text first and then pick the tool.
import { bus } from '../bus.js';
import { state, activeTab } from '../state.js';
import { h, isTyping } from './dom.js';
import { dialogOpen } from './dialogs.js';
import { registerTool, setTool } from './toolbar.js';
import { viewer } from './viewer.js';
import { annotations, getAuthor } from './annotations.js';
import { textAngle, quadsFromBoxes, quadsBox } from './markup-geom.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const TEXT_TYPES = {
  textHighlight: { tool: 'text-highlight', label: 'Highlight text', key: 'H', color: '#ffd400', opacity: 0.4, icon: '<path d="M4 20h16"/><path d="M7 15l7-9 4 3-7 9H7z"/>' },
  underline: { tool: 'underline', label: 'Underline text', key: 'U', color: '#2e8b57', opacity: 1, icon: '<path d="M7 4v7a5 5 0 0 0 10 0V4"/><path d="M5 20h14"/>' },
  strikeout: { tool: 'strikeout', label: 'Strikeout text', key: 'K', color: '#d62828', opacity: 1, icon: '<path d="M16 6.5A4 3 0 0 0 8 7c0 4 8 3 8 7a4 3 0 0 1-8 .5"/><path d="M4 12h16"/>' },
};
const styles = Object.fromEntries(Object.entries(TEXT_TYPES).map(([t, d]) => [t, { color: d.color, opacity: d.opacity }]));
const NOTE_ICON = '<path d="M4 5h16v11H10l-4 4v-4H4z"/><path d="M8 9h8M8 12h5"/>';
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
  bbox: (o) => quadsBox(o.quads),
  handles: () => [],
  move: (o, dx, dy) => ({ quads: o.quads.map((q) => q.map((v, i) => v + (i % 2 ? dy : dx))) }),
  resize: () => ({}),
  style: () => ({}),
};
const noteBox = (o) => ({ x: o.x, y: o.y, w: o.w ?? 20, h: o.h ?? 20 });
const noteType = {
  render(o, parent) {
    const b = noteBox(o), s = b.w / 24;
    const g = svgEl('g', { class: 'ann-note', transform: `translate(${r3(b.x)} ${r3(b.y)}) scale(${r3(s)})` }, parent);
    svgEl('rect', { x: 0.5, y: 0.5, width: 23, height: 23, rx: 4, fill: o.color ?? '#ffd400', stroke: '#16261f', 'stroke-width': 1 }, g);
    const ic = svgEl('g', { fill: 'none', stroke: '#16261f', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
    ic.innerHTML = NOTE_ICON;
    return g;
  },
  bbox: noteBox,
  handles: () => [],
  move: (o, dx, dy) => ({ x: o.x + dx, y: o.y + dy }),
  resize: () => ({}),
  style: () => ({}),
};

// ---------------------------------------------------------------- selection -> quads
/** Page-space fragment boxes of the current text-layer selection, grouped by page index. */
function selectionBoxes(tab) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const byPage = new Map();
  for (let i = 0; i < tab.numPages; i++) {
    const pageEl = viewer.getPageEl(tab, i);
    const tl = pageEl?.querySelector('.textLayer');
    if (!tl || !range.intersectsNode(tl)) continue;
    const main = Number(tl.getAttribute('data-main-rotation')) || 0;
    const boxes = [];
    for (const span of tl.querySelectorAll('span')) {
      const node = span.firstChild;
      if (span.classList.contains('hl') || node?.nodeType !== 3 || !range.intersectsNode(node)) continue;
      const r = document.createRange();
      r.setStart(node, node === range.startContainer ? range.startOffset : 0);
      r.setEnd(node, node === range.endContainer ? range.endOffset : node.length);
      if (r.collapsed || !r.toString().trim()) continue;
      const angle = textAngle(main, tab.viewRotation ?? 0, parseFloat(span.style.getPropertyValue('--rotate')) || 0);
      for (const cr of r.getClientRects()) {
        if (cr.width < 0.5 || cr.height < 0.5) continue;
        const pts = [[cr.left, cr.top], [cr.right, cr.top], [cr.left, cr.bottom], [cr.right, cr.bottom]].map(([x, y]) => annotations.toPage(tab, i, x, y));
        const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
        boxes.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), angle });
      }
    }
    if (boxes.length) byPage.set(i, boxes);
  }
  return byPage.size ? byPage : null;
}
/** Turn the text selection into one markup object per page; returns the new objects. */
function applyTextMarkup(tab, type) {
  if (!tab || tab.readOnly) return [];
  const byPage = selectionBoxes(tab);
  if (!byPage) return [];
  const made = [];
  annotations.batch(tab, () => {
    for (const [page, boxes] of byPage) made.push(annotations.add(tab, { type, page, quads: quadsFromBoxes(boxes), ...styles[type] }));
  });
  window.getSelection().removeAllRanges();
  annotations.select(tab, made.map((o) => o.id));
  return made;
}

// ---------------------------------------------------------------- comment / note popup
let popup = null;
function closePopup(save) {
  if (!popup) return;
  const { el, tab, id, ta, before } = popup;
  popup = null;
  el.remove();
  if (save && annotations.getObject(tab, id) && ta.value !== before) annotations.update(tab, id, { note: ta.value });
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
  const el = h('div.mk-popup', { role: 'dialog', 'aria-label': o.type === 'note' ? 'Sticky note' : 'Comment' },
    h('div.mk-popup-head', {}, h('span.mk-popup-author', {}, author), h('span.mk-popup-date', {}, date.toLocaleString())),
    ta,
    h('div.mk-popup-actions', {},
      h('button.mk-popup-btn', { type: 'button', onclick: () => closePopup(false) }, 'Cancel'),
      h('button.mk-popup-btn.primary', { type: 'button', onclick: () => closePopup(true) }, 'Save')));
  el.style.left = `${Math.max(8, Math.min(c.clientX + 8, window.innerWidth - 268))}px`;
  el.style.top = `${Math.max(8, Math.min(c.clientY, window.innerHeight - 200))}px`;
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); closePopup(false); } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); closePopup(true); }
  });
  document.body.append(el);
  popup = { el, tab, id, ta, before: ta.value };
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
    const o = annotations.add(tab, { type: 'note', page: hit.pageIndex, x: p.x - 10, y: p.y - 10, w: 20, h: 20, icon: 'Comment', color: '#ffd400', note: '' });
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
      onPointerUp: (e, { tab }) => { if (e.button === 0) setTimeout(() => applyTextMarkup(tab, type), 0); },
    });
  }
  registerTool({ id: 'note', label: 'Sticky note', icon: svgIcon(NOTE_ICON), shortcut: 'N', cursor: 'copy', ...noteTool, onDeactivate: () => closePopup(true) });
  const selected = () => { const t = activeTab(); const s = t ? annotations.getSelection(t) : []; return s.length === 1 ? s[0] : null; };
  app?.registerMenuItem?.('Edit', { id: 'add-comment', label: 'Comment on selection…', shortcut: 'Enter', action: () => { const id = selected(); if (id) openComment(activeTab(), id); }, enabled: () => !!selected() });
  window.addEventListener('pointerdown', (e) => { if (popup && !e.target.closest?.('.mk-popup')) closePopup(true); }, true);
  document.addEventListener('dblclick', (e) => {
    const tab = activeTab();
    const n = tab && e.target.closest?.('.page') && noteAt(tab, e.clientX, e.clientY);
    if (n) { annotations.select(tab, [n.id]); openComment(tab, n.id); }
  });
  bus.on('tab:activated', () => closePopup(true));
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || dialogOpen() || isTyping(e.target) || !activeTab()) return;
    if (e.key === 'Enter' && selected()) { e.preventDefault(); openComment(activeTab(), selected()); return; }
    // H highlights selected text; without a text selection it stays the area Highlight (tools-shapes).
    const k = e.key.toLowerCase();
    if (k === 'h' && !textSelected()) return;
    const tool = { h: 'text-highlight', u: 'underline', k: 'strikeout', n: 'note' }[k];
    if (tool) { e.preventDefault(); e.stopImmediatePropagation(); setTool(tool); }
  }, true);
}

export const markupTools = { applyTextMarkup, openComment, closePopup, styles };
