// Document marks: Header & Footer, Page Numbers, Watermark, Bates numbering and the Remove items
// (core: src/core/pagemarks.js). Each dialog previews the current page (the mark applied to a
// one-page copy, rendered with pdf.js), remembers its last settings, offers Replace when the
// document already carries that kind of mark, and applies with one runOp (one undo step).
import { bus } from '../bus.js';
import { activeTab } from '../state.js';
import { h } from './dom.js';
import { showDialog, toast } from './dialogs.js';
import { viewer } from './viewer.js';
import { runOp } from './pagetools.js';

const marks = () => import('../../src/core/pagemarks.js');
const ops = () => import('../../src/core/pdfOps.js');
const RO_TIP = 'Encrypted document: page editing is not supported';
const KIND_LABEL = { headerFooter: 'header & footer', watermark: 'watermark', background: 'background', bates: 'Bates numbers' };
const range = (n) => Array.from({ length: n }, (_, i) => i);
const identity = (n) => new Map(range(n).map((i) => [i, i]));
const editable = (tab) => !!tab && !tab.readOnly;
const present = new WeakMap(); // tab -> Set of mark kinds found by listMarks (drives Replace and Remove)

async function refreshMarks(tab) {
  if (!tab?.bytes) return;
  const bytes = tab.bytes;
  try {
    const list = await (await marks()).listMarks(bytes);
    if (tab.bytes === bytes) present.set(tab, new Set(list.map((m) => m.kind)));
  } catch { present.set(tab, new Set()); }
}
const has = (tab, kind) => !!present.get(tab)?.has(kind);

// ---------------------------------------------------------------- form helpers
let uid = 0;
const input = (attrs) => h('input.input', { type: 'text', id: `pm-${++uid}`, ...attrs });
const select = (id, opts, value) => h('select.input', { id }, opts.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
const field = (label, el, cls = '') => h(`label.field.pm-field${cls}`, {}, h('span', {}, label), el);
const FONTS = [['Helvetica', 'Helvetica'], ['Times', 'Times'], ['Courier', 'Courier']];
const NUM_FORMATS = [['1', '1, 2, 3'], ['i', 'i, ii, iii'], ['I', 'I, II, III'], ['a', 'a, b, c'], ['A', 'A, B, C']];
const num = (el, def) => { const x = Number(el.value); return el.value.trim() === '' || !Number.isFinite(x) ? def : x; };

/** "Pages" + "Odd/even" controls; resolve(n) → 0-based indices (throws on a bad range). */
function pagesControl(s) {
  const pages = input({ value: s.pages ?? '', placeholder: 'All pages', 'aria-label': 'Pages' });
  const subset = select(`pm-subset-${++uid}`, [['all', 'All'], ['odd', 'Odd pages'], ['even', 'Even pages']], s.subset ?? 'all');
  const el = h('div.pm-grid2', {}, field('Pages (e.g. 1-3,5)', pages), field('Apply to', subset));
  const resolve = async (n) => {
    const idx = pages.value.trim() ? (await ops()).parseRanges(pages.value, n) : range(n);
    return idx.filter((i) => subset.value === 'all' || (i % 2 === 0) === (subset.value === 'odd'));
  };
  return { el, resolve, save: () => ({ pages: pages.value, subset: subset.value }) };
}

function fontControls(s, defSize) {
  const font = select(`pm-font-${++uid}`, FONTS, s.font ?? 'Helvetica');
  const size = input({ type: 'number', min: '4', max: '200', value: String(s.fontSize ?? defSize), 'aria-label': 'Font size' });
  const color = h('input.input.pm-color', { type: 'color', id: `pm-color-${++uid}`, value: s.color ?? '#000000', 'aria-label': 'Colour' });
  return {
    el: h('div.pm-grid3', {}, field('Font', font), field('Size (pt)', size), field('Colour', color)),
    read: () => ({ font: font.value, fontSize: num(size, defSize), color: color.value }),
  };
}

const unsupported = (e) => e?.code === 'UNSUPPORTED_TEXT'
  ? `${e.message} Use Latin letters, digits and common symbols; Arabic and other scripts need fonts this version does not embed.`
  : null;

// ---------------------------------------------------------------- generic dialog
/**
 * def = {kind, title, settingsKey, build(saved) → {el, read() → state, opts(state, ctx) → core options},
 *        apply(core, bytes, opts) → {bytes, note?}}
 * ctx = {indices, n} for the whole document, or {indices, n, preview: k} for the preview copy.
 */
async function markDialog(def, tab = activeTab()) {
  if (!tab) return false;
  if (tab.readOnly) { toast(RO_TIP); return false; }
  const saved = (await window.api.settingsGet(def.settingsKey).catch(() => null)) ?? {};
  await refreshMarks(tab);
  const ui = def.build(saved);
  const pagesCtl = pagesControl(saved);
  const replace = h('input', { type: 'checkbox', id: 'pm-replace', checked: true });
  const replaceRow = has(tab, def.kind)
    ? h('div.pm-replace', {}, replace, h('label', { for: 'pm-replace' }, `Replace the existing ${KIND_LABEL[def.kind]} (otherwise the new one is added on top)`))
    : null;
  const err = h('p.pt-error.pm-error', { role: 'alert', hidden: true });
  const canvas = h('canvas.pm-canvas', { 'aria-label': `Preview of page ${tab.currentPage + 1}` });
  const status = h('small.pt-hint.pm-status', {}, `Page ${tab.currentPage + 1} of ${tab.numPages}`);
  const form = h('div.pt-form.pm-form', {}, ui.el, pagesCtl.el, replaceRow, err);
  const body = h('div.pm-layout', {}, form, h('div.pm-preview', {}, h('div.pm-canvas-wrap', {}, canvas), status));
  const setErr = (msg) => { err.textContent = msg ?? ''; err.hidden = !msg; return !msg; };

  const optsFor = async (n, preview) => {
    const indices = await pagesCtl.resolve(n);
    return ui.opts(ui.read(), { indices, n, preview });
  };
  let seq = 0, timer = null;
  const renderPreview = async () => {
    const my = ++seq;
    try {
      const c = await marks(), o = await ops();
      const k = tab.currentPage;
      let bytes = await o.extractPages(tab.bytes, [k]);
      const opts = await optsFor(tab.numPages, k);
      if (opts) bytes = (await def.apply(c, bytes, { ...opts, replace: replace.checked })).bytes;
      if (my !== seq) return;
      const doc = await viewer.pdfjs.getDocument({ data: bytes }).promise;
      try {
        const page = await doc.getPage(1);
        const vp1 = page.getViewport({ scale: 1 });
        const scale = Math.min(300 / vp1.width, 380 / vp1.height) * (window.devicePixelRatio || 1);
        const vp = page.getViewport({ scale });
        const off = document.createElement('canvas');
        off.width = Math.floor(vp.width); off.height = Math.floor(vp.height);
        await page.render({ canvas: off, viewport: vp }).promise;
        if (my !== seq) return;
        canvas.width = off.width; canvas.height = off.height;
        canvas.style.width = `${off.width / (window.devicePixelRatio || 1)}px`;
        canvas.getContext('2d').drawImage(off, 0, 0);
      } finally { await doc.loadingTask.destroy(); }
      setErr(null);
      body.dataset.previewed = String(my);
    } catch (e) {
      if (my === seq) { setErr(unsupported(e) ?? e.message); body.dataset.previewed = String(my); }
    }
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(renderPreview, 250); };
  body.addEventListener('input', schedule);
  body.addEventListener('change', schedule);
  ui.onChange?.(schedule);
  schedule();

  let final = null;
  const v = await showDialog({
    title: def.title, body, className: 'pt-dialog pm-dialog',
    buttons: [{ label: 'Cancel', value: 'cancel', cancel: true }, { label: 'Apply', value: 'ok', primary: true, validate: async () => {
      try {
        const n = tab.numPages;
        final = await optsFor(n);
        if (!final) return setErr(ui.missing ?? 'Nothing to add.');
        if (!final.pages.length) return setErr('No pages match the page range and odd/even choice.');
        // Dry run on one page so unsupported text is reported here, not after the dialog closes.
        await def.apply(await marks(), await (await ops()).extractPages(tab.bytes, [final.pages[0]]), { ...final, pages: [0] });
        return setErr(null);
      } catch (e) { return setErr(unsupported(e) ?? e.message); }
    } }],
  });
  clearTimeout(timer); seq++;
  if (v !== 'ok') return false;
  const doReplace = !!replaceRow && replace.checked;
  window.api.settingsSet(def.settingsKey, { ...ui.read(), ...pagesCtl.save() }).catch(() => {});
  let note = null;
  return runOp(tab, def.title.replace('…', ''), async (bytes, n, _c) => {
    const res = await def.apply(await marks(), bytes, { ...final, replace: doReplace });
    note = res.note;
    return { bytes: res.bytes, map: identity(n) };
  }).then((ok) => { if (ok && note) toast(note); return ok; });
}

// ---------------------------------------------------------------- Header & Footer…
const TOKENS_HINT = 'Tokens: <<page>> <<pages>> <<date:DD/MM/YYYY>> <<file>>';
const hfBase = (tab) => ({ fileName: tab.name, date: new Date() });

/** Header/footer options for the whole document, or for preview copy `ctx.preview`. */
function hfOpts(st, ctx, extra) {
  if (ctx.preview != null && !ctx.indices.includes(ctx.preview)) return null;
  const k = ctx.preview == null ? 0 : ctx.indices.indexOf(ctx.preview);
  return { ...extra, pages: ctx.preview == null ? ctx.indices : [0], startNumber: st.startNumber + k,
    pagesTotal: st.startNumber + ctx.indices.length - 1, numberFormat: st.numberFormat };
}
async function applyHf(c, bytes, o) {
  // On the one-page preview copy <<pages>> would be the copy's own count: substitute the real total.
  const total = c.formatNumber(o.pagesTotal, o.numberFormat);
  const fix = (slots) => Object.fromEntries(Object.entries(slots ?? {}).map(([k, t]) => [k, String(t ?? '').replaceAll('<<pages>>', total)]));
  const { pagesTotal: _t, ...rest } = o;
  return { bytes: await c.addHeaderFooter(bytes, { ...rest, header: fix(o.header), footer: fix(o.footer) }) };
}

export function headerFooterDialog(tab = activeTab()) {
  return markDialog({
    kind: 'headerFooter', title: 'Header & Footer…', settingsKey: 'marks.headerFooter',
    build: (s) => {
      const slot = (where, pos) => input({ value: s[where]?.[pos] ?? '', 'aria-label': `${where} ${pos}`, id: `pm-${where}-${pos}` });
      const sl = { header: {}, footer: {} };
      for (const w of ['header', 'footer']) for (const p of ['left', 'center', 'right']) sl[w][p] = slot(w, p);
      const start = input({ type: 'number', min: '0', value: String(s.startNumber ?? 1), id: 'pm-start' });
      const fmtSel = select('pm-numfmt', NUM_FORMATS, s.numberFormat ?? '1');
      const font = fontControls(s, 10);
      const mg = Object.fromEntries(['top', 'bottom', 'left', 'right'].map((k) => [k, input({ type: 'number', min: '0', value: String(s.margins?.[k] ?? (k === 'top' || k === 'bottom' ? 36 : 54)), 'aria-label': `${k} margin` })]));
      const row = (w) => h('div.pm-grid3', {}, ...['left', 'center', 'right'].map((p) => field(`${w === 'header' ? 'Header' : 'Footer'} ${p}`, sl[w][p])));
      return {
        missing: 'Type text in at least one header or footer box.',
        el: h('div.pt-form', {}, row('header'), row('footer'), h('small.pt-hint', {}, TOKENS_HINT),
          h('div.pm-grid2', {}, field('Start number', start), field('Number format', fmtSel)), font.el,
          h('div.pm-grid4', {}, ...['top', 'bottom', 'left', 'right'].map((k) => field(`Margin ${k} (pt)`, mg[k])))),
        read: () => ({
          header: Object.fromEntries(Object.entries(sl.header).map(([k, el]) => [k, el.value])),
          footer: Object.fromEntries(Object.entries(sl.footer).map(([k, el]) => [k, el.value])),
          startNumber: num(start, 1), numberFormat: fmtSel.value, ...font.read(),
          margins: Object.fromEntries(Object.entries(mg).map(([k, el]) => [k, num(el, 0)])),
        }),
        opts: (st, ctx) => {
          if (![...Object.values(st.header), ...Object.values(st.footer)].some((t) => t.trim())) return null;
          return hfOpts(st, ctx, { ...hfBase(tab), header: st.header, footer: st.footer, font: st.font, fontSize: st.fontSize, color: st.color, margins: st.margins });
        },
      };
    },
    apply: applyHf,
  }, tab);
}

// ---------------------------------------------------------------- Page Numbers…
const PN_FORMATS = [['Page <<page>> of <<pages>>', 'Page 1 of 9'], ['<<page>> of <<pages>>', '1 of 9'], ['Page <<page>>', 'Page 1'], ['<<page>>', '1'], ['- <<page>> -', '- 1 -'], ['<<page>> / <<pages>>', '1 / 9']];
const POS6 = ['header-left', 'header-center', 'header-right', 'footer-left', 'footer-center', 'footer-right'].map((p) => [p, p.replace('-', ', ').replace(/^./, (x) => x.toUpperCase())]);

export function pageNumbersDialog(tab = activeTab()) {
  return markDialog({
    kind: 'headerFooter', title: 'Page Numbers…', settingsKey: 'marks.pageNumbers',
    build: (s) => {
      const pos = select('pm-pn-pos', POS6, s.position ?? 'footer-center');
      const fmt = select('pm-pn-format', PN_FORMATS, s.format ?? PN_FORMATS[0][0]);
      const style = select('pm-numfmt', NUM_FORMATS, s.numberFormat ?? '1');
      const start = input({ type: 'number', min: '0', value: String(s.startNumber ?? 1), id: 'pm-start' });
      const font = fontControls(s, 10);
      return {
        el: h('div.pt-form', {}, h('div.pm-grid2', {}, field('Position', pos), field('Format', fmt)),
          h('div.pm-grid2', {}, field('Numbers', style), field('Start number', start)), font.el),
        read: () => ({ position: pos.value, format: fmt.value, numberFormat: style.value, startNumber: num(start, 1), ...font.read() }),
        opts: (st, ctx) => {
          const [where, slot] = st.position.split('-');
          return hfOpts(st, ctx, { ...hfBase(tab), [where]: { [slot]: st.format }, font: st.font, fontSize: st.fontSize, color: st.color });
        },
      };
    },
    apply: applyHf,
  }, tab);
}

// ---------------------------------------------------------------- Watermark…
const POS9 = [['center', 'Centre'], ['tile', 'Tiled across the page'], ['top-left', 'Top left'], ['top-center', 'Top centre'], ['top-right', 'Top right'],
  ['middle-left', 'Middle left'], ['middle-right', 'Middle right'], ['bottom-left', 'Bottom left'], ['bottom-center', 'Bottom centre'], ['bottom-right', 'Bottom right']];

async function pickImage() {
  const [f] = (await window.api.openFiles({ filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }], multiple: false })) ?? [];
  if (!f) return null;
  return { name: f.name ?? String(f.path).split(/[\\/]/).pop(), bytes: f.bytes instanceof Uint8Array ? f.bytes : await window.api.readFile(f.path) };
}

export function watermarkDialog(tab = activeTab()) {
  return markDialog({
    kind: 'watermark', title: 'Watermark…', settingsKey: 'marks.watermark',
    build: (s) => {
      let image = null, changed = () => {};
      const src = select('pm-wm-source', [['text', 'Text'], ['image', 'Image (PNG or JPEG)']], s.source ?? 'text');
      const text = input({ value: s.text ?? 'CONFIDENTIAL', id: 'pm-wm-text', 'aria-label': 'Watermark text' });
      const pick = h('button.btn', { type: 'button', id: 'pm-wm-pick' }, 'Choose image…');
      const picked = h('span.pt-hint', {}, 'No image chosen');
      pick.addEventListener('click', () => pickImage().then((im) => { if (im) { image = im; picked.textContent = im.name; changed(); } }).catch(() => {}));
      const font = fontControls({ color: '#c0392b', ...s }, 48);
      const textRow = h('div.pt-form', {}, field('Text', text), font.el);
      const imageRow = h('div.pt-row', {}, pick, picked);
      const pos = select('pm-wm-pos', POS9, s.position ?? 'center');
      const opacity = input({ type: 'number', min: '5', max: '100', value: String(s.opacity ?? 30), id: 'pm-wm-opacity' });
      const rot = input({ type: 'number', min: '-180', max: '180', value: String(s.rotation ?? 45), id: 'pm-wm-rotation' });
      const scale = input({ type: 'number', min: '0', max: '100', value: String(s.scale ?? ''), placeholder: 'Auto', id: 'pm-wm-scale' });
      const layer = select('pm-wm-layer', [['over', 'Over the page content'], ['behind', 'Behind the page content']], s.layer ?? 'over');
      const sync = () => { textRow.hidden = src.value !== 'text'; imageRow.hidden = src.value !== 'image'; };
      src.addEventListener('change', sync); sync();
      return {
        onChange: (fn) => { changed = fn; },
        get missing() { return src.value === 'image' ? 'Choose an image for the watermark.' : 'Type the watermark text.'; },
        el: h('div.pt-form', {}, field('Watermark', src), textRow, imageRow,
          h('div.pm-grid2', {}, field('Position', pos), field('Layer', layer)),
          h('div.pm-grid3', {}, field('Opacity (%)', opacity), field('Rotation (°)', rot), field('Width (% of page)', scale))),
        read: () => ({ source: src.value, text: text.value, ...font.read(), position: pos.value, layer: layer.value,
          opacity: num(opacity, 30), rotation: num(rot, 45), scale: scale.value.trim() === '' ? '' : num(scale, '') }),
        opts: (st, ctx) => {
          if (ctx.preview != null && !ctx.indices.includes(ctx.preview)) return null;
          const what = st.source === 'image' ? (image ? { image: image.bytes } : null) : (st.text.trim() ? { text: st.text, font: st.font, fontSize: st.fontSize, color: st.color } : null);
          if (!what) return null;
          return { ...what, opacity: Math.min(1, Math.max(0.05, st.opacity / 100)), rotation: st.rotation, layer: st.layer,
            ...(st.position === 'tile' ? { tile: true } : { position: st.position }), ...(st.scale ? { scale: st.scale / 100 } : {}),
            pages: ctx.preview == null ? ctx.indices : [0] };
        },
      };
    },
    apply: async (c, bytes, o) => ({ bytes: await c.addWatermark(bytes, o) }),
  }, tab);
}

// ---------------------------------------------------------------- Background…
export function backgroundDialog(tab = activeTab()) {
  return markDialog({
    kind: 'background', title: 'Background…', settingsKey: 'marks.background',
    build: (s) => {
      let image = null, changed = () => {};
      const src = select('pm-bg-source', [['color', 'Colour'], ['image', 'Image (PNG or JPEG)']], s.source ?? 'color');
      const color = h('input.input.pm-color', { type: 'color', id: 'pm-bg-color', value: s.color ?? '#fff6d5', 'aria-label': 'Background colour' });
      const pick = h('button.btn', { type: 'button', id: 'pm-bg-pick' }, 'Choose image…');
      const picked = h('span.pt-hint', {}, 'No image chosen');
      pick.addEventListener('click', () => pickImage().then((im) => { if (im) { image = im; picked.textContent = im.name; changed(); } }).catch(() => {}));
      const colorRow = field('Colour', color);
      const imageRow = h('div.pt-row', {}, pick, picked);
      const opacity = input({ type: 'number', min: '5', max: '100', value: String(s.opacity ?? 100), id: 'pm-bg-opacity' });
      const sync = () => { colorRow.hidden = src.value !== 'color'; imageRow.hidden = src.value !== 'image'; };
      src.addEventListener('change', sync); sync();
      return {
        onChange: (fn) => { changed = fn; },
        get missing() { return 'Choose an image for the background.'; },
        el: h('div.pt-form', {}, h('div.pm-grid2', {}, field('Background', src), field('Opacity (%)', opacity)), colorRow, imageRow,
          h('small.pt-hint', {}, 'The background is drawn behind the page content.')),
        read: () => ({ source: src.value, color: color.value, opacity: num(opacity, 100) }),
        opts: (st, ctx) => {
          if (ctx.preview != null && !ctx.indices.includes(ctx.preview)) return null;
          const what = st.source === 'image' ? (image ? { image: image.bytes } : null) : { color: st.color };
          if (!what) return null;
          return { ...what, opacity: Math.min(1, Math.max(0.05, st.opacity / 100)), pages: ctx.preview == null ? ctx.indices : [0] };
        },
      };
    },
    apply: async (c, bytes, o) => ({ bytes: await c.addBackground(bytes, o) }),
  }, tab);
}

// ---------------------------------------------------------------- Bates Numbering…
export function batesDialog(tab = activeTab()) {
  return markDialog({
    kind: 'bates', title: 'Bates Numbering…', settingsKey: 'marks.bates',
    build: (s) => {
      const prefix = input({ value: s.prefix ?? '', id: 'pm-bt-prefix' });
      const suffix = input({ value: s.suffix ?? '', id: 'pm-bt-suffix' });
      const start = input({ type: 'number', min: '0', value: String(s.startNumber ?? 1), id: 'pm-bt-start' });
      const digits = input({ type: 'number', min: '1', max: '12', value: String(s.digits ?? 6), id: 'pm-bt-digits' });
      const pos = select('pm-bt-pos', POS6, s.position ?? 'footer-right');
      const font = fontControls(s, 10);
      return {
        el: h('div.pt-form', {}, h('div.pm-grid2', {}, field('Prefix', prefix), field('Suffix', suffix)),
          h('div.pm-grid3', {}, field('Start number', start), field('Digits', digits), field('Position', pos)), font.el),
        read: () => ({ prefix: prefix.value, suffix: suffix.value, startNumber: num(start, 1), digits: num(digits, 6), position: pos.value, ...font.read() }),
        opts: (st, ctx) => {
          if (ctx.preview != null && !ctx.indices.includes(ctx.preview)) return null;
          const k = ctx.preview == null ? 0 : ctx.indices.indexOf(ctx.preview);
          return { ...st, startNumber: st.startNumber + k, pages: ctx.preview == null ? ctx.indices : [0] };
        },
      };
    },
    apply: async (c, bytes, o) => {
      const res = await c.addBates(bytes, o);
      return { bytes: res.bytes, note: `Bates numbers applied; last number ${o.prefix}${String(res.lastNumber).padStart(o.digits, '0')}${o.suffix}` };
    },
  }, tab);
}

// ---------------------------------------------------------------- Remove
export function removeMarks(tab, kind) {
  if (!editable(tab)) { if (tab) toast(RO_TIP); return Promise.resolve(false); }
  return runOp(tab, `Remove ${KIND_LABEL[kind]}`, async (bytes, n) => ({ bytes: await (await marks()).removeMarks(bytes, kind), map: identity(n) }));
}

// ---------------------------------------------------------------- init
/** Register the Document menu. Call before the Help menu is registered so it sits left of Help. */
export function initPageMarks({ registerMenuItem: M }) {
  for (const ev of ['tab:opened', 'tab:activated', 'tab:bytesChanged']) bus.on(ev, ({ tab }) => { refreshMarks(tab); });
  const item = (def, extra = () => true) => {
    const it = { ...def };
    it.enabled = () => { const t = activeTab(); if (it.el) it.el.title = t?.readOnly ? RO_TIP : ''; return editable(t) && extra(t); };
    M('Document', it);
  };
  const withTab = (fn) => () => { const t = activeTab(); if (t) fn(t); };
  item({ id: 'marks-header-footer', label: 'Header & Footer…', action: withTab(headerFooterDialog) });
  item({ id: 'marks-page-numbers', label: 'Page Numbers…', action: withTab(pageNumbersDialog) });
  item({ id: 'marks-watermark', label: 'Watermark…', action: withTab(watermarkDialog) });
  item({ id: 'marks-background', label: 'Background…', action: withTab(backgroundDialog) });
  item({ id: 'marks-bates', label: 'Bates Numbering…', action: withTab(batesDialog) });
  M('Document', { separator: true });
  for (const [kind, label] of [['headerFooter', 'Remove header & footer'], ['watermark', 'Remove watermark'], ['background', 'Remove background'], ['bates', 'Remove Bates numbers']]) {
    item({ id: `marks-remove-${kind}`, label, action: withTab((t) => removeMarks(t, kind)) }, (t) => has(t, kind));
  }
  return { headerFooterDialog, pageNumbersDialog, watermarkDialog, backgroundDialog, batesDialog, removeMarks, refreshMarks };
}
