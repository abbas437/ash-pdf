// File > New PDF… (Ctrl+Shift+N, and the start screen's New PDF… button): a blank document of
// chosen page size, orientation and page count, opened as an untouched "Untitled N.pdf" tab.
import { state } from '../state.js';
import { h } from './dom.js';
import { showDialog, showError } from './dialogs.js';
import { SIZES, SIZE_NAMES, MM_MIN, MM_MAX, MAX_PAGES, pageSizePoints, nextUntitledName, ptToMm } from './newpdf-lib.js';

const core = () => import('../../src/core/pdfOps.js');
const KEYS = { size: 'newPdf.size', orientation: 'newPdf.orientation', pages: 'newPdf.pages', customW: 'newPdf.customW', customH: 'newPdf.customH' };
const CANCEL = { label: 'Cancel', value: 'cancel', cancel: true };

let app = null;
let counter = 1; // per window session: Untitled 1, 2, …

function errEl() { return h('p.pt-error', { role: 'alert', hidden: true }); }
function setErr(el, msg, input) {
  el.textContent = msg ?? '';
  el.hidden = !msg;
  for (const x of el.closest('.dialog')?.querySelectorAll('[aria-invalid="true"]') ?? []) x.setAttribute('aria-invalid', 'false');
  if (msg && input) { input.setAttribute('aria-invalid', 'true'); input.focus(); }
  return !msg;
}
function field(label, input, hint) {
  const hintEl = hint ? h('small.pt-hint', { id: `${input.id}-hint` }, hint) : null;
  if (hintEl) input.setAttribute('aria-describedby', hintEl.id);
  return h('div.field', {}, h('label', { for: input.id }, label), input, hintEl);
}
const num = (input) => (input.value.trim() === '' ? NaN : Number(input.value));
const round1 = (v) => String(Math.round(v * 10) / 10);

/** Last choices; a failed or odd read falls back to A4 / portrait / 1 page. */
async function loadChoices() {
  const get = (k) => window.api.settingsGet(k).catch(() => undefined);
  const [size, orientation, pages, customW, customH] = await Promise.all(Object.values(KEYS).map(get));
  return {
    size: size === 'custom' || SIZE_NAMES.includes(size) ? size : 'A4',
    orientation: orientation === 'landscape' ? 'landscape' : 'portrait',
    pages: Number.isInteger(pages) && pages >= 1 && pages <= MAX_PAGES ? pages : 1,
    customW: Number.isFinite(customW) ? customW : Math.round(ptToMm(SIZES.A4[0])),
    customH: Number.isFinite(customH) ? customH : Math.round(ptToMm(SIZES.A4[1])),
  };
}

export async function newPdfDialog() {
  const c = await loadChoices();
  const err = errEl();
  const label = (n) => { const [w, hh] = SIZES[n]; return `${n} (${round1(ptToMm(w))} × ${round1(ptToMm(hh))} mm)`; };
  const size = h('select.input', { id: 'np-size' }, SIZE_NAMES.map((n) => h('option', { value: n }, label(n))), h('option', { value: 'custom' }, 'Custom…'));
  size.value = c.size;
  const cw = h('input.input', { type: 'number', id: 'np-width', min: String(MM_MIN), max: String(MM_MAX), step: 'any', value: String(c.customW) });
  const ch = h('input.input', { type: 'number', id: 'np-height', min: String(MM_MIN), max: String(MM_MAX), step: 'any', value: String(c.customH) });
  const custom = h('div.np-custom', {}, field('Width (mm)', cw), field('Height (mm)', ch, `Each side ${MM_MIN} to ${MM_MAX} mm.`));
  const orient = h('select.input', { id: 'np-orientation' }, h('option', { value: 'portrait' }, 'Portrait'), h('option', { value: 'landscape' }, 'Landscape'));
  orient.value = c.orientation;
  const pages = h('input.input', { type: 'number', id: 'np-pages', min: '1', max: String(MAX_PAGES), step: '1', value: String(c.pages) });
  const sync = () => { custom.hidden = size.value !== 'custom'; };
  size.addEventListener('change', () => { sync(); setErr(err, null); });
  sync();
  const form = h('div.pt-form', {}, h('p.pt-hint', {}, 'A blank document opens in a new tab. Add pictures, text and shapes, then save it.'),
    field('Page size', size), custom, field('Orientation', orient), field('Number of pages', pages, `1 to ${MAX_PAGES}.`), err);
  let pt = null, n = 1;
  const v = await showDialog({
    title: 'New PDF', body: form, className: 'pt-dialog', initialFocus: '#np-size',
    buttons: [CANCEL, { label: 'Create', value: 'ok', primary: true, validate: () => {
      try { pt = pageSizePoints({ size: size.value, orientation: orient.value, customW: num(cw), customH: num(ch) }); } catch (e) {
        const bad = !(num(cw) >= MM_MIN && num(cw) <= MM_MAX) ? cw : ch;
        return setErr(err, `${e.message}.`, bad);
      }
      n = num(pages);
      if (!Number.isInteger(n) || n < 1 || n > MAX_PAGES) return setErr(err, `Enter a number of pages from 1 to ${MAX_PAGES}.`, pages);
      return setErr(err, null);
    } }],
  });
  if (v !== 'ok') return null;
  const set = (k, val) => window.api.settingsSet(k, val).catch(() => {});
  set(KEYS.size, size.value); set(KEYS.orientation, orient.value); set(KEYS.pages, n);
  if (size.value === 'custom') { set(KEYS.customW, num(cw)); set(KEYS.customH, num(ch)); }
  try {
    const bytes = await (await core()).createBlankPdf({ width: pt[0], height: pt[1], pages: n });
    const u = nextUntitledName(state.tabs.map((t) => t.name), counter);
    counter = u.next;
    const tab = await app.openBytes({ name: u.name, path: null, bytes });
    if (tab) app.toast('Blank PDF ready: drop or paste pictures, add text boxes and shapes, or insert pages from other files.', { timeout: 5000 });
    return tab;
  } catch (e) { showError('Could not create the PDF', e); return null; }
}

export function initNewPdf(a) {
  app = a;
  app.newPdf = newPdfDialog;
}
