// Stamp, Image and Signature tools. Objects are the core's `stamp` and `image` overlay objects
// (src/core/annotate.js), stored through ui/annotations.js so undo, selection, the status-bar
// count and flatten-on-save all apply. Coordinates: visible page space in points.
//   Stamp (S): preset or custom text in an outlined box; click places a default-size stamp,
//              drag sets the box. "Add date" places a second stamp `DATE: YYYY-MM-DD` below it.
//   Image (I): pick a PNG/JPEG (type from the file signature), click a page to place it.
//   Signature: Tools > Draw signature… (pad or typed name) saved as a transparent PNG in the
//              settings; Tools > Place saved signature arms the image tool with it.
import { bus } from '../bus.js';
import { state, activeTab } from '../state.js';
import { h, isTyping } from './dom.js';
import { dialogOpen } from './dialogs.js';
import { registerTool, setTool } from './toolbar.js';
import { viewer } from './viewer.js';
import { annotations, resizeBox } from './annotations.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PRESETS = ['APPROVED', 'APPROVED AS NOTED', 'REVISE AND RESUBMIT', 'REJECTED', 'FOR INFORMATION', 'DRAFT', 'CONFIDENTIAL', 'VOID'];
const COLOURS = [['#1b7f3b', 'Green'], ['#d62828', 'Red'], ['#1d4ed8', 'Blue'], ['#d97706', 'Orange']];
const STAMP_FONT_PT = 14;
const STAMP_BORDER = 2;
const CAP_H = 0.718;          // Helvetica-Bold cap height per unit font size (as the core uses)
const MIN_PX = 3;             // smaller drags are clicks
const IMAGE_FRAC = 0.4;       // default image width, fraction of page width
const SIGN_FRAC = 0.25;       // default signature width
const PENS = [['#1a2b6d', 'Dark blue'], ['#111111', 'Black']];
const SIG_FONT = 'italic 52px "Segoe Script", "Lucida Handwriting", "Brush Script MT", "URW Chancery L", "Z003", cursive';

const opt = { text: 'APPROVED', color: '#1b7f3b', rotation: 0, addDate: false, imgOpacity: 1, imgRotation: 0 };
let pending = null;           // armed image: {bytes, mime, url, nw, nh, frac, width?, extra?, companions?, onPlaced?}
let hasSignature = false;
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
function stampSize(text, fontPt = STAMP_FONT_PT) {
  const pad = STAMP_BORDER + 4;
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
    const pad = bw + 4;
    const size = Math.max(1, Math.min((o.w - 2 * pad) / textWidth1(text), (o.h - 2 * pad) / CAP_H));
    const t = svgEl('text', { x: o.x + o.w / 2, y: o.y + o.h / 2 + (CAP_H * size) / 2, 'text-anchor': 'middle', 'font-family': 'Helvetica, Arial, "Liberation Sans", sans-serif', 'font-weight': 'bold', 'font-size': size, fill: color }, g);
    t.textContent = text;
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
function stampObjects(box, page) {
  const base = { type: 'stamp', page, color: opt.color, rotation: opt.rotation, borderWidth: STAMP_BORDER };
  const list = [{ ...base, ...box, text: opt.text }];
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
    onPointerUp(e, { tab }) {
      if (!g || g.tab !== tab) return;
      let b = box(e);
      const { page, start } = g;
      g = null;
      annotations.renderPreview(tab, page, null);
      const scale = viewer.scale(tab);
      if (Math.max(b.w, b.h) * scale < MIN_PX || Math.min(b.w, b.h) <= 0) { // click: default size centred on the pointer
        const s = stampSize(opt.text), P = pageBox(tab, page);
        b = { x: Math.min(Math.max(0, start.x - s.w / 2), Math.max(0, P.width - s.w)), y: Math.min(Math.max(0, start.y - s.h / 2), Math.max(0, P.height - s.h)), ...s };
      }
      addObjects(tab, stampObjects(b, page));
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
async function customText() {
  const input = h('input.input#stamp-custom', { type: 'text', maxlength: '60', value: PRESETS.includes(opt.text) ? '' : opt.text, 'aria-label': 'Stamp text' });
  const v = await app.showDialog({
    title: 'Custom stamp text',
    body: h('div', {}, h('label.field', {}, h('span', {}, 'Text (one line)'), input)),
    buttons: [{ label: 'Cancel', value: 'cancel', cancel: true }, { label: 'Use text', value: 'ok', primary: true, validate: () => !!input.value.trim() }],
    initialFocus: '#stamp-custom',
  });
  return v === 'ok' ? input.value.trim().replace(/\s+/g, ' ').toUpperCase() : null;
}
function stampOptions(c) {
  const sel = h('select.opt-stamp-text', { 'aria-label': 'Stamp text' });
  const fill = () => {
    const list = PRESETS.includes(opt.text) ? PRESETS : [...PRESETS, opt.text];
    sel.replaceChildren(...list.map((t) => h('option', { value: t, selected: t === opt.text }, t)), h('option', { value: '__custom' }, 'Custom text…'));
  };
  fill();
  sel.onchange = async () => {
    if (sel.value === '__custom') { const t = await customText(); if (t) opt.text = t; fill(); return; }
    opt.text = sel.value;
  };
  const sw = h('div.opt-seg.opt-stamp-colours', { role: 'group', 'aria-label': 'Stamp colour' });
  for (const [hex, name] of COLOURS) {
    sw.append(h('button.tb-btn.opt-swatch', {
      type: 'button', title: name, 'aria-label': name, 'aria-pressed': String(opt.color === hex), dataset: { color: hex }, style: `--swatch:${hex}`,
      onclick: () => { opt.color = hex; for (const b of sw.children) b.setAttribute('aria-pressed', String(b.dataset.color === hex)); patchSelected('stamp', { color: hex }); },
    }));
  }
  const rot = h('input.opt-stamp-rotation', { type: 'range', min: '-45', max: '45', step: '1', value: String(opt.rotation), oninput: (e) => { opt.rotation = Number(e.target.value); patchSelected('stamp', { rotation: opt.rotation }); } });
  const date = h('input.opt-stamp-date', { type: 'checkbox', checked: opt.addDate, onchange: (e) => { opt.addDate = e.target.checked; } });
  c.append(h('label.opt', {}, h('span', {}, 'Stamp'), sel), sw, h('label.opt', {}, h('span', {}, 'Rotation'), rot), h('label.opt', {}, date, h('span', {}, 'Add date')));
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

// ---------------------------------------------------------------- signature
function dataUrlBytes(url) {
  const bin = atob(url.slice(url.indexOf(',') + 1));
  const b = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) b[k] = bin.charCodeAt(k);
  return b;
}
/** Transparent PNG of the canvas cropped to the ink bounds plus 4 px; null when empty. */
function cropToInk(canvas) {
  const ctx = canvas.getContext('2d');
  const { width: W, height: H } = canvas;
  const d = ctx.getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const P = 4;
  x0 = Math.max(0, x0 - P); y0 = Math.max(0, y0 - P); x1 = Math.min(W - 1, x1 + P); y1 = Math.min(H - 1, y1 + P);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}
async function drawSignatureDialog() {
  const W = 480, H = 160, R = 2;
  const canvas = h('canvas.sig-pad', { width: String(W * R), height: String(H * R), 'aria-label': 'Signature pad: draw with the mouse, pen or finger. Keyboard users can type their name below instead.' });
  canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
  const ctx = canvas.getContext('2d');
  let pen = PENS[0][0], stroke = null;
  const status = h('p.sig-status', { role: 'status' });
  const setup = () => { ctx.setTransform(R, 0, 0, R, 0, 0); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = 3.5; ctx.strokeStyle = pen; ctx.fillStyle = pen; };
  const clear = () => { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); setup(); status.textContent = ''; };
  setup();
  const at = (e) => { const r = canvas.getBoundingClientRect(); return [((e.clientX - r.left) * W) / r.width, ((e.clientY - r.top) * H) / r.height]; };
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    stroke = [at(e)];
    ctx.beginPath(); ctx.arc(stroke[0][0], stroke[0][1], ctx.lineWidth / 2, 0, 2 * Math.PI); ctx.fill();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!stroke) return;
    const p = at(e), n = stroke.length, a = stroke[n - 1];
    if (Math.hypot(p[0] - a[0], p[1] - a[1]) < 1) return;
    stroke.push(p);
    // Smoothing: quadratic curve through the midpoints of successive samples.
    const prev = n > 1 ? stroke[n - 2] : a;
    ctx.beginPath();
    ctx.moveTo((prev[0] + a[0]) / 2, (prev[1] + a[1]) / 2);
    ctx.quadraticCurveTo(a[0], a[1], (a[0] + p[0]) / 2, (a[1] + p[1]) / 2);
    ctx.stroke();
  });
  const end = () => { stroke = null; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  const penSel = h('select.sig-pen', { 'aria-label': 'Pen colour', onchange: (e) => { pen = e.target.value; setup(); } }, PENS.map(([v, l]) => h('option', { value: v }, l)));
  const nameIn = h('input.input.sig-name', { type: 'text', maxlength: '60', 'aria-label': 'Type your name' });
  const typeBtn = h('button.btn.sig-type', { type: 'button', onclick: () => {
    const name = nameIn.value.trim();
    if (!name) { status.textContent = 'Type a name first.'; nameIn.focus(); return; }
    clear();
    ctx.font = SIG_FONT;
    let size = 52;
    while (size > 12 && ctx.measureText(name).width > W - 24) { size -= 2; ctx.font = SIG_FONT.replace('52px', `${size}px`); }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(name, W / 2, H / 2);
    status.textContent = 'Typed name rendered on the pad.';
  } }, 'Use typed name');
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); typeBtn.click(); } });
  const body = h('div.sig-dialog', {},
    h('p.sig-note', {}, 'This is a simple visual signature (an image of your handwriting or name). It is not a cryptographic digital signature and does not prove who signed or protect the document from changes.'),
    canvas,
    h('div.row.sig-row', {}, h('label.opt', {}, h('span', {}, 'Pen'), penSel), h('button.btn.sig-clear', { type: 'button', onclick: clear }, 'Clear')),
    h('label.field', {}, h('span', {}, 'Or type your name (keyboard alternative)'), h('div.row', {}, nameIn, typeBtn)),
    status);
  let dataUrl = null;
  const v = await app.showDialog({
    title: 'Draw signature',
    body,
    className: 'sig-dialog-wrap',
    initialFocus: '.sig-pen',
    buttons: [{ label: 'Cancel', value: 'cancel', cancel: true }, {
      label: 'Save signature', value: 'save', primary: true,
      validate: () => { dataUrl = cropToInk(canvas); if (!dataUrl) status.textContent = 'The pad is empty: draw or type a signature first.'; return !!dataUrl; },
    }],
  });
  if (v !== 'save' || !dataUrl) return;
  await window.api.settingsSet('signature', dataUrl);
  hasSignature = true;
  app.toast('Signature saved. Use Tools > Place saved signature to add it to a page.');
}
async function placeSavedSignature() {
  const url = await window.api.settingsGet('signature');
  if (typeof url !== 'string' || !url.startsWith('data:image/png')) { hasSignature = false; app.toast('No saved signature: use Tools > Draw signature… first'); return; }
  await arm(dataUrlBytes(url), SIGN_FRAC, 'signature');
}

// ---------------------------------------------------------------- init
const STAMP_ICON = '<svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3" y="7" width="18" height="10" rx="1.5"/><path d="M7 12h10"/></svg>';
export function initStampTools(a) {
  app = a;
  annotations.registerObjectType('stamp', stampType);
  annotations.registerObjectType('image', imageType);
  const c = stampCreator();
  registerTool({ id: 'stamp', label: 'Stamp', icon: STAMP_ICON, shortcut: 'S', cursor: 'crosshair', options: [stampOptions], onPointerDown: c.onPointerDown, onPointerMove: c.onPointerMove, onPointerUp: c.onPointerUp, onDeactivate: () => c.cancel(activeTab()) });
  registerTool({ id: 'image', label: 'Image (PNG, JPEG)', icon: 'image', shortcut: 'I', cursor: 'copy', options: [imageOptions], ...imageTool });
  app.registerMenuItem('Tools', { separator: true });
  app.registerMenuItem('Tools', { id: 'stamp', label: 'Stamp', shortcut: 'S', action: () => setTool('stamp') });
  app.registerMenuItem('Tools', { id: 'image', label: 'Insert image…', shortcut: 'I', action: () => (state.tool === 'image' ? pickImage() : setTool('image')), enabled: () => !!activeTab() });
  app.registerMenuItem('Tools', { id: 'signature-draw', label: 'Draw signature…', action: () => drawSignatureDialog() });
  app.registerMenuItem('Tools', { id: 'signature-place', label: 'Place saved signature', action: () => placeSavedSignature(), enabled: () => hasSignature && !!activeTab() });
  window.api.settingsGet('signature').then((v) => { hasSignature = typeof v === 'string' && v.startsWith('data:image/png'); }, () => {});
  const track = (e) => { shiftHeld = e.shiftKey; };
  for (const t of ['pointermove', 'pointerdown', 'keydown', 'keyup']) document.addEventListener(t, track, true);
  bus.on('tool:changed', ({ tool }) => document.body.classList.toggle('ann-drawing', tool === 'stamp' || tool === 'image' || document.body.classList.contains('ann-drawing')));
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || dialogOpen() || isTyping(e.target) || !activeTab()) return;
    const tool = { s: 'stamp', i: 'image' }[e.key.toLowerCase()];
    if (tool) { e.preventDefault(); setTool(tool); }
  });
}
