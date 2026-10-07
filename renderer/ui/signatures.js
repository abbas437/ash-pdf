// Signature library manager (Tools > Manage signatures…). Items live in the main-process
// library (api.library*, kind 'signature'): bytes are a transparent PNG cropped to the ink, or
// that PNG encrypted with a password (meta.lock, see src/core/siglib.js). Meta:
//   {name, kind: 'signature'|'initials', isDefault, order, lock?}
// The listing comes back in readdir order, so `order` is kept dense (0..n-1) and sorted on.
// Also owns the drawing pad (createPad / cropToInk), shared with the old Draw signature dialog.
// Exports `signatureLibrary` {list, getPng, onChange} for placement code.
import { h } from './dom.js';
import { showDialog, toast } from './dialogs.js';
import { encryptBytes, decryptBytes, removeBackground, WrongPasswordError } from '../../src/core/siglib.js';

const KIND = 'signature';
const FONTS = ['Sig Dancing Script', 'Sig Great Vibes', 'Sig Caveat', 'Sig Sacramento'];
const COLOURS = [['#111111', 'Black'], ['#1a2b6d', 'Blue']];
const PENS = [['#1a2b6d', 'Dark blue'], ['#111111', 'Black']];
const KINDS = [['signature', 'Signature'], ['initials', 'Initials']];
const MAX_SIDE = 1200;        // imported / pasted images are scaled down to this
const NOTE = 'A visual signature is an image of your handwriting or name. It is not a digital certificate: it does not prove who signed or protect the document from changes.';

const api = () => window.api;
const unlocked = new Map();   // id -> PNG bytes of password-locked items opened this session
const listeners = new Set();
const changed = () => { for (const cb of listeners) { try { cb(); } catch (err) { console.error(err); } } };
const newId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// ---------------------------------------------------------------- pad (shared)
/** Drawing pad: {canvas, ctx, clear(), setPen(colour)}. ctx draws in CSS pixels (W x H). */
export function createPad({ W = 480, H = 160, R = 2, pen = PENS[0][0] } = {}) {
  const canvas = h('canvas.sig-pad', { width: String(W * R), height: String(H * R), 'aria-label': 'Signature pad: draw with the mouse, pen or finger. Keyboard users can type their name instead.' });
  canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
  const ctx = canvas.getContext('2d');
  let stroke = null;
  const setup = () => { ctx.setTransform(R, 0, 0, R, 0, 0); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = 3.5; ctx.strokeStyle = pen; ctx.fillStyle = pen; };
  const clear = () => { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); setup(); };
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
  return { canvas, ctx, clear, setPen: (c) => { pen = c; setup(); } };
}

/** Canvas cropped to the ink (alpha > 8) plus 4 px, optionally recoloured black; null when empty. */
function inkCanvas(src, { bw = false } = {}) {
  const { width: W, height: H } = src;
  const img = src.getContext('2d').getImageData(0, 0, W, H), d = img.data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  if (bw) for (let k = 0; k < d.length; k += 4) { d[k] = 0; d[k + 1] = 0; d[k + 2] = 0; }
  const P = 4;
  x0 = Math.max(0, x0 - P); y0 = Math.max(0, y0 - P); x1 = Math.min(W - 1, x1 + P); y1 = Math.min(H - 1, y1 + P);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  out.getContext('2d').putImageData(img, -x0, -y0, x0, y0, out.width, out.height);
  return out;
}
/** Transparent PNG data URL of the canvas cropped to the ink bounds plus 4 px; null when empty. */
export function cropToInk(canvas) { return inkCanvas(canvas)?.toDataURL('image/png') ?? null; }

const pngBytes = (canvas) => new Promise((resolve, reject) => canvas.toBlob(async (b) => (b ? resolve(new Uint8Array(await b.arrayBuffer())) : reject(new Error('PNG encoding failed'))), 'image/png'));
function dataUrlBytes(url) {
  const bin = atob(url.slice(url.indexOf(',') + 1));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// ---------------------------------------------------------------- library
async function items() {
  const all = await api().libraryList(KIND);
  return all.map(({ id, meta }) => ({ id, meta })).sort((a, b) => (a.meta.order ?? 0) - (b.meta.order ?? 0));
}
const putMeta = (id, meta) => api().libraryPut(KIND, id, { meta });
/** Rewrite `order` as 0..n-1 in the given sequence (only items whose order changes are written). */
async function renumber(list) {
  for (const [k, it] of list.entries()) if (it.meta.order !== k) { it.meta.order = k; await putMeta(it.id, it.meta); }
}
async function addItem({ name, kind, bytes, isDefault = false }) {
  const list = await items();
  const id = newId();
  if (isDefault) for (const it of list) if (it.meta.isDefault && it.meta.kind === kind) { it.meta.isDefault = false; await putMeta(it.id, it.meta); }
  const noDefault = !list.some((it) => it.meta.isDefault && it.meta.kind === kind);
  await api().libraryPut(KIND, id, { meta: { name, kind, isDefault: isDefault || noDefault, order: list.length }, bytes });
  changed();
  return id;
}

/** Ask for the password of a locked item until it decrypts; resolves to PNG bytes or null. */
async function unlockDialog(item) {
  const input = h('input.input', { type: 'password', autocomplete: 'off', 'aria-label': 'Password' });
  const status = h('p.sig-status', { role: 'status' });
  let png = null;
  const v = await showDialog({
    title: 'Signature is locked',
    body: h('div.sigman-pw', {}, h('p', {}, `Enter the password for "${item.meta.name}".`), h('label.field', {}, h('span', {}, 'Password'), input), status),
    className: 'sigman-pw-wrap',
    buttons: [{ label: 'Cancel', value: 'cancel', cancel: true }, {
      label: 'Unlock', value: 'ok', primary: true,
      validate: async () => {
        try { png = await decryptBytes(item.meta.lock, item.bytes, input.value); return true; } catch (err) {
          if (!(err instanceof WrongPasswordError)) throw err;
          status.textContent = 'Incorrect password. Try again.'; input.select(); return false;
        }
      },
    }],
  });
  return v === 'ok' ? png : null;
}

export const signatureLibrary = {
  /** [{id, name, kind, isDefault, order, locked}] in display order. */
  async list() {
    return (await items()).map(({ id, meta }) => ({ id, name: meta.name, kind: meta.kind ?? 'signature', isDefault: !!meta.isDefault, order: meta.order, locked: !!meta.lock }));
  },
  /** PNG bytes of an item; asks for the password when it is locked (null if cancelled or missing). */
  async getPng(id) {
    if (unlocked.has(id)) return unlocked.get(id).slice();
    const item = await api().libraryGet(KIND, id);
    if (!item) return null;
    if (!item.meta.lock) return item.bytes;
    const png = await unlockDialog(item);
    if (png) unlocked.set(id, png);
    return png ? png.slice() : null;
  },
  /** cb() after every change to the library; returns an unsubscribe function. */
  onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
};

// ---------------------------------------------------------------- create dialog
async function loadImage(bytes) {
  const url = URL.createObjectURL(new Blob([bytes]));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const s = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * s)); c.height = Math.max(1, Math.round(img.naturalHeight * s));
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return ctx.getImageData(0, 0, c.width, c.height);
  } finally { URL.revokeObjectURL(url); }
}
const imageFromPaste = (e) => [...(e.clipboardData?.items ?? [])].find((it) => it.kind === 'file' && /^image\/(png|jpeg)$/.test(it.type))?.getAsFile() ?? null;

/** Create a new item: mode 'draw' | 'type' | 'import' | 'paste'; `pasted` = File for paste mode. */
async function createDialog(mode, pasted) {
  const status = h('p.sig-status', { role: 'status' });
  const say = (t) => { status.textContent = t; };
  const nameIn = h('input.input.sigman-new-name', { type: 'text', maxlength: '60', 'aria-label': 'Name' });
  const kindSel = h('select.input.sigman-new-kind', { 'aria-label': 'Kind' }, KINDS.map(([v, l]) => h('option', { value: v }, l)));
  const bwBox = h('input.sigman-bw', { type: 'checkbox' });

  // Draw
  const pad = createPad();
  const penSel = h('select.input.sigman-pen', { 'aria-label': 'Pen colour', onchange: (e) => pad.setPen(e.target.value) }, PENS.map(([v, l]) => h('option', { value: v }, l)));
  const drawPane = h('div.sigman-pane', { dataset: { pane: 'draw' } }, pad.canvas,
    h('div.row', {}, h('label.opt', {}, h('span', {}, 'Pen'), penSel), h('button.btn.sigman-clear', { type: 'button', onclick: () => pad.clear() }, 'Clear')));

  // Type
  const typeCanvas = h('canvas.sigman-type-preview', { width: '1200', height: '300', 'aria-label': 'Typed signature preview' });
  const typedIn = h('input.input.sigman-typed', { type: 'text', maxlength: '60', 'aria-label': 'Your name' });
  const fontSel = h('select.input.sigman-font', { 'aria-label': 'Font' }, FONTS.map((f) => h('option', { value: f, style: { fontFamily: `"${f}"` } }, f.replace(/^Sig /, ''))));
  const colourSel = h('select.input.sigman-colour', { 'aria-label': 'Colour' }, [...COLOURS, ['custom', 'Custom…']].map(([v, l]) => h('option', { value: v }, l)));
  const customIn = h('input.sigman-custom', { type: 'color', value: '#7a1f1f', 'aria-label': 'Custom colour', hidden: true });
  let typeSeq = 0;
  const renderTyped = async () => {
    const seq = ++typeSeq, font = fontSel.value, text = typedIn.value.trim();
    await document.fonts.load(`120px "${font}"`, text || 'A');
    if (seq !== typeSeq) return;
    const ctx = typeCanvas.getContext('2d'), W = typeCanvas.width, H = typeCanvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!text) return;
    let size = 150;
    ctx.font = `${size}px "${font}"`;
    while (size > 24 && ctx.measureText(text).width > W - 60) { size -= 6; ctx.font = `${size}px "${font}"`; }
    ctx.fillStyle = colourSel.value === 'custom' ? customIn.value : colourSel.value;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, W / 2, H / 2);
  };
  typedIn.addEventListener('input', () => { if (!nameIn.dataset.edited) nameIn.value = typedIn.value.trim(); renderTyped(); });
  fontSel.addEventListener('change', renderTyped);
  colourSel.addEventListener('change', () => { customIn.hidden = colourSel.value !== 'custom'; renderTyped(); });
  customIn.addEventListener('input', renderTyped);
  const typePane = h('div.sigman-pane', { dataset: { pane: 'type' } },
    h('label.field', {}, h('span', {}, 'Your name'), typedIn),
    h('div.row', {}, h('label.opt', {}, h('span', {}, 'Font'), fontSel), h('label.opt', {}, h('span', {}, 'Colour'), colourSel, customIn)),
    h('div.sigman-paper', {}, typeCanvas));

  // Import / paste (shared: background removal with a live preview)
  let source = null;                     // original ImageData
  const imgCanvas = h('canvas.sigman-img-preview', { width: '1', height: '1', 'aria-label': 'Image preview with the background removed' });
  const thrIn = h('input.sigman-threshold', { type: 'range', min: '120', max: '250', step: '1', value: '200', 'aria-label': 'Background threshold' });
  const thrOut = h('output.sigman-thr-val', {}, '200');
  const renderImage = () => {
    thrOut.textContent = thrIn.value;
    if (!source) return;
    const copy = new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);
    removeBackground(copy.data, copy.width, copy.height, Number(thrIn.value));
    imgCanvas.width = copy.width; imgCanvas.height = copy.height;
    imgCanvas.getContext('2d').putImageData(copy, 0, 0);
  };
  thrIn.addEventListener('input', renderImage);
  const useImage = async (bytes) => {
    try { source = await loadImage(bytes); } catch { say('The image could not be read: use a PNG or JPEG file.'); return; }
    say(''); renderImage();
    imagePane.classList.add('has-image');
  };
  const pickBtn = h('button.btn.sigman-pick', { type: 'button', onclick: async () => {
    const f = (await api().openFiles({ filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }] }))?.[0];
    if (f) await useImage(f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes));
  } }, 'Choose image…');
  const pasteHint = h('p.sigman-hint', {}, 'Press Ctrl+V to paste an image (PNG or JPEG) copied from another program.');
  const imagePane = h('div.sigman-pane', { dataset: { pane: 'image' } },
    h('div.row', {}, pickBtn, pasteHint),
    h('div.sigman-paper.sigman-checker', {}, imgCanvas),
    h('label.opt', {}, h('span', {}, 'Remove background lighter than'), thrIn, thrOut));

  // Mode tabs
  const MODES = [['draw', 'Draw'], ['type', 'Type'], ['import', 'Import'], ['paste', 'Paste']];
  const panes = { draw: drawPane, type: typePane, import: imagePane, paste: imagePane };
  const tabs = h('div.sigman-tabs', { role: 'tablist', 'aria-label': 'How to create' });
  const setMode = (m) => {
    mode = m;
    for (const b of tabs.children) b.setAttribute('aria-selected', String(b.dataset.mode === m));
    for (const p of new Set(Object.values(panes))) p.hidden = p !== panes[m];
    pickBtn.hidden = m !== 'import'; pasteHint.hidden = m !== 'paste';
    say('');
  };
  for (const [m, l] of MODES) tabs.append(h('button.sigman-tab', { type: 'button', role: 'tab', dataset: { mode: m }, onclick: () => setMode(m) }, l));
  nameIn.addEventListener('input', () => { nameIn.dataset.edited = '1'; });

  const body = h('div.sigman-create', {},
    tabs, drawPane, typePane, imagePane,
    h('div.sigman-grid', {},
      h('label.field', {}, h('span', {}, 'Name'), nameIn),
      h('label.field', {}, h('span', {}, 'Kind'), kindSel),
      h('label.opt.sigman-bw-label', {}, bwBox, h('span', {}, 'Black and white'))),
    h('p.sig-note', {}, NOTE),
    status);
  const onPaste = async (e) => {
    const file = imageFromPaste(e);
    if (!file) return;
    e.preventDefault();
    setMode('paste');
    await useImage(new Uint8Array(await file.arrayBuffer()));
  };
  setMode(mode);
  if (pasted) await useImage(new Uint8Array(await pasted.arrayBuffer()));

  let out = null;
  const v = await showDialog({
    title: 'New signature',
    body: (dlg) => { dlg.addEventListener('paste', onPaste); return body; },
    className: 'sigman-wrap',
    initialFocus: { draw: '.sigman-pen', type: '.sigman-typed', import: '.sigman-pick', paste: '.sigman-tab[aria-selected="true"]' }[mode],
    buttons: [{ label: 'Cancel', value: 'cancel', cancel: true }, {
      label: 'Add to library', value: 'save', primary: true,
      validate: async () => {
        const src = mode === 'draw' ? pad.canvas : mode === 'type' ? (await renderTyped(), typeCanvas) : source ? imgCanvas : null;
        const ink = src && inkCanvas(src, { bw: bwBox.checked });
        if (!ink) { say(mode === 'draw' ? 'The pad is empty: draw a signature first.' : mode === 'type' ? 'Type your name first.' : 'Choose or paste an image with some ink on it first.'); return false; }
        out = { name: nameIn.value.trim() || (kindSel.value === 'initials' ? 'Initials' : 'Signature'), kind: kindSel.value, bytes: await pngBytes(ink) };
        return true;
      },
    }],
  });
  if (v !== 'save' || !out) return null;
  return addItem(out);
}

// ---------------------------------------------------------------- lock
async function lockItem(it) {
  const pw = h('input.input.sigman-pw1', { type: 'password', autocomplete: 'new-password', 'aria-label': 'Password' });
  const pw2 = h('input.input.sigman-pw2', { type: 'password', autocomplete: 'new-password', 'aria-label': 'Repeat password' });
  const status = h('p.sig-status', { role: 'status' });
  const v = await showDialog({
    title: `Lock "${it.meta.name}"`,
    body: h('div.sigman-pw', {},
      h('p', {}, 'The image is stored encrypted and asked for each time the app starts. There is no way to recover a forgotten password.'),
      h('label.field', {}, h('span', {}, 'Password'), pw), h('label.field', {}, h('span', {}, 'Repeat password'), pw2), status),
    className: 'sigman-pw-wrap',
    buttons: [{ label: 'Cancel', value: 'cancel', cancel: true }, {
      label: 'Lock', value: 'ok', primary: true,
      validate: () => {
        if (!pw.value) { status.textContent = 'Enter a password.'; pw.focus(); return false; }
        if (pw.value !== pw2.value) { status.textContent = 'The passwords do not match.'; pw2.select(); return false; }
        return true;
      },
    }],
  });
  if (v !== 'ok') return;
  const item = await api().libraryGet(KIND, it.id);
  const { lock, data } = await encryptBytes(item.bytes, pw.value);
  await api().libraryPut(KIND, it.id, { meta: { ...item.meta, lock }, bytes: data });
  unlocked.delete(it.id);
  changed();
}
async function unlockItem(it) {
  const png = await signatureLibrary.getPng(it.id);
  if (!png) return;
  const { lock, ...meta } = it.meta;
  await api().libraryPut(KIND, it.id, { meta, bytes: png });
  unlocked.delete(it.id);
  changed();
}

// ---------------------------------------------------------------- manager dialog
async function managerDialog() {
  const listEl = h('ul.sigman-list', { 'aria-label': 'Saved signatures' });
  const urls = [];
  const render = async () => {
    for (const u of urls.splice(0)) URL.revokeObjectURL(u);
    const list = await items();
    listEl.replaceChildren();
    if (!list.length) listEl.append(h('li.sigman-empty', {}, 'No saved signatures yet. Add one below.'));
    for (const [k, it] of list.entries()) {
      const m = it.meta;
      const plain = !m.lock ? (await api().libraryGet(KIND, it.id))?.bytes : unlocked.get(it.id);
      let preview;
      if (plain) { const u = URL.createObjectURL(new Blob([plain], { type: 'image/png' })); urls.push(u); preview = h('img', { src: u, alt: `Preview of ${m.name}` }); }
      else preview = h('span.sigman-locked', {}, 'Locked');
      const act = (fn) => async () => { try { await fn(); } catch (err) { toast(`Could not update the library: ${err.message}`); } await render(); };
      const save = (patch) => act(async () => { await putMeta(it.id, { ...m, ...patch }); changed(); });
      const nameIn = h('input.input.sigman-name', { type: 'text', maxlength: '60', value: m.name, 'aria-label': 'Name' });
      nameIn.addEventListener('change', () => { const n = nameIn.value.trim(); if (n && n !== m.name) save({ name: n })(); else nameIn.value = m.name; });
      const kindSel = h('select.input.sigman-kind', { 'aria-label': `Kind of ${m.name}` }, KINDS.map(([v, l]) => h('option', { value: v, selected: (m.kind ?? 'signature') === v }, l)));
      kindSel.addEventListener('change', () => save({ kind: kindSel.value, isDefault: false })());
      const move = (d) => act(async () => { const a = [...list]; [a[k], a[k + d]] = [a[k + d], a[k]]; await renumber(a); changed(); });
      listEl.append(h('li.sigman-item', { dataset: { id: it.id } },
        h('div.sigman-paper.sigman-thumb', {}, preview),
        h('div.sigman-fields', {}, nameIn, h('div.row', {}, kindSel,
          m.isDefault ? h('span.sigman-default', {}, `Default ${(m.kind ?? 'signature') === 'initials' ? 'initials' : 'signature'}`)
            : h('button.btn.sigman-set-default', { type: 'button', onclick: act(async () => {
              for (const o of list) if (o !== it && o.meta.isDefault && o.meta.kind === m.kind) await putMeta(o.id, { ...o.meta, isDefault: false });
              await putMeta(it.id, { ...m, isDefault: true }); changed();
            }) }, 'Set as default'))),
        h('div.sigman-actions', {},
          h('button.btn.sigman-up', { type: 'button', disabled: k === 0, 'aria-label': `Move ${m.name} up`, title: 'Move up', onclick: move(-1) }, '↑'),
          h('button.btn.sigman-down', { type: 'button', disabled: k === list.length - 1, 'aria-label': `Move ${m.name} down`, title: 'Move down', onclick: move(1) }, '↓'),
          m.lock ? h('button.btn.sigman-unlock', { type: 'button', onclick: act(() => unlockItem(it)) }, 'Remove password…')
            : h('button.btn.sigman-lock', { type: 'button', onclick: act(() => lockItem(it)) }, 'Lock…'),
          h('button.btn.danger.sigman-delete', { type: 'button', onclick: act(async () => {
            const ok = await showDialog({ title: 'Delete signature', body: `Delete "${m.name}" from the library? This cannot be undone.`, buttons: [{ label: 'Cancel', value: 'cancel', cancel: true }, { label: 'Delete', value: 'delete', danger: true, primary: true }] });
            if (ok !== 'delete') return;
            await api().libraryDelete(KIND, it.id);
            unlocked.delete(it.id);
            await renumber((await items()));
            changed();
          }) }, 'Delete'))));
    }
  };
  const add = (mode, file) => async () => { if (await createDialog(mode, file)) await render(); };
  const body = h('div.sigman', {},
    h('p.sig-note', {}, NOTE),
    listEl,
    h('div.sigman-add', {}, h('span', {}, 'Add new:'),
      h('button.btn.sigman-add-draw', { type: 'button', onclick: add('draw') }, 'Draw…'),
      h('button.btn.sigman-add-type', { type: 'button', onclick: add('type') }, 'Type…'),
      h('button.btn.sigman-add-import', { type: 'button', onclick: add('import') }, 'Import image…'),
      h('button.btn.sigman-add-paste', { type: 'button', onclick: add('paste') }, 'Paste…'),
      h('span.sigman-hint', {}, 'or press Ctrl+V here')));
  const onPaste = (e) => {
    const file = imageFromPaste(e);
    if (file) { e.preventDefault(); add('paste', file)(); }
  };
  await render();
  await showDialog({ title: 'Manage signatures', body: (dlg) => { dlg.addEventListener('paste', onPaste); return body; }, className: 'sigman-wrap', initialFocus: '.sigman-add-draw', buttons: [{ label: 'Close', value: 'close', primary: true, cancel: true }] });
  for (const u of urls) URL.revokeObjectURL(u);
}

// ---------------------------------------------------------------- init
/** Move the single signature of earlier versions (settings key 'signature', a PNG data URL) into the library. */
async function migrateOldSetting() {
  const url = await api().settingsGet('signature');
  if (typeof url !== 'string' || !url.startsWith('data:image/png')) return;
  await addItem({ name: 'My signature', kind: 'signature', bytes: dataUrlBytes(url), isDefault: true });
  await api().settingsSet('signature', undefined);
}

export function initSignatures(app) {
  app.registerMenuItem('Tools', { id: 'signature-manage', label: 'Manage signatures…', action: () => managerDialog() });
  return migrateOldSetting().catch((err) => console.warn('signature migration failed:', err));
}
