// Stamp, Image and Signature tools. Objects are the core's `stamp` and `image` overlay objects
// (src/core/annotate.js), stored through ui/annotations.js so undo, selection, the status-bar
// count and flatten-on-save all apply. Coordinates: visible page space in points.
//   Stamp (S): preset or custom text in an outlined box; click places a default-size stamp,
//              drag sets the box. "Add date" places a second stamp `DATE: YYYY-MM-DD` below it.
//   Image (I): pick a PNG/JPEG (type from the file signature), click a page to place it.
//   Signatures are placed through ui/sign.js (Sign button), which arms the image tool via armImage.
import { bus } from '../bus.js';
import { state, activeTab } from '../state.js';
import { h, isTyping } from './dom.js';
import { dialogOpen } from './dialogs.js';
import { registerTool, setTool } from './toolbar.js';
import { viewer } from './viewer.js';
import { annotations, resizeBox, getAuthor } from './annotations.js';
import { STANDARD_STAMPS, DYNAMIC_STAMPS, stampSubtext, stampLayout } from '../../src/core/stamps.js';
import { DATE_FORMATS } from '../../src/core/siglib.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const COLOURS = [['#1b7f3b', 'Green'], ['#d62828', 'Red'], ['#1d4ed8', 'Blue'], ['#d97706', 'Orange']];
const STAMP_FONT_PT = 14;
const STAMP_BORDER = 2;
const CAP_H = 0.718;          // Helvetica-Bold cap height per unit font size (as the core uses)
const MIN_PX = 3;             // smaller drags are clicks
const IMAGE_FRAC = 0.4;       // default image width, fraction of page width

const opt = { stamp: STANDARD_STAMPS[0], text: 'APPROVED', color: '#1b7f3b', rotation: 0, addDate: false, imgOpacity: 1, imgRotation: 0,
  dyn: { dateFormat: 'YYYY-MM-DD', showAuthor: true, showDate: true, showTime: false } };
const LIB = 'stamp', LAST_KEY = 'stamps.last', DYN_KEY = 'stamps.dynamic';
let custom = [];             // [{id, text, color, borderWidth, name, order}] from the library (kind 'stamp')
let pending = null;           // armed image: {bytes, mime, url, nw, nh, frac, width?, extra?, companions?, onPlaced?}
let shiftHeld = false;
let app = null;

const svgEl = (name, attrs, parent) => {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  parent?.append(el);
  return el;
};
const pageBox = (tab, i) => viewer.pageSize(tab, i);
const today = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

// ---------------------------------------------------------------- text metrics
let measureCtx = null;
/** Width of `text` at font size 1 in Helvetica Bold (falls back to Arial Bold metrics). */
function textWidth1(text) {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  measureCtx.font = 'bold 100px Helvetica, Arial, "Liberation Sans", sans-serif';
  return measureCtx.measureText(text || ' ').width / 100;
}
/** Default stamp box for `text` (about 14 pt type inside a 2 pt border). */
function stampSize(text, fontPt = STAMP_FONT_PT, sub = '') {
  const pad = STAMP_BORDER + 4;
  if (sub) return { w: Math.max(textWidth1(text) * fontPt, textWidth1(sub) * fontPt * 0.6) + 2 * pad + 8, h: (CAP_H * fontPt) / 0.6 + 2 * pad };
  return { w: textWidth1(text) * fontPt + 2 * pad + 8, h: CAP_H * fontPt + 2 * pad + 8 };
}

// ---------------------------------------------------------------- object types
const BOX_IDS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
function boxHandles(o, ids = BOX_IDS) {
  const P = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };
  return ids.map((id) => ({ id, x: o.x + P[id][0] * o.w, y: o.y + P[id][1] * o.h }));
}
const rotAttr = (o) => (o.rotation ? `rotate(${o.rotation} ${o.x + o.w / 2} ${o.y + o.h / 2})` : null);
const boxCommon = {
  bbox: (o) => ({ x: o.x, y: o.y, w: o.w, h: o.h }),
  hit: (o, x, y, tol) => x >= o.x - tol && x <= o.x + o.w + tol && y >= o.y - tol && y <= o.y + o.h + tol,
  move: (o, dx, dy) => ({ x: o.x + dx, y: o.y + dy }),
};
const stampType = {
  ...boxCommon,
  render(o, parent) {
    const bw = Number.isFinite(o.borderWidth) ? o.borderWidth : 3;
    const color = o.color ?? '#c00000';
    const g = svgEl('g', { class: 'ann-stamp', transform: rotAttr(o), opacity: Number.isFinite(o.opacity) ? o.opacity : null }, parent);
    if (bw > 0) svgEl('rect', { x: o.x + bw / 2, y: o.y + bw / 2, width: Math.max(0, o.w - bw), height: Math.max(0, o.h - bw), rx: 3, fill: 'none', stroke: color, 'stroke-width': bw }, g);
    const text = String(o.text ?? '').replace(/\n/g, ' ');
    const sub = String(o.subtext ?? '').replace(/\n/g, ' ');
    const L = stampLayout({ ...o, borderWidth: bw, subtext: sub }, textWidth1(text), sub ? textWidth1(sub) : 0, CAP_H);
    const line = (str, size, y) => { svgEl('text', { x: o.x + o.w / 2, y, 'text-anchor': 'middle', 'font-family': 'Helvetica, Arial, "Liberation Sans", sans-serif', 'font-weight': 'bold', 'font-size': size, fill: color }, g).textContent = str; };
    line(text, L.size, L.base);
    if (sub) line(sub, L.subSize, L.subBase);
    return g;
  },
  handles: (o) => boxHandles(o),
  resize: (o, handle, dx, dy) => resizeBox(o, handle, dx, dy),
  style: (o, s, keys) => (keys.includes('color') ? { color: s.color } : {}),
};

const urls = new WeakMap(); // bytes -> object URL
function urlOf(o) {
  let u = urls.get(o.bytes);
  if (!u) { u = URL.createObjectURL(new Blob([o.bytes], { type: o.mime })); urls.set(o.bytes, u); }
  return u;
}
const imageType = {
  ...boxCommon,
  render(o, parent) {
    const g = svgEl('g', { class: 'ann-image', transform: rotAttr(o), opacity: Number.isFinite(o.opacity) ? o.opacity : null }, parent);
    svgEl('image', { href: urlOf(o), x: o.x, y: o.y, width: o.w, height: o.h, preserveAspectRatio: 'none' }, g);
    return g;
  },
  handles: (o) => boxHandles(o, ['nw', 'ne', 'se', 'sw']),
  /** Corner drag keeps the aspect ratio about the opposite corner; Shift resizes freely. */
  resize(o, handle, dx, dy) {
    const nb = resizeBox(o, handle, dx, dy);
    if (shiftHeld || !o.w || !o.h) return nb;
    const s = Math.max(nb.w / o.w, nb.h / o.h, 1 / Math.min(o.w, o.h));
    const w = o.w * s, hh = o.h * s;
    const fx = handle.includes('w') ? o.x + o.w : o.x, fy = handle.includes('n') ? o.y + o.h : o.y;
    return { x: handle.includes('w') ? fx - w : fx, y: handle.includes('n') ? fy - hh : fy, w, h: hh };
  },
  style: (o, s, keys) => (keys.includes('opacity') ? { opacity: s.opacity } : {}),
};

// ---------------------------------------------------------------- stamp tool
function stampObjects(box, page, subtext = '') {
  const base = { type: 'stamp', page, color: opt.color, rotation: opt.rotation, borderWidth: opt.stamp.borderWidth ?? STAMP_BORDER };
  const list = [{ ...base, ...box, text: opt.text, ...(subtext ? { subtext } : {}) }];
  if (opt.addDate) {
    const text = `DATE: ${today()}`;
    const d = stampSize(text, STAMP_FONT_PT * 0.7);
    const w = Math.min(Math.max(d.w, box.w * 0.6), Math.max(box.w, d.w));
    list.push({ ...base, text, x: box.x + (box.w - w) / 2, y: box.y + box.h + 3, w, h: d.h });
  }
  return list;
}
function addObjects(tab, list) {
  let ids = [];
  annotations.batch(tab, () => { ids = list.map((o) => annotations.add(tab, o).id); });
  annotations.select(tab, ids);
  return ids;
}
function stampCreator() {
  let g = null;
  const box = (e) => {
    const p = annotations.toPage(g.tab, g.page, e.clientX, e.clientY);
    return { x: Math.min(g.start.x, p.x), y: Math.min(g.start.y, p.y), w: Math.abs(p.x - g.start.x), h: Math.abs(p.y - g.start.y) };
  };
  return {
    onPointerDown(e, { tab, hit }) {
      if (e.button !== 0 || !hit || tab.readOnly) return;
      e.preventDefault();
      try { e.target.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
      if (annotations.getSelection(tab).length) annotations.select(tab, []);
      g = { tab, page: hit.pageIndex, start: annotations.toPage(tab, hit.pageIndex, e.clientX, e.clientY) };
    },
    onPointerMove(e, { tab }) {
      if (!g || g.tab !== tab) return;
      annotations.renderPreview(tab, g.page, { ...stampObjects(box(e), g.page)[0] });
    },
    async onPointerUp(e, { tab }) {
      if (!g || g.tab !== tab) return;
      let b = box(e);
      const { page, start } = g;
      g = null;
      annotations.renderPreview(tab, page, null);
      const sub = opt.stamp.dynamic ? stampSubtext(new Date(), { ...opt.dyn, author: await getAuthor() }) : '';
      const scale = viewer.scale(tab);
      if (Math.max(b.w, b.h) * scale < MIN_PX || Math.min(b.w, b.h) <= 0) { // click: default size centred on the pointer
        const s = stampSize(opt.text, STAMP_FONT_PT, sub), P = pageBox(tab, page);
        b = { x: Math.min(Math.max(0, start.x - s.w / 2), Math.max(0, P.width - s.w)), y: Math.min(Math.max(0, start.y - s.h / 2), Math.max(0, P.height - s.h)), ...s };
      }
      addObjects(tab, stampObjects(b, page, sub));
    },
    cancel(tab) { if (g) { annotations.renderPreview(g.tab, g.page, null); g = null; } else if (tab) annotations.renderPreview(tab, 0, null); },
  };
}
function patchSelected(type, patch) {
  const tab = activeTab();
  if (!tab) return;
  const ids = annotations.getSelection(tab).filter((id) => annotations.getObject(tab, id)?.type === type);
  if (!ids.length) return;
  annotations.batch(tab, () => { for (const id of ids) annotations.update(tab, id, patch); });
}
// ---------------------------------------------------------------- stamp palette + custom stamps (library kind 'stamp')
const allStamps = () => [...STANDARD_STAMPS, ...DYNAMIC_STAMPS, ...custom];
async function loadCustom() {
  const list = await window.api.libraryList(LIB).catch(() => []);
  custom = list.map(({ id, meta }) => ({ ...meta, id, custom: true })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}
function useStamp(s) {
  opt.stamp = s; opt.text = s.text; opt.color = s.color;
  window.api.settingsSet(LAST_KEY, s.id).catch(() => {});
  bus.emit('stamp:changed', { id: s.id });
}
function preview(s) {
  const sub = s.dynamic ? 'by Name · Date' : '';
  const z = stampSize(s.text, STAMP_FONT_PT, sub);
  const svg = svgEl('svg', { class: 'stamp-preview', viewBox: `0 0 ${z.w} ${z.h}`, 'aria-hidden': 'true' });
  stampType.render({ x: 0, y: 0, ...z, text: s.text, subtext: sub, color: s.color, borderWidth: s.borderWidth ?? STAMP_BORDER }, svg);
  return svg;
}
async function createStampDialog(item) {
  const text = h('input.input#stamp-new-text', { type: 'text', maxlength: '60', value: item?.text ?? '', 'aria-label': 'Stamp text' });
  const colour = h('select.input.stamp-new-colour', { 'aria-label': 'Colour' }, ...COLOURS.map(([hex, n]) => h('option', { value: hex, selected: hex === (item?.color ?? COLOURS[0][0]) }, n)));
  const border = h('input.stamp-new-border', { type: 'checkbox', checked: item ? item.borderWidth > 0 : true });
  const v = await app.showDialog({
    title: item ? 'Rename stamp' : 'Create stamp',
    body: h('div.pt-form', {}, h('label.field', {}, h('span', {}, 'Text (one line)'), text), h('label.field', {}, h('span', {}, 'Colour'), colour), h('label.opt', {}, border, h('span', {}, 'Border'))),
    buttons: [{ label: 'Cancel', value: 'cancel', cancel: true }, { label: item ? 'Save' : 'Create', value: 'ok', primary: true, validate: () => !!text.value.trim() }],
    initialFocus: '#stamp-new-text',
  });
  if (v !== 'ok') return null;
  const t = text.value.trim().replace(/\s+/g, ' ').toUpperCase();
  const meta = { name: t, text: t, color: colour.value, borderWidth: border.checked ? STAMP_BORDER : 0, order: item?.order ?? custom.length };
  const id = item?.id ?? `st${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await window.api.libraryPut(LIB, id, item ? { meta } : { meta, bytes: Uint8Array.of(0) });
  await loadCustom();
  return custom.find((c) => c.id === id) ?? null;
}
let palette = null;
function closePalette() { palette?.remove(); palette = null; document.removeEventListener('pointerdown', outside, true); }
function outside(e) { if (palette && !palette.contains(e.target) && !e.target.closest?.('.opt-stamp-pick')) closePalette(); }
async function openPalette(anchor, cat = opt.stamp.custom ? 'custom' : opt.stamp.dynamic ? 'dynamic' : 'standard') {
  closePalette();
  await loadCustom();
  const grid = h('div.stamp-grid', { role: 'listbox', 'aria-label': 'Stamps' });
  const tabs = h('div.stamp-cats', { role: 'tablist' }, ...[['standard', 'Standard'], ['dynamic', 'Dynamic'], ['custom', 'Custom']].map(([c, l]) =>
    h('button.btn.stamp-cat', { type: 'button', role: 'tab', 'aria-selected': String(c === cat), dataset: { cat: c }, onclick: () => openPalette(anchor, c) }, l)));
  const pick = (s) => h('button.stamp-item', { type: 'button', role: 'option', title: s.text, 'aria-selected': String(s.id === opt.stamp.id), dataset: { id: s.id },
    onclick: () => { useStamp(s); closePalette(); } }, preview(s), h('span.stamp-label', {}, s.name ?? s.text));
  const list = cat === 'standard' ? STANDARD_STAMPS : cat === 'dynamic' ? DYNAMIC_STAMPS : custom;
  for (const s of list) {
    if (!s.custom) { grid.append(pick(s)); continue; }
    grid.append(h('div.stamp-custom', {}, pick(s),
      h('button.pt-icon-btn.stamp-rename', { type: 'button', title: 'Rename', 'aria-label': `Rename ${s.text}`, onclick: async () => { const r = await createStampDialog(s); if (r && opt.stamp.id === r.id) useStamp(r); openPalette(anchor, 'custom'); } }, '✎'),
      h('button.pt-icon-btn.stamp-delete', { type: 'button', title: 'Delete', 'aria-label': `Delete ${s.text}`, onclick: async () => { await window.api.libraryDelete(LIB, s.id); if (opt.stamp.id === s.id) useStamp(STANDARD_STAMPS[0]); openPalette(anchor, 'custom'); } }, '×')));
  }
  const extra = [];
  if (cat === 'dynamic') {
    const d = opt.dyn, save = () => window.api.settingsSet(DYN_KEY, { ...d }).catch(() => {});
    const chk = (k, label) => h('label.opt', {}, h(`input.stamp-dyn-${k}`, { type: 'checkbox', checked: d[`show${label}`], onchange: (e) => { d[`show${label}`] = e.target.checked; save(); } }), h('span', {}, label));
    extra.push(h('div.stamp-dyn', {},
      h('label.opt', {}, h('span', {}, 'Date format'), h('select.stamp-dyn-format', { onchange: (e) => { d.dateFormat = e.target.value; save(); } }, ...DATE_FORMATS.map((f) => h('option', { value: f, selected: f === d.dateFormat }, f)))),
      chk('author', 'Author'), chk('date', 'Date'), chk('time', 'Time'),
      h('span.opt-hint', {}, 'Author: Edit > Author name…')));
  }
  if (cat === 'custom') {
    if (!custom.length) grid.append(h('p.opt-hint', {}, 'No custom stamps yet.'));
    extra.push(h('button.btn.stamp-create', { type: 'button', onclick: async () => { const s = await createStampDialog(); if (s) useStamp(s); openPalette(anchor, 'custom'); } }, 'Create stamp…'));
  }
  palette = h('div.stamp-palette', { role: 'dialog', 'aria-label': 'Stamp palette', onkeydown: (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePalette(); anchor.focus(); } } }, tabs, grid, ...extra);
  anchor.parentElement.append(palette);
  document.addEventListener('pointerdown', outside, true);
}
function stampOptions(c) {
  const btn = h('button.btn.opt-stamp-pick', { type: 'button', 'aria-haspopup': 'dialog', title: 'Choose a stamp', onclick: () => (palette ? closePalette() : openPalette(btn)) });
  const show = () => { btn.replaceChildren(preview(opt.stamp), h('span.stamp-label', {}, opt.stamp.name ?? opt.stamp.text), h('span', { 'aria-hidden': 'true' }, '▾')); };
  show();
  const off = bus.on('stamp:changed', () => { if (!btn.isConnected) { off?.(); return; } show(); for (const b of sw.children) b.setAttribute('aria-pressed', String(b.dataset.color === opt.color)); });
  const sw = h('div.opt-seg.opt-stamp-colours', { role: 'group', 'aria-label': 'Stamp colour' });
  for (const [hex, name] of COLOURS) {
    sw.append(h('button.tb-btn.opt-swatch', {
      type: 'button', title: name, 'aria-label': name, 'aria-pressed': String(opt.color === hex), dataset: { color: hex }, style: `--swatch:${hex}`,
      onclick: () => { opt.color = hex; for (const b of sw.children) b.setAttribute('aria-pressed', String(b.dataset.color === hex)); patchSelected('stamp', { color: hex }); },
    }));
  }
  const rot = h('input.opt-stamp-rotation', { type: 'range', min: '-45', max: '45', step: '1', value: String(opt.rotation), oninput: (e) => { opt.rotation = Number(e.target.value); patchSelected('stamp', { rotation: opt.rotation }); } });
  const date = h('input.opt-stamp-date', { type: 'checkbox', checked: opt.addDate, onchange: (e) => { opt.addDate = e.target.checked; } });
  c.append(h('span.opt.stamp-pick-wrap', {}, h('span', {}, 'Stamp'), btn), sw, h('label.opt', {}, h('span', {}, 'Rotation'), rot), h('label.opt', {}, date, h('span', {}, 'Add date')));
}

// ---------------------------------------------------------------- image tool
/** MIME from the file signature (PNG / JPEG magic bytes), else null. */
export function sniffImage(b) {
  if (b?.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b?.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  return null;
}
/**
 * Arm the image tool with `bytes`; the next click on a page places it. `width` (points) overrides
 * the default width fraction; `extra` fields are copied onto the image object; `companions(img)`
 * returns further objects added in the SAME undo step (e.g. a signature block's name and date);
 * `onPlaced(img)` runs afterwards.
 */
export function armImage(bytes, { frac = IMAGE_FRAC, label = 'image', width, extra, companions, onPlaced } = {}) {
  return arm(bytes, frac, label, { width, extra, companions, onPlaced });
}
async function arm(bytes, frac, label, more = {}) {
  const mime = sniffImage(bytes);
  if (!mime) { app.toast('Only PNG and JPEG images can be placed'); return false; }
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const img = new Image();
  img.src = url;
  try { await img.decode(); } catch { URL.revokeObjectURL(url); app.toast('The image could not be read'); return false; }
  if (pending?.url) URL.revokeObjectURL(pending.url);
  pending = { bytes, mime, url, nw: img.naturalWidth || 1, nh: img.naturalHeight || 1, frac, ...more };
  setTool('image');
  document.body.classList.add('img-armed');
  app.toast(`Click on a page to place the ${label}`);
  return true;
}
async function pickImage() {
  const files = await window.api.openFiles({ filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }] });
  const f = files?.[0];
  if (f) await arm(f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes), IMAGE_FRAC, 'image');
}
function disarm() {
  if (pending?.url) URL.revokeObjectURL(pending.url);
  pending = null;
  document.body.classList.remove('img-armed');
}
const imageTool = {
  onActivate() { if (!pending && activeTab()) pickImage(); },
  onDeactivate() { disarm(); },
  onPointerDown(e, { tab, hit }) {
    if (e.button !== 0 || !hit || tab.readOnly || !pending) return;
    e.preventDefault();
    const P = pageBox(tab, hit.pageIndex), p = annotations.toPage(tab, hit.pageIndex, e.clientX, e.clientY);
    let w = Math.min(pending.width ?? P.width * pending.frac, P.width), hh = (w * pending.nh) / pending.nw;
    if (hh > P.height) { w *= P.height / hh; hh = P.height; }
    const x = Math.min(Math.max(0, p.x - w / 2), P.width - w), y = Math.min(Math.max(0, p.y - hh / 2), P.height - hh);
    const { bytes, mime, extra, companions, onPlaced } = pending;
    disarm();
    const img = { ...extra, type: 'image', page: hit.pageIndex, x, y, w, h: hh, bytes, mime, opacity: opt.imgOpacity, rotation: opt.imgRotation };
    const [id] = addObjects(tab, [img, ...(companions?.(img, P) ?? [])]);
    setTool('select');
    onPlaced?.(annotations.getObject(tab, id));
  },
};
function imageOptions(c) {
  c.append(
    h('button.btn.opt-image-pick', { type: 'button', onclick: () => pickImage() }, 'Choose image…'),
    h('label.opt', {}, h('span', {}, 'Opacity'), h('input.opt-image-opacity', { type: 'range', min: '0.1', max: '1', step: '0.05', value: String(opt.imgOpacity), oninput: (e) => { opt.imgOpacity = Number(e.target.value); patchSelected('image', { opacity: opt.imgOpacity }); } })),
    h('label.opt', {}, h('span', {}, 'Rotation'), h('input.opt-image-rotation', { type: 'range', min: '-180', max: '180', step: '1', value: String(opt.imgRotation), oninput: (e) => { opt.imgRotation = Number(e.target.value); patchSelected('image', { rotation: opt.imgRotation }); } })),
    h('span.opt-hint', {}, 'Click a page to place. Shift + corner drag resizes freely.'),
  );
}

// ---------------------------------------------------------------- init
const STAMP_ICON = '<svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3" y="7" width="18" height="10" rx="1.5"/><path d="M7 12h10"/></svg>';
export function initStampTools(a) {
  app = a;
  annotations.registerObjectType('stamp', stampType);
  annotations.registerObjectType('image', imageType);
  const c = stampCreator();
  Promise.all([window.api.settingsGet(LAST_KEY).catch(() => null), window.api.settingsGet(DYN_KEY).catch(() => null), loadCustom()]).then(([last, dyn]) => {
    if (dyn && typeof dyn === 'object') Object.assign(opt.dyn, dyn);
    const s = allStamps().find((x) => x.id === last);
    if (s) { opt.stamp = s; opt.text = s.text; opt.color = s.color; bus.emit('stamp:changed', { id: s.id }); }
  });
  registerTool({ id: 'stamp', label: 'Stamp', icon: STAMP_ICON, shortcut: 'S', cursor: 'crosshair', options: [stampOptions], onPointerDown: c.onPointerDown, onPointerMove: c.onPointerMove, onPointerUp: c.onPointerUp, onDeactivate: () => { closePalette(); c.cancel(activeTab()); } });
  registerTool({ id: 'image', label: 'Image (PNG, JPEG)', icon: 'image', shortcut: 'I', cursor: 'copy', options: [imageOptions], ...imageTool });
  app.registerMenuItem('Tools', { separator: true });
  app.registerMenuItem('Tools', { id: 'stamp', label: 'Stamp', shortcut: 'S', action: () => setTool('stamp') });
  app.registerMenuItem('Tools', { id: 'image', label: 'Insert image…', shortcut: 'I', action: () => (state.tool === 'image' ? pickImage() : setTool('image')), enabled: () => !!activeTab() });
  const track = (e) => { shiftHeld = e.shiftKey; };
  for (const t of ['pointermove', 'pointerdown', 'keydown', 'keyup']) document.addEventListener(t, track, true);
  bus.on('tool:changed', ({ tool }) => document.body.classList.toggle('ann-drawing', tool === 'stamp' || tool === 'image' || document.body.classList.contains('ann-drawing')));
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || dialogOpen() || isTyping(e.target) || !activeTab()) return;
    const tool = { s: 'stamp', i: 'image' }[e.key.toLowerCase()];
    if (tool) { e.preventDefault(); setTool(tool); }
  });
}
