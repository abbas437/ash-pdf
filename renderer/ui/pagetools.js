// Page tools: thumbnail context menu, drag-and-drop reordering, page/document dialogs
// (merge, split, crop, properties, images to PDF, insert pages) and the per-tab
// page-operation undo stack (tab.bytesUndo / tab.bytesRedo, 20 entries each).
//
// Every change to the document follows the page protocol other modules rely on:
//   tab.bytes = newBytes; markDirty(tab);
//   bus.emit('pages:remapped', {tab, map});  // Map<oldIndex, newIndex|null>, inserted pages have no key
//   bus.emit('tab:bytesChanged', {tab});      // the viewer reloads
import { bus } from '../bus.js';
import { activeTab, markDirty } from '../state.js';
import { h } from './dom.js';
import { showDialog, showError, toast, dialogOpen } from './dialogs.js';
import { thumbs } from './sidebar.js';

const core = () => import('../../src/core/pdfOps.js');
const UNDO_CAP = 20;
const RO_TIP = 'Encrypted document: page editing is not supported';
const MM = 72 / 25.4;
const PDF_FILTER = [{ name: 'PDF', extensions: ['pdf'] }];
let app = null;
let chain = Promise.resolve();
let pendingSelect = null;  // {tab, indices, focus} applied when the thumbnails are rebuilt

const range = (n, from = 0) => Array.from({ length: n }, (_, i) => i + from);
const sorted = (set) => [...set].sort((a, b) => a - b);
const baseName = (tab) => tab.name.replace(/\.pdf$/i, '');
const editable = (tab) => !!tab && !tab.readOnly;

// ---------------------------------------------------------------- maps
function shiftMap(n, at, count) { return new Map(range(n).map((i) => [i, i < at ? i : i + count])); }
function orderMap(order) { return new Map(order.map((old, k) => [old, k])); }
function deleteMap(n, del) {
  const gone = new Set(del);
  let k = 0;
  return new Map(range(n).map((i) => [i, gone.has(i) ? null : k++]));
}
/** New order (old index per new position) moving the sorted `sel` before old index `pos`. */
function moveOrder(n, sel, pos) {
  const set = new Set(sel), before = [], after = [];
  for (let i = 0; i < n; i++) if (!set.has(i)) (i < pos ? before : after).push(i);
  return [...before, ...sel, ...after];
}
const isIdentity = (order) => order.every((v, k) => v === k);

// ---------------------------------------------------------------- protocol + undo
function commit(tab, bytes, map, select) {
  const refocus = !!thumbs.listEl?.contains(document.activeElement);
  if (select) pendingSelect = { tab, indices: select, focus: refocus };
  tab.bytes = bytes;
  markDirty(tab);
  bus.emit('pages:remapped', { tab, map });
  bus.emit('tab:bytesChanged', { tab });
}

function pushCapped(stack, entry) { stack.push(entry); if (stack.length > UNDO_CAP) stack.shift(); }

/**
 * Queue a page operation. fn(bytes, pageCount, core) → {bytes, map, select?} | null.
 * Operations run one at a time against the latest tab.bytes. Resolves true when applied.
 */
export function runOp(tab, label, fn) {
  if (!tab) return Promise.resolve(false);
  if (tab.readOnly) { toast(RO_TIP); return Promise.resolve(false); }
  const job = chain.then(async () => {
    try {
      const c = await core();
      const before = tab.bytes;
      const n = (await c.getInfo(before)).pageCount;
      const res = await fn(before, n, c);
      if (!res) return false;
      tab.bytesUndo ??= [];
      pushCapped(tab.bytesUndo, { bytes: before, map: res.map });
      tab.bytesRedo = [];
      commit(tab, res.bytes, res.map, res.select);
      offerUndo(tab);
      return true;
    } catch (err) {
      showError(`${label}: the operation failed`, err);
      return false;
    }
  });
  chain = job.catch(() => {});
  return job;
}

function invert(map, newCount) {
  const inv = new Map(range(newCount).map((i) => [i, null]));
  for (const [o, nw] of map) if (nw != null) inv.set(nw, o);
  return inv;
}

function step(tab, from, to) {
  if (!tab || tab.readOnly || !tab[from]?.length) return Promise.resolve(false);
  const job = chain.then(async () => {
    const entry = tab[from].pop();
    if (!entry) return false;
    try {
      const c = await core();
      const cur = tab.bytes;
      const curCount = (await c.getInfo(cur)).pageCount;
      // Undo: entry.map is old→new of the op being undone, so emit its inverse.
      // Redo: entry.map was stored inverted by undo, so the same rule applies.
      const map = invert(entry.map, curCount);
      tab[to] ??= [];
      pushCapped(tab[to], { bytes: cur, map });
      commit(tab, entry.bytes, map, null);
      toast(from === 'bytesUndo' ? 'Page change undone' : 'Page change redone');
      return true;
    } catch (err) {
      tab[from].push(entry);
      showError('Could not undo the page change', err);
      return false;
    }
  });
  chain = job.catch(() => {});
  return job;
}
export const undo = (tab = activeTab()) => step(tab, 'bytesUndo', 'bytesRedo');
export const redo = (tab = activeTab()) => step(tab, 'bytesRedo', 'bytesUndo');

function offerUndo(tab) {
  for (const old of document.querySelectorAll('.pt-toast')) old.remove(); // one undo toast at a time
  const b = h('button.toast-action', { type: 'button', 'aria-label': 'Undo page change' }, 'Undo');
  const t = toast(h('span.toast-row', {}, h('span', {}, 'Pages changed'), b), { timeout: 6000 });
  t.classList.add('pt-toast');
  b.addEventListener('click', () => { t.remove(); undo(tab); });
}

// ---------------------------------------------------------------- page operations
const selectionOf = (tab, fallback = tab.currentPage) => {
  const s = sorted(thumbs.selection).filter((i) => i < tab.numPages);
  return s.length ? s : [fallback];
};

export function rotate(tab, sel, delta) {
  return runOp(tab, 'Rotate pages', async (bytes, n, c) => ({ bytes: await c.rotatePages(bytes, sel, delta), map: shiftMap(n, n, 0), select: sel }));
}

export async function deletePages(tab, sel, { confirm = true } = {}) {
  if (!editable(tab)) return false;
  if (sel.length >= tab.numPages) {
    await showDialog({ title: 'Cannot delete every page', body: 'A PDF must keep at least one page. Deselect at least one page and try again.', buttons: [{ label: 'Close', value: 'ok', primary: true, cancel: true }] });
    return false;
  }
  if (confirm) {
    const what = sel.length === 1 ? `page ${sel[0] + 1}` : `${sel.length} pages (${sel.map((i) => i + 1).join(', ')})`;
    const v = await showDialog({
      title: 'Delete pages', body: `Delete ${what}? You can undo this with Edit › Undo page change.`,
      buttons: [{ label: 'Cancel', value: 'cancel', cancel: true }, { label: 'Delete', value: 'ok', primary: true, danger: true }],
    });
    if (v !== 'ok') return false;
  }
  return runOp(tab, 'Delete pages', async (bytes, n, c) => ({
    bytes: await c.deletePages(bytes, sel), map: deleteMap(n, sel), select: [Math.min(sel[0], n - sel.length - 1)],
  }));
}

export function insertBlank(tab, at) {
  return runOp(tab, 'Insert blank page', async (bytes, n, c) => ({ bytes: await c.insertBlankPage(bytes, at), map: shiftMap(n, at, 1), select: [at] }));
}

export function duplicate(tab, sel) {
  const at = sel[sel.length - 1] + 1;
  return runOp(tab, 'Duplicate pages', async (bytes, n, c) => ({
    bytes: await c.insertPagesFrom(bytes, bytes, sel, at), map: shiftMap(n, at, sel.length), select: range(sel.length, at),
  }));
}

export function reorder(tab, order) {
  if (isIdentity(order)) return Promise.resolve(false);
  const select = order.flatMap((old, k) => (thumbs.selection.has(old) ? [k] : []));
  return runOp(tab, 'Move pages', async (bytes, n, c) => {
    if (order.length !== n) throw new RangeError('The document changed; try the move again.');
    return { bytes: await c.reorderPages(bytes, order), map: orderMap(order), select };
  });
}

function moveTarget(kind, n, sel) {
  return { up: Math.max(0, sel[0] - 1), down: Math.min(n, sel[sel.length - 1] + 2), start: 0, end: n }[kind];
}
export const move = (tab, sel, kind) => reorder(tab, moveOrder(tab.numPages, sel, moveTarget(kind, tab.numPages, sel)));

async function extract(tab, sel) {
  try {
    const bytes = await (await core()).extractPages(tab.bytes, sel);
    const suffix = sel.length === 1 ? `page-${sel[0] + 1}` : `pages-${sel[0] + 1}-${sel[sel.length - 1] + 1}`;
    const res = await window.api.saveFile({ defaultPath: `${baseName(tab)}-${suffix}.pdf`, filters: PDF_FILTER, bytes });
    if (res) toast(`Extracted ${sel.length} page${sel.length > 1 ? 's' : ''}`);
  } catch (err) { showError('Could not extract pages', err); }
}

// ---------------------------------------------------------------- context menu
let ctx = null;
function closeContext(refocus = true) {
  if (!ctx) return;
  const { el, origin } = ctx;
  ctx = null;
  el.remove();
  document.removeEventListener('mousedown', onDocDown, true);
  document.removeEventListener('keydown', onCtxKey, true);
  window.removeEventListener('blur', onBlur);
  if (refocus && origin?.isConnected) origin.focus();
}
const onDocDown = (e) => { if (ctx && !ctx.el.contains(e.target)) closeContext(false); };
const onBlur = () => closeContext(false);
function onCtxKey(e) {
  if (!ctx) return;
  const items = [...ctx.el.querySelectorAll('button:not(:disabled)')];
  const k = items.indexOf(document.activeElement);
  if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); closeContext(); }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault(); e.stopPropagation();
    items[(k + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  } else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); items[e.key === 'Home' ? 0 : items.length - 1]?.focus(); }
}

function openContext(e, { tab, pageIndex }) {
  closeContext(false);
  const sel = selectionOf(tab, pageIndex);
  const n = tab.numPages;
  const ro = tab.readOnly;
  const many = sel.length > 1;
  const moveNoop = (kind) => isIdentity(moveOrder(n, sel, moveTarget(kind, n, sel)));
  const entries = [
    ['rotate-left', 'Rotate left', '[', () => rotate(tab, sel, -90)],
    ['rotate-right', 'Rotate right', ']', () => rotate(tab, sel, 90)],
    null,
    ['insert-before', 'Insert blank page before', '', () => insertBlank(tab, sel[0])],
    ['insert-after', 'Insert blank page after', '', () => insertBlank(tab, sel[sel.length - 1] + 1)],
    ['duplicate', many ? 'Duplicate pages' : 'Duplicate page', '', () => duplicate(tab, sel)],
    ['extract', 'Extract pages…', '', () => extract(tab, sel), false],
    null,
    ['move-up', 'Move up', '', () => move(tab, sel, 'up'), moveNoop('up')],
    ['move-down', 'Move down', '', () => move(tab, sel, 'down'), moveNoop('down')],
    ['move-start', 'Move to start', '', () => move(tab, sel, 'start'), moveNoop('start')],
    ['move-end', 'Move to end', '', () => move(tab, sel, 'end'), moveNoop('end')],
    null,
    ['delete', many ? `Delete ${sel.length} pages…` : 'Delete page…', 'Del', () => deletePages(tab, sel), sel.length >= n],
  ];
  const label = many ? `${sel.length} pages selected` : `Page ${sel[0] + 1}`;
  const el = h('div.ctx-menu', { role: 'menu', 'aria-label': `Page actions: ${label}` }, h('div.ctx-head', { 'aria-hidden': 'true' }, label));
  for (const it of entries) {
    if (!it) { el.append(h('div.menu-sep', { role: 'separator' })); continue; }
    const [id, text, key, action, disabledExtra] = it;
    const needsEdit = id !== 'extract';
    const disabled = (needsEdit && ro) || !!disabledExtra || (id === 'extract' && ro);
    const b = h(`button.menu-item${id === 'delete' ? '.danger' : ''}`, {
      type: 'button', role: 'menuitem', dataset: { ptAction: id }, disabled,
      title: disabled && ro ? RO_TIP : (id === 'delete' && sel.length >= n ? 'A PDF must keep at least one page' : null),
    }, h('span', {}, text), h('kbd', {}, key));
    b.addEventListener('click', () => { closeContext(); action(); });
    el.append(b);
  }
  document.body.append(el);
  let x = e.clientX, y = e.clientY;
  if (!x && !y) { const r = e.target.closest('.thumb')?.getBoundingClientRect(); x = r ? r.right - 20 : 40; y = r ? r.top + 10 : 40; }
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  el.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
  ctx = { el, origin: e.target.closest('.thumb') ?? document.activeElement };
  document.addEventListener('mousedown', onDocDown, true);
  document.addEventListener('keydown', onCtxKey, true);
  window.addEventListener('blur', onBlur);
  el.querySelector('button:not(:disabled)')?.focus();
}

// ---------------------------------------------------------------- thumbnail list: keys + drag
let drag = null; // {tab, sel, line}
function onListKey(e) {
  const tab = activeTab();
  if (!tab || !e.target.closest('.thumb') || dialogOpen()) return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === 'a') { e.preventDefault(); e.stopPropagation(); thumbs.setSelection(range(tab.numPages)); return; }
  if (ctrl || e.altKey) return;
  if (e.key === 'Delete') { e.preventDefault(); e.stopPropagation(); if (!editable(tab)) toast(RO_TIP); else deletePages(tab, selectionOf(tab, Number(e.target.closest('.thumb').dataset.pageIndex))); }
  else if (e.key === '[' || e.key === ']') { e.preventDefault(); e.stopPropagation(); rotate(tab, selectionOf(tab), e.key === ']' ? 90 : -90); }
}

function thumbEls(n) { return range(n).map((i) => thumbs.getEl(i)).filter(Boolean); }

/** Insertion position (0..n) for a pointer at clientY: binary search over thumb midpoints. */
function dropPos(els, y) {
  let lo = 0, hi = els.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const r = els[mid].getBoundingClientRect();
    if (y < r.top + r.height / 2) hi = mid; else lo = mid + 1;
  }
  return lo;
}

function wireList({ tab, count }) {
  const list = thumbs.listEl;
  if (!list || list.dataset.ptWired) return;
  list.dataset.ptWired = '1';
  const els = thumbEls(count);
  for (const el of els) el.draggable = !tab.readOnly;
  list.addEventListener('keydown', onListKey);
  list.addEventListener('dragstart', (e) => {
    const el = e.target.closest?.('.thumb');
    if (!el || tab.readOnly) return;
    const i = Number(el.dataset.pageIndex);
    if (!thumbs.selection.has(i)) thumbs.setSelection([i]);
    const sel = sorted(thumbs.selection);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-ash-pages', JSON.stringify(sel));
    const line = h('div.thumb-drop-line', { hidden: true, 'aria-hidden': 'true' });
    list.append(line);
    drag = { tab, sel, line, els };
    for (const k of sel) els[k]?.classList.add('dragging');
  });
  list.addEventListener('dragover', (e) => {
    if (!drag || drag.tab !== tab) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const pos = dropPos(drag.els, e.clientY);
    const ref = drag.els[Math.min(pos, drag.els.length - 1)];
    drag.line.hidden = false;
    drag.line.style.top = `${pos < drag.els.length ? ref.offsetTop - 5 : ref.offsetTop + ref.offsetHeight + 5}px`;
    const sc = list.parentElement, r = sc.getBoundingClientRect();
    if (e.clientY < r.top + 30) sc.scrollTop -= 12; else if (e.clientY > r.bottom - 30) sc.scrollTop += 12;
  });
  list.addEventListener('dragleave', (e) => { if (drag && !list.contains(e.relatedTarget)) drag.line.hidden = true; });
  list.addEventListener('drop', (e) => {
    if (!drag || drag.tab !== tab) return;
    e.preventDefault();
    e.stopPropagation();
    const { sel, els } = drag;
    const order = moveOrder(els.length, sel, dropPos(els, e.clientY));
    endDrag();
    reorder(tab, order);
  });
  list.addEventListener('dragend', endDrag);
}
function endDrag() {
  if (!drag) return;
  drag.line.remove();
  for (const el of drag.els) el.classList.remove('dragging');
  drag = null;
}

bus.on('thumbs:rebuilt', (p) => {
  wireList(p);
  if (pendingSelect?.tab === p.tab) {
    const { indices, focus } = pendingSelect;
    pendingSelect = null;
    const ok = indices.filter((i) => i < p.count);
    if (ok.length) {
      thumbs.setSelection(ok);
      if (focus) { const el = thumbs.getEl(ok[0]); if (el) { for (const x of thumbEls(p.count)) x.tabIndex = -1; el.tabIndex = 0; el.focus(); } }
    }
  }
});

// ---------------------------------------------------------------- dialog helpers
function errEl() { return h('p.pt-error', { role: 'alert', hidden: true }); }
function setErr(el, msg, input) {
  el.textContent = msg ?? '';
  el.hidden = !msg;
  for (const x of el.closest('.dialog')?.querySelectorAll('[aria-invalid="true"]') ?? []) x.setAttribute('aria-invalid', 'false');
  if (msg && input) { input.setAttribute('aria-invalid', 'true'); input.focus(); }
  return !msg;
}
let uid = 0;
function field(label, input, hint) {
  const id = input.id || (input.id = `pt-f-${++uid}`);
  const hintEl = hint ? h('small.pt-hint', { id: `${id}-hint` }, hint) : null;
  if (hintEl) input.setAttribute('aria-describedby', hintEl.id);
  return h('div.field', {}, h('label', { for: id }, label), input, hintEl);
}
function radio(name, value, label, checked, extra) {
  const r = h('input', { type: 'radio', name, value, id: `pt-r-${++uid}`, checked: !!checked });
  return h('div.pt-radio', {}, r, h('label', { for: r.id }, label), extra ?? null);
}
const radioValue = (dlg, name) => dlg.querySelector(`input[name="${name}"]:checked`)?.value;
const num = (input) => (input.value.trim() === '' ? NaN : Number(input.value));
const CANCEL = { label: 'Cancel', value: 'cancel', cancel: true };

async function pickPdfs(multiple) {
  const files = await window.api.openFiles({ filters: PDF_FILTER, multiple });
  const out = [];
  const c = await core();
  for (const f of files ?? []) {
    const bytes = f.bytes instanceof Uint8Array ? f.bytes : await window.api.readFile(f.path);
    const name = f.name ?? String(f.path).split(/[\\/]/).pop();
    const info = await c.getInfo(bytes);
    if (info.isEncrypted) throw Object.assign(new Error(`"${name}" is encrypted and cannot be combined.`), { code: 'ENCRYPTED' });
    out.push({ name, bytes, pages: info.pageCount });
  }
  return out;
}

/** Reorderable file list with ↑ / ↓ / remove buttons. */
function fileList(files, label, describe) {
  const ul = h('ul.pt-filelist', { 'aria-label': label });
  const render = () => {
    ul.replaceChildren();
    if (!files.length) { ul.append(h('li.pt-empty', {}, 'No files added yet')); return; }
    files.forEach((f, k) => {
      const mk = (txt, aria, fn, dis) => {
        const b = h('button.pt-icon-btn', { type: 'button', 'aria-label': `${aria} ${f.name}`, title: aria, disabled: dis }, txt);
        b.addEventListener('click', () => { fn(); render(); ul.querySelectorAll('li')[Math.min(k, files.length - 1)]?.querySelector('button:not(:disabled)')?.focus(); });
        return b;
      };
      ul.append(h('li', {}, h('span.pt-file-name', { title: f.name }, f.name), h('span.pt-file-meta', {}, describe(f)),
        mk('↑', 'Move up', () => files.splice(k - 1, 0, ...files.splice(k, 1)), k === 0),
        mk('↓', 'Move down', () => files.splice(k + 1, 0, ...files.splice(k, 1)), k === files.length - 1),
        mk('✕', 'Remove', () => files.splice(k, 1))));
    });
  };
  render();
  return { ul, render };
}
const pagesLabel = (f) => `${f.pages} page${f.pages === 1 ? '' : 's'}`;

// ---------------------------------------------------------------- Merge…
export async function mergeDialog(tab = activeTab()) {
  if (!editable(tab)) return;
  const n = tab.numPages;
  const files = [];
  const list = fileList(files, 'PDF files to merge', pagesLabel);
  const err = errEl();
  const add = h('button.btn', { type: 'button', id: 'pt-merge-add' }, 'Add PDF files…');
  add.addEventListener('click', () => {
    pickPdfs(true).then((picked) => { files.push(...picked); list.render(); setErr(err, null); })
      .catch((e) => setErr(err, e.message));
  });
  const after = h('input.input', { type: 'number', min: '1', max: String(n), value: String(n), id: 'pt-merge-after', 'aria-label': 'Insert after page number' });
  const form = h('div.pt-form', {},
    h('p.pt-hint', {}, `Pages from the chosen files are added to "${tab.name}" (${n} pages), in the order listed.`),
    h('div.pt-row', {}, add), list.ul,
    h('fieldset.pt-fieldset', {}, h('legend', {}, 'Position'),
      radio('pt-merge-pos', 'end', 'Append at the end', true),
      radio('pt-merge-pos', 'after', 'Insert after page', false, after)),
    err);
  after.addEventListener('focus', () => { form.querySelector('input[value="after"]').checked = true; });
  const v = await showDialog({
    title: 'Merge PDFs', body: form, className: 'pt-dialog pt-merge', initialFocus: '#pt-merge-add',
    buttons: [CANCEL, { label: 'Merge', value: 'ok', primary: true, validate: (dlg) => {
      if (!files.length) return setErr(err, 'Add at least one PDF file to merge.', add);
      if (radioValue(dlg, 'pt-merge-pos') === 'after') {
        const k = num(after);
        if (!Number.isInteger(k) || k < 1 || k > n) return setErr(err, `Enter a page number from 1 to ${n}.`, after);
      }
      return setErr(err, null);
    } }],
  });
  if (v !== 'ok') return;
  const pos = radioValue(form, 'pt-merge-pos');
  return runOp(tab, 'Merge', async (bytes, cnt, c) => {
    let at = pos === 'after' ? num(after) : cnt;
    const start = at;
    let out = bytes;
    for (const f of files) { out = await c.insertPagesFrom(out, f.bytes, range(f.pages), at); at += f.pages; }
    return { bytes: out, map: shiftMap(cnt, start, at - start), select: range(at - start, start) };
  });
}

// ---------------------------------------------------------------- Split…
function splitParts(str) { return str.split(str.includes(';') ? ';' : ',').map((s) => s.trim()); }
export async function splitDialog(tab = activeTab()) {
  if (!editable(tab)) return;
  const n = tab.numPages;
  const err = errEl();
  const ranges = h('input.input', { type: 'text', id: 'pt-split-ranges', placeholder: 'e.g. 1-3,5,8-', 'aria-label': 'Page ranges' });
  const every = h('input.input', { type: 'number', min: '1', max: String(n), value: '1', id: 'pt-split-every', 'aria-label': 'Pages per file' });
  const form = h('div.pt-form', {},
    h('p.pt-hint', {}, `"${tab.name}" has ${n} pages. Each part is saved as a separate PDF named ${baseName(tab)}-part-1.pdf, -part-2.pdf, …`),
    h('fieldset.pt-fieldset', {}, h('legend', {}, 'Split by'),
      radio('pt-split-mode', 'ranges', 'Page ranges', true, ranges),
      h('small.pt-hint.pt-indent', {}, 'One file per comma-separated range ("1-3,5,8-" makes 3 files). Use ";" to group several ranges into one file ("1-2,4;5-").'),
      radio('pt-split-mode', 'every', 'Every', false, h('span.pt-inline', {}, every, ' pages'))),
    err);
  ranges.addEventListener('focus', () => { form.querySelector('input[value="ranges"]').checked = true; });
  every.addEventListener('focus', () => { form.querySelector('input[value="every"]').checked = true; });
  let parts = null;
  const c = await core();
  const v = await showDialog({
    title: 'Split PDF', body: form, className: 'pt-dialog', initialFocus: '#pt-split-ranges',
    buttons: [CANCEL, { label: 'Split', value: 'ok', primary: true, validate: (dlg) => {
      if (radioValue(dlg, 'pt-split-mode') === 'every') {
        const k = num(every);
        if (!Number.isInteger(k) || k < 1 || k > n) return setErr(err, `Enter a number of pages from 1 to ${n}.`, every);
        parts = range(Math.ceil(n / k)).map((p) => `${p * k + 1}-${Math.min(n, (p + 1) * k)}`);
      } else {
        const s = ranges.value.trim();
        if (!s) return setErr(err, 'Enter at least one page range, for example 1-3,5,8-.', ranges);
        parts = splitParts(s);
        for (const p of parts) {
          try { c.parseRanges(p, n); } catch (e) { return setErr(err, `"${p || '(empty)'}" is not a valid range for a ${n}-page document: ${e.message}`, ranges); }
        }
      }
      return setErr(err, null);
    } }],
  });
  if (v !== 'ok') return;
  try {
    const outs = await c.splitPdf(tab.bytes, parts);
    let saved = 0;
    for (let k = 0; k < outs.length; k++) {
      const res = await window.api.saveFile({ defaultPath: `${baseName(tab)}-part-${k + 1}.pdf`, filters: PDF_FILTER, bytes: outs[k].bytes });
      if (!res) break;
      saved++;
      toast(`Saved part ${k + 1} of ${outs.length}`, { timeout: 1600 });
    }
    toast(saved === outs.length ? `Split into ${saved} files` : `Split stopped: ${saved} of ${outs.length} files saved`);
  } catch (e) { showError('Could not split the document', e); }
}

// ---------------------------------------------------------------- Crop pages…
export async function cropDialog(tab = activeTab()) {
  if (!editable(tab)) return;
  const sel = sorted(thumbs.selection);
  const err = errEl();
  const m = Object.fromEntries(['top', 'right', 'bottom', 'left'].map((k) => [k, h('input.input', { type: 'number', min: '0', step: 'any', value: '0', id: `pt-crop-${k}` })]));
  const unit = h('select.input', { id: 'pt-crop-unit' }, h('option', { value: 'mm' }, 'mm'), h('option', { value: 'pt' }, 'pt (1/72 in)'));
  const form = h('div.pt-form', {},
    h('p.pt-hint', {}, 'Margins are trimmed from the page as displayed. The hidden area stays in the file (this is not redaction).'),
    h('div.pt-margins', {}, ...['top', 'right', 'bottom', 'left'].map((k) => field(k[0].toUpperCase() + k.slice(1), m[k]))),
    field('Unit', unit),
    h('fieldset.pt-fieldset', {}, h('legend', {}, 'Apply to'),
      radio('pt-crop-to', 'current', `Current page (${tab.currentPage + 1})`, !sel.length || sel.length === 1),
      radio('pt-crop-to', 'selected', sel.length ? `Selected pages (${sel.length})` : 'Selected pages (none selected)', sel.length > 1),
      radio('pt-crop-to', 'all', `All pages (${tab.numPages})`, false)),
    err);
  if (!sel.length) form.querySelector('input[value="selected"]').disabled = true;
  let margins = null, targets = null;
  const v = await showDialog({
    title: 'Crop pages', body: form, className: 'pt-dialog', initialFocus: '#pt-crop-top',
    buttons: [CANCEL, { label: 'Crop', value: 'ok', primary: true, validate: (dlg) => {
      const f = unit.value === 'mm' ? MM : 1;
      margins = {};
      for (const k of ['top', 'right', 'bottom', 'left']) {
        const x = num(m[k]);
        if (!Number.isFinite(x) || x < 0) return setErr(err, `${k[0].toUpperCase() + k.slice(1)} margin must be a number of 0 or more.`, m[k]);
        margins[k] = x * f;
      }
      if (!Object.values(margins).some((x) => x > 0)) return setErr(err, 'Enter at least one margin greater than 0.', m.top);
      const to = radioValue(dlg, 'pt-crop-to');
      targets = to === 'all' ? range(tab.numPages) : to === 'selected' ? sel : [tab.currentPage];
      for (const i of targets) {
        const s = app.viewer.pageSize(tab, i);
        if (s.width - margins.left - margins.right < 1 || s.height - margins.top - margins.bottom < 1) {
          return setErr(err, `The margins are larger than page ${i + 1} (${(s.width / f).toFixed(1)} × ${(s.height / f).toFixed(1)} ${unit.value}).`, m.left);
        }
      }
      return setErr(err, null);
    } }],
  });
  if (v !== 'ok') return;
  return runOp(tab, 'Crop pages', async (bytes, n, c) => ({ bytes: await c.cropPages(bytes, targets, margins), map: shiftMap(n, n, 0), select: targets.length < n ? targets : null }));
}

// ---------------------------------------------------------------- Edit properties…
export async function propertiesDialog(tab = activeTab()) {
  if (!editable(tab)) return;
  let md;
  try { md = await (await core()).getMetadata(tab.bytes); } catch (e) { showError('Could not read the document properties', e); return; }
  const inputs = Object.fromEntries(['title', 'author', 'subject', 'keywords'].map((k) => [k, h('input.input', { type: 'text', id: `pt-meta-${k}`, value: md[k] ?? '' })]));
  const form = h('div.pt-form', {},
    field('Title', inputs.title), field('Author', inputs.author), field('Subject', inputs.subject),
    field('Keywords', inputs.keywords, 'Separate keywords with commas.'));
  const v = await showDialog({ title: 'Edit document properties', body: form, className: 'pt-dialog', buttons: [CANCEL, { label: 'Save properties', value: 'ok', primary: true }] });
  if (v !== 'ok') return;
  const vals = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value.trim()]));
  return runOp(tab, 'Edit properties', async (bytes, n, c) => ({ bytes: await c.setMetadata(bytes, vals), map: shiftMap(n, n, 0) }));
}

// ---------------------------------------------------------------- Images to PDF…
export async function imagesDialog() {
  const imgs = [];
  const list = fileList(imgs, 'Images', (f) => f.type.toUpperCase());
  const err = errEl();
  const add = h('button.btn', { type: 'button', id: 'pt-img-add' }, 'Add images…');
  add.addEventListener('click', () => {
    window.api.openFiles({ filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }], multiple: true }).then(async (files) => {
      for (const f of files ?? []) {
        const name = f.name ?? String(f.path).split(/[\\/]/).pop();
        const ext = name.split('.').pop().toLowerCase();
        if (!['png', 'jpg', 'jpeg'].includes(ext)) { setErr(err, `"${name}" is not a PNG or JPG image.`); continue; }
        imgs.push({ name, type: ext === 'png' ? 'png' : 'jpg', bytes: f.bytes instanceof Uint8Array ? f.bytes : await window.api.readFile(f.path) });
      }
      list.render();
    }).catch((e) => setErr(err, e.message));
  });
  const size = h('select.input', { id: 'pt-img-size' }, h('option', { value: 'fit' }, 'Fit to image'), h('option', { value: 'A4' }, 'A4'), h('option', { value: 'Letter' }, 'Letter'));
  const form = h('div.pt-form', {}, h('p.pt-hint', {}, 'One page per image, in the order listed. The result opens in a new tab.'),
    h('div.pt-row', {}, add), list.ul, field('Page size', size), err);
  const v = await showDialog({
    title: 'Images to PDF', body: form, className: 'pt-dialog', initialFocus: '#pt-img-add',
    buttons: [CANCEL, { label: 'Create PDF', value: 'ok', primary: true, validate: () => (imgs.length ? setErr(err, null) : setErr(err, 'Add at least one PNG or JPG image.', add)) }],
  });
  if (v !== 'ok') return;
  try {
    const bytes = await (await core()).imagesToPdf(imgs.map(({ bytes, type }) => ({ bytes, type })), { pageSize: size.value, margin: size.value === 'fit' ? 0 : 18 });
    return await app.openBytes({ name: `${imgs[0].name.replace(/\.[^.]+$/, '')}${imgs.length > 1 ? '-images' : ''}.pdf`, bytes });
  } catch (e) { showError('Could not create the PDF from images', e); }
}

// ---------------------------------------------------------------- Insert pages from another PDF…
export async function insertFromDialog(tab = activeTab()) {
  if (!editable(tab)) return;
  const n = tab.numPages;
  let src = null;
  const err = errEl();
  const chosen = h('span.pt-file-name', { id: 'pt-ins-file' }, 'No file chosen');
  const pick = h('button.btn', { type: 'button', id: 'pt-ins-pick' }, 'Choose PDF…');
  pick.addEventListener('click', () => {
    pickPdfs(false).then(([f]) => { if (f) { src = f; chosen.textContent = `${f.name} (${pagesLabel(f)})`; setErr(err, null); } })
      .catch((e) => setErr(err, e.message));
  });
  const pages = h('input.input', { type: 'text', id: 'pt-ins-pages', placeholder: 'All pages' });
  const after = h('input.input', { type: 'number', min: '0', max: String(n), value: String(n), id: 'pt-ins-after' });
  const form = h('div.pt-form', {}, h('div.pt-row', {}, pick, chosen),
    field('Pages to insert', pages, 'Leave empty for all pages, or enter ranges such as 1-3,5.'),
    field('Insert after page', after, `0 inserts before page 1; ${n} appends at the end.`), err);
  let idx = null, at = null;
  const c = await core();
  const v = await showDialog({
    title: 'Insert pages from PDF', body: form, className: 'pt-dialog', initialFocus: '#pt-ins-pick',
    buttons: [CANCEL, { label: 'Insert', value: 'ok', primary: true, validate: () => {
      if (!src) return setErr(err, 'Choose the PDF to insert pages from.', pick);
      try { idx = pages.value.trim() ? c.parseRanges(pages.value, src.pages) : range(src.pages); } catch (e) { return setErr(err, `Pages: ${e.message}`, pages); }
      at = num(after);
      if (!Number.isInteger(at) || at < 0 || at > n) return setErr(err, `Enter a page number from 0 to ${n}.`, after);
      return setErr(err, null);
    } }],
  });
  if (v !== 'ok') return;
  return runOp(tab, 'Insert pages', async (bytes, cnt, cc) => ({
    bytes: await cc.insertPagesFrom(bytes, src.bytes, idx, Math.min(at, cnt)), map: shiftMap(cnt, Math.min(at, cnt), idx.length), select: range(idx.length, Math.min(at, cnt)),
  }));
}

// ---------------------------------------------------------------- init
/** Wire page tools into the shell. `appApi` is the object exported as window.ashStudio. */
export function initPageTools(appApi) {
  app = appApi;
  thumbs.onContext((e, info) => openContext(e, info));
  const M = app.registerMenuItem;
  const withTab = (fn) => () => { const t = activeTab(); if (t) fn(t); };
  // enabled(): no document → disabled; read-only → disabled with an explanatory tooltip.
  const item = (menu, def, extra = () => true) => {
    const it = { ...def };
    it.enabled = () => {
      const t = activeTab();
      const ok = editable(t) && extra(t);
      if (it.el) it.el.title = t?.readOnly ? RO_TIP : '';
      return ok;
    };
    M(menu, it);
  };
  M('File', { separator: true });
  item('File', { id: 'merge', label: 'Merge PDFs…', action: withTab(mergeDialog) });
  item('File', { id: 'split', label: 'Split PDF…', action: withTab(splitDialog) });
  M('File', { id: 'images-to-pdf', label: 'Images to PDF…', action: () => imagesDialog() });
  M('Edit', { separator: true });
  item('Edit', { id: 'undo-pages', label: 'Undo page change', action: withTab(undo) }, (t) => !!t.bytesUndo?.length);
  item('Edit', { id: 'redo-pages', label: 'Redo page change', action: withTab(redo) }, (t) => !!t.bytesRedo?.length);
  M('Tools', { separator: true });
  item('Tools', { id: 'insert-pages', label: 'Insert pages from PDF…', action: withTab(insertFromDialog) });
  item('Tools', { id: 'crop', label: 'Crop pages…', action: withTab(cropDialog) });
  item('Tools', { id: 'edit-properties', label: 'Edit properties…', action: withTab(propertiesDialog) });
  app.pageTools = { runOp, undo, redo, rotate, deletePages, insertBlank, duplicate, reorder, move, mergeDialog, splitDialog, cropDialog, propertiesDialog, imagesDialog, insertFromDialog };
}
