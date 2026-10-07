// Sign: the toolbar "Sign" button and its dropdown (also Tools > Sign…). Lists the saved
// signatures and initials of the library (renderer/ui/signatures.js, default first); choosing one
// arms the image tool with its PNG (a locked item asks for its password first), at the width last
// placed for that item (settings `sign.width.<id>`). Esc cancels the armed placement.
//   Place on pages…  options-bar button of the Select tool while a placed signature is selected:
//                    copies the selection to all / odd / even / a range of pages at the same
//                    relative position (centre scaled by the page size), one undo step.
//   Signature block… signature image + name / optional title / date text objects sharing one
//                    `group` (selected, moved and deleted together), one undo step.
// These are visual signatures (images), not digital certificates; the UI says so.
import { activeTab } from '../state.js';
import { h } from './dom.js';
import { showDialog, toast } from './dialogs.js';
import { getTool, setTool, addToolbarItem } from './toolbar.js';
import { viewer } from './viewer.js';
import { annotations, AUTHOR_KEY } from './annotations.js';
import { armImage } from './tools-stamp.js';
import { signatureLibrary, openSignatureManager } from './signatures.js';
import { targetPages, formatDate, DATE_FORMATS } from '../../src/core/siglib.js';
import { parseRanges } from '../../src/core/pdfOps.js';

const SIGN_FRAC = 0.25;        // default signature width, fraction of the page width
const BLOCK_FONT = 10;         // signature block text size (points)
const BLOCK_LH = 1.2;
const NOTE = 'Visual signatures are images of your handwriting or name, not digital certificates.';
const SIGN_ICON = '<svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 17c2.5-4 4.5-6 5.5-5s-2 5 0 5 3.5-4 5-4-0.5 3 1 3 2.5-1.5 3.5-2.5"/><path d="M3 21h18"/></svg>';
const CARET = '<svg class="icon" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true" focusable="false"><path d="M2 3.5l3 3 3-3"/></svg>';

const widthKey = (id) => `sign.width.${id}`;
const pad2 = (n) => String(n).padStart(2, '0');
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const kindLabel = (it) => (it.kind === 'initials' ? 'Initials' : 'Signature');
/** Library items for pickers: defaults first, then the library order. */
const sorted = (list) => [...list].sort((a, b) => (b.isDefault - a.isDefault) || ((a.order ?? 0) - (b.order ?? 0)));

let btnEl = null, menuEl = null;
const urls = [];

// ---------------------------------------------------------------- arm a signature
async function rememberedWidth(id) {
  const w = await window.api.settingsGet(widthKey(id)).catch(() => undefined);
  return Number.isFinite(w) && w > 0 ? w : undefined;
}
/** Arm the image tool with library item `it`; `more` adds armImage options (extra, companions). */
async function armItem(it, more = {}) {
  if (!activeTab()) return false;
  const png = await signatureLibrary.getPng(it.id);
  if (!png) return false; // locked and cancelled, or deleted meanwhile
  const width = await rememberedWidth(it.id);
  return armImage(png, {
    frac: SIGN_FRAC, label: it.kind === 'initials' ? 'initials' : 'signature', width, ...more,
    extra: { sig: it.id, ...more.extra },
    onPlaced: (img) => { if (img) window.api.settingsSet(widthKey(it.id), Math.round(img.w * 100) / 100).catch(() => {}); },
  });
}

// ---------------------------------------------------------------- dropdown
function closeMenu(focusButton = false) {
  if (!menuEl || menuEl.hidden) return;
  menuEl.hidden = true;
  btnEl.setAttribute('aria-expanded', 'false');
  for (const u of urls.splice(0)) URL.revokeObjectURL(u);
  document.removeEventListener('mousedown', onOutside, true);
  if (focusButton) btnEl.focus();
}
function onOutside(e) { if (!menuEl.contains(e.target) && !btnEl.contains(e.target)) closeMenu(); }
async function thumb(it) {
  if (it.locked) return h('span.sign-lock', {}, 'Locked');
  const png = await signatureLibrary.getPng(it.id);
  if (!png) return h('span.sign-lock', {}, 'No preview');
  const u = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
  urls.push(u);
  return h('img', { src: u, alt: '' });
}
async function openMenu(focusFirst = false) {
  const tab = activeTab(), off = !tab || tab.readOnly;
  const list = sorted(await signatureLibrary.list());
  const item = (cls, label, action, props = {}) => h(`button.sign-item.${cls}`, { type: 'button', role: 'menuitem', onclick: () => { closeMenu(); action(); }, ...props }, label);
  const rows = [];
  if (!list.length) rows.push(h('p.sign-empty', {}, 'No saved signatures yet.'));
  for (const it of list) {
    const meta = [kindLabel(it), it.isDefault ? 'default' : null, it.locked ? 'password' : null].filter(Boolean).join(' · ');
    rows.push(item('sign-pick', [h('span.sign-thumb', {}, await thumb(it)), h('span.sign-text', {}, h('span.sign-name', {}, it.name), h('span.sign-meta', {}, meta))],
      () => armItem(it), { disabled: off, dataset: { id: it.id }, title: off ? 'Open a document first' : `Place ${it.name}` }));
  }
  rows.push(h('div.menu-sep', { role: 'separator' }),
    item('sign-manage', 'Manage signatures…', () => openSignatureManager()),
    item('sign-block', 'Signature block…', () => blockDialog(), { disabled: off || !list.length }),
    h('p.sign-note', {}, NOTE));
  menuEl.replaceChildren(...rows);
  menuEl.hidden = false;
  btnEl.setAttribute('aria-expanded', 'true');
  document.addEventListener('mousedown', onOutside, true);
  if (focusFirst) menuEl.querySelector('button:not([disabled])')?.focus();
}
function onMenuKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); return; }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const items = [...menuEl.querySelectorAll('button:not([disabled])')];
  const k = items.indexOf(document.activeElement);
  items[(k + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
}

// ---------------------------------------------------------------- place on pages
/** Copies of `objs` (all on one page) for every page in `pages`, centre scaled by the page size. */
function copiesOnPages(tab, objs, pages) {
  const src = objs[0].page, P = viewer.pageSize(tab, src);
  const x0 = Math.min(...objs.map((o) => o.x)), y0 = Math.min(...objs.map((o) => o.y));
  const x1 = Math.max(...objs.map((o) => o.x + o.w)), y1 = Math.max(...objs.map((o) => o.y + o.h));
  const w = x1 - x0, hh = y1 - y0, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const out = [];
  for (const q of pages) {
    if (q === src) continue;
    const Q = viewer.pageSize(tab, q);
    const nx = Math.min(Math.max(0, cx * (Q.width / P.width) - w / 2), Math.max(0, Q.width - w));
    const ny = Math.min(Math.max(0, cy * (Q.height / P.height) - hh / 2), Math.max(0, Q.height - hh));
    const regroup = new Map();
    for (const o of objs) {
      const { id, ...rest } = o;
      if (o.group && !regroup.has(o.group)) regroup.set(o.group, annotations.newId());
      out.push({ ...structuredClone(rest), page: q, x: o.x + nx - x0, y: o.y + ny - y0, ...(o.group ? { group: regroup.get(o.group) } : {}) });
    }
  }
  return out;
}
async function placeOnPagesDialog(tab, objs) {
  const n = tab.numPages, src = objs[0].page;
  const radio = (v, label, checked) => h('label.sign-radio', {}, h('input', { type: 'radio', name: 'sign-pages', value: v, checked }), h('span', {}, label));
  const range = h('input.input.sign-range', { type: 'text', placeholder: `e.g. 1-3, 5 (of ${n})`, 'aria-label': 'Page range' });
  const status = h('p.sig-status', { role: 'status' });
  range.addEventListener('focus', () => { body.querySelector('input[value="range"]').checked = true; });
  const body = h('div.sign-pages', {},
    h('p.sig-note', {}, `Copies the selected signature to other pages at the same relative position. ${NOTE}`),
    h('div.sign-radios', { role: 'radiogroup', 'aria-label': 'Pages' }, radio('all', 'All pages', true), radio('odd', 'Odd pages'), radio('even', 'Even pages'), h('div.row', {}, radio('range', 'Pages'), range)),
    status);
  let pages = null;
  const v = await showDialog({
    title: 'Place on pages', body, className: 'sign-pages-wrap', initialFocus: 'input[value="all"]',
    buttons: [{ label: 'Cancel', value: 'cancel', cancel: true }, {
      label: 'Place', value: 'ok', primary: true,
      validate: () => {
        const mode = body.querySelector('input[name="sign-pages"]:checked').value;
        let idx = [];
        if (mode === 'range') { try { idx = parseRanges(range.value, n); } catch (err) { status.textContent = err.message; range.focus(); return false; } }
        pages = targetPages(mode, n, idx).filter((i) => i !== src);
        if (!pages.length) { status.textContent = `No pages to add to: the signature is already on page ${src + 1}.`; return false; }
        return true;
      },
    }],
  });
  if (v !== 'ok' || !pages) return;
  const ids = annotations.addMany(tab, copiesOnPages(tab, objs, pages));
  toast(`Signature placed on ${pages.length} more page${pages.length === 1 ? '' : 's'}`);
  return ids;
}
/** Select-tool options: "Place on pages…" while the selection is a placed signature (one page). */
function selectionOptions(c) {
  const tab = activeTab();
  if (!tab || tab.readOnly) return;
  const objs = annotations.getSelection(tab).map((id) => annotations.getObject(tab, id)).filter(Boolean);
  if (!objs.some((o) => o.type === 'image' && o.sig) || new Set(objs.map((o) => o.page)).size !== 1) return;
  c.append(h('button.btn.opt-sign-pages', { type: 'button', title: 'Copy this signature to other pages', onclick: () => placeOnPagesDialog(tab, objs) }, 'Place on pages…'));
}

// ---------------------------------------------------------------- signature block
let measureCtx = null;
function lineWidth(text) {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  measureCtx.font = `100px Helvetica, Arial, "Liberation Sans", sans-serif`;
  return (measureCtx.measureText(text).width / 100) * BLOCK_FONT;
}
/** Text objects under the placed image `img` (moved up if the block would leave the page). */
function blockCompanions(lines, group) {
  return (img, P) => {
    const lh = BLOCK_FONT * BLOCK_LH, w = Math.min(P.width, Math.max(img.w, ...lines.map((t) => lineWidth(t) + 6)));
    const over = img.y + img.h + 2 + lines.length * lh - P.height;
    if (over > 0) img.y = Math.max(0, img.y - over); // same object as the one added just before these
    const x = Math.min(img.x, P.width - w);
    return lines.map((text, k) => ({
      type: 'text', page: img.page, group, text, x, y: img.y + img.h + 2 + k * lh, w, h: lh,
      font: 'Helvetica', fontSize: BLOCK_FONT, bold: k === 0, italic: false, color: '#111111', align: 'left', lineHeight: BLOCK_LH,
    }));
  };
}
async function blockDialog() {
  if (!activeTab()) return;
  const list = sorted(await signatureLibrary.list());
  if (!list.length) { toast('No saved signatures: use Manage signatures… first'); return; }
  const author = await window.api.settingsGet(AUTHOR_KEY).catch(() => undefined);
  const sigSel = h('select.input.sign-block-sig', { 'aria-label': 'Signature' }, list.map((it) => h('option', { value: it.id }, `${it.name} (${kindLabel(it).toLowerCase()}${it.locked ? ', password' : ''})`)));
  const nameIn = h('input.input.sign-block-name', { type: 'text', maxlength: '80', value: typeof author === 'string' ? author.trim() : '' });
  const titleIn = h('input.input.sign-block-title', { type: 'text', maxlength: '80', placeholder: 'Optional, e.g. Project Manager' });
  const dateIn = h('input.input.sign-block-date', { type: 'date', value: todayIso() });
  const fmtSel = h('select.input.sign-block-format', { 'aria-label': 'Date format' });
  const fillFormats = () => fmtSel.replaceChildren(...DATE_FORMATS.map((f) => h('option', { value: f, selected: f === (fmtSel.value || DATE_FORMATS[0]) }, formatDate(dateIn.value || todayIso(), f))));
  fillFormats();
  dateIn.addEventListener('change', fillFormats);
  const status = h('p.sig-status', { role: 'status' });
  const field = (label, ctl) => h('label.field', {}, h('span', {}, label), ctl);
  const body = h('div.sign-block', {},
    h('p.sig-note', {}, `Places the signature with your name and the date below it, as one group. ${NOTE}`),
    field('Signature', sigSel), field('Name', nameIn), field('Title (optional)', titleIn),
    h('div.row.sign-block-dates', {}, field('Date', dateIn), field('Format', fmtSel)), status);
  const v = await showDialog({
    title: 'Signature block', body, className: 'sign-block-wrap', initialFocus: '.sign-block-name',
    buttons: [{ label: 'Cancel', value: 'cancel', cancel: true }, {
      label: 'Place block', value: 'ok', primary: true,
      validate: () => { if (!nameIn.value.trim()) { status.textContent = 'Type the name to show under the signature.'; nameIn.focus(); return false; } return true; },
    }],
  });
  if (v !== 'ok') return;
  const it = list.find((x) => x.id === sigSel.value);
  const lines = [nameIn.value.trim(), titleIn.value.trim(), formatDate(dateIn.value || todayIso(), fmtSel.value)].filter(Boolean);
  const group = annotations.newId();
  await armItem(it, { label: 'signature block', extra: { group }, companions: blockCompanions(lines, group) });
}

// ---------------------------------------------------------------- init
export function initSign(app) {
  btnEl = h('button.tb-btn.sign-btn#btn-sign', {
    type: 'button', title: 'Sign: place a saved visual signature', 'aria-label': 'Sign (visual signature)', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
    html: `${SIGN_ICON}<span class="sign-btn-label">Sign</span>${CARET}`,
    onclick: () => (menuEl.hidden ? openMenu() : closeMenu()),
  });
  btnEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); openMenu(true); }
    else if (e.key === 'Escape' && !menuEl.hidden) { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
  });
  menuEl = h('div.sign-menu', { role: 'menu', 'aria-label': 'Sign', hidden: true });
  menuEl.addEventListener('keydown', onMenuKey);
  addToolbarItem('sign', h('div.sign-wrap', {}, btnEl, menuEl));
  app.registerMenuItem('Tools', { id: 'sign', label: 'Sign…', action: () => openMenu(true) });
  const sel = getTool('select');
  if (sel) { sel.options = [...[sel.options ?? []].flat(), selectionOptions]; setTool('select'); }
  signatureLibrary.onChange(() => { if (!menuEl.hidden) openMenu(); });
}
