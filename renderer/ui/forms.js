// AcroForm filling: HTML controls over the page overlays, an info bar, Tools-menu items,
// the Forms tool, and a beforeSave hook that writes the typed values with the core library.
//
// Geometry: every control is positioned in visible page space (points) with
// calc(var(--scale-factor) * Npx), where --scale-factor (CSS px per point) is set on each
// div.page by the viewer, so zoom needs no re-render. div.form-layer is rotated for the view
// rotation exactly like svg.overlay-svg (styles.css).
//
// tab.forms = {fields, widgets: Map(name -> [{pageIndex, rect, buttonValue}]), values, ...}
// `values` holds the values the user changed since the document was opened (kept across
// reloads by field name); tab.bytes never carries them, they are written on save only.
import { bus } from '../bus.js';
import { state, activeTab, markDirty } from '../state.js';
import { h } from './dom.js';
import { viewer } from './viewer.js';
import { showDialog, showError, toast } from './dialogs.js';
import { registerTool } from './toolbar.js';

const FILLABLE = new Set(['text', 'checkbox', 'radio', 'dropdown', 'optionlist']);
let core = null;          // src/core module (loaded on first use, like app.js does)
let highlight = true;     // light-blue field highlight
let bar = null;
let barText = null;
let barHighlight = null;
const loadCore = async () => (core ??= await import('../../src/core/index.js'));

/** initForms({registerMenuItem}) — called once by app.js. */
export function initForms({ registerMenuItem }) {
  document.body.classList.toggle('forms-highlight', highlight);
  barText = h('span.forms-bar-text');
  barHighlight = h('button.btn.forms-bar-hl', { type: 'button', 'aria-pressed': String(highlight), onclick: () => setHighlight(!highlight) }, 'Highlight fields');
  bar = h('div.forms-bar', { role: 'region', 'aria-label': 'Form fields', hidden: true },
    barText, barHighlight,
    h('button.btn.forms-bar-flatten', { type: 'button', onclick: () => flattenDialog() }, 'Flatten form…'),
    h('button.btn.forms-bar-close', { type: 'button', title: 'Hide this bar', 'aria-label': 'Hide this bar', onclick: () => { const t = activeTab(); if (t?.forms) t.forms.barDismissed = true; updateBar(); } }, '×'));
  (document.querySelector('.banner') ?? document.querySelector('.toolbar'))?.after(bar);

  const hasForm = () => (activeTab()?.forms?.fields.length ?? 0) > 0;
  registerMenuItem('Tools', { separator: true });
  registerMenuItem('Tools', { id: 'forms-highlight', label: 'Highlight fields', action: () => setHighlight(!highlight), enabled: hasForm });
  registerMenuItem('Tools', { id: 'forms-reset', label: 'Reset form', action: () => resetForm(activeTab()), enabled: hasForm });
  registerMenuItem('Tools', { id: 'forms-flatten', label: 'Flatten form…', action: () => flattenDialog(), enabled: hasForm });

  registerTool({
    id: 'forms', label: 'Forms', icon: 'forms', cursor: 'auto',
    onActivate: () => setHighlight(true),
    options: (container) => {
      const n = activeTab()?.forms?.fields.length ?? 0;
      container.append(h('span.opt', {}, n ? `${n} form field${n === 1 ? '' : 's'}` : 'No form fields'),
        h('button.btn', { type: 'button', disabled: !n, onclick: () => resetForm(activeTab()) }, 'Reset form'),
        h('button.btn', { type: 'button', disabled: !n, onclick: () => flattenDialog() }, 'Flatten form…'));
    },
  });

  // Runs first so annotation flattening (registered later, pushed) sees the filled bytes.
  state.hooks.beforeSave.unshift(saveHook);

  bus.on('tab:loaded', ({ tab }) => loadFields(tab));
  bus.on('tab:activated', updateBar);
  bus.on('tab:closed', updateBar);
  bus.on('page:rendered', ({ tab, pageIndex }) => { if (tab.forms && !layerOk(tab, pageIndex)) renderPage(tab, pageIndex); });
  bus.on('rotation:changed', ({ tab }) => { for (let i = 0; i < tab.numPages; i++) layerOf(tab, i)?.setAttribute('data-view-rotation', String(tab.viewRotation)); });
  bus.on('tool:changed', ({ tool }) => document.body.classList.toggle('forms-inert', tool !== 'select' && tool !== 'forms'));
}

// ---------------------------------------------------------------- loading
async function loadFields(tab) {
  const token = (tab.formsToken = (tab.formsToken ?? 0) + 1);
  const keep = tab.forms?.values ?? {};
  try {
    if (tab.readOnly) { tab.forms = null; return; }
    const { listFields } = await loadCore();
    const fields = await listFields(tab.bytes);
    const widgets = await collectWidgets(tab, fields);
    if (token !== tab.formsToken || !tab.view) return;
    const names = new Set(fields.map((f) => f.name));
    const values = Object.fromEntries(Object.entries(keep).filter(([k]) => names.has(k)));
    tab.forms = fields.length ? { fields, widgets, values, byName: new Map(fields.map((f) => [f.name, f])) } : null;
  } catch (err) {
    console.warn('[forms] could not list form fields', err);
    if (token === tab.formsToken) tab.forms = null;
  } finally {
    if (token === tab.formsToken) {
      for (let i = 0; i < tab.numPages; i++) renderPage(tab, i);
      updateBar();
    }
  }
}

/** Widget rectangles per field name from pdf.js (every widget, every page), visible page space. */
async function collectWidgets(tab, fields) {
  const map = new Map(fields.map((f) => [f.name, []]));
  if (!fields.length) return map;
  const perPage = await Promise.all(tab.pages.map((p) => p.getAnnotations({ intent: 'display' }).catch(() => [])));
  perPage.forEach((annots, i) => {
    const vp = tab.pages[i].getViewport({ scale: 1 });
    for (const a of annots) {
      if (a.subtype !== 'Widget' || !map.has(a.fieldName) || (a.annotationFlags & 2)) continue;
      const [x1, y1] = vp.convertToViewportPoint(a.rect[0], a.rect[1]);
      const [x2, y2] = vp.convertToViewportPoint(a.rect[2], a.rect[3]);
      map.get(a.fieldName).push({ pageIndex: i, rect: { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) }, buttonValue: a.buttonValue ?? null });
    }
  });
  for (const f of fields) if (!map.get(f.name).length && f.pageIndex >= 0 && f.rect) map.get(f.name).push({ pageIndex: f.pageIndex, rect: f.rect, buttonValue: null });
  return map;
}

// ---------------------------------------------------------------- values
function valueOf(tab, f) { return Object.hasOwn(tab.forms.values, f.name) ? tab.forms.values[f.name] : f.value; }

function setValue(tab, f, value) {
  tab.forms.values[f.name] = value;
  markDirty(tab);
  syncField(tab, f);
}

/** Which radio option a widget stands for: its on-state name, or /Opt index (pdf-lib style). */
function radioOption(f, w, k) {
  const opts = f.options ?? [];
  if (w.buttonValue != null && opts.includes(w.buttonValue)) return w.buttonValue;
  if (w.buttonValue != null && /^\d+$/.test(w.buttonValue) && opts[Number(w.buttonValue)] != null) return opts[Number(w.buttonValue)];
  return opts[k] ?? w.buttonValue ?? String(k);
}

// ---------------------------------------------------------------- rendering
const px = (n) => `calc(var(--scale-factor) * ${Math.round(n * 1000) / 1000}px)`;
function layerOf(tab, i) { return viewer.getOverlayEl(tab, i)?.querySelector(':scope > .form-layer') ?? null; }
function layerOk(tab, i) { const l = layerOf(tab, i); return !!l && l.dataset.formsToken === String(tab.formsToken); }

function renderPage(tab, i) {
  const overlay = viewer.getOverlayEl(tab, i);
  if (!overlay) return;
  layerOf(tab, i)?.remove();
  if (!tab.forms) return;
  const { width, height } = viewer.pageSize(tab, i);
  const layer = h('div.form-layer', { dataset: { formsToken: String(tab.formsToken), viewRotation: String(tab.viewRotation) }, style: { width: px(width), height: px(height) } });
  const items = [];
  for (const f of tab.forms.fields) {
    (tab.forms.widgets.get(f.name) ?? []).forEach((w, k) => { if (w.pageIndex === i) items.push({ f, w, k }); });
  }
  // Tab order = reading order: top-to-bottom (2 pt rows), then left-to-right.
  items.sort((a, b) => (Math.abs(a.w.rect.y - b.w.rect.y) > 2 ? a.w.rect.y - b.w.rect.y : a.w.rect.x - b.w.rect.x));
  for (const it of items) layer.append(...[makeControl(tab, it.f, it.w, it.k)].flat());
  overlay.append(layer);
}

function makeControl(tab, f, w, k) {
  const { x, y, w: cw, h: ch } = w.rect;
  const box = { left: px(x), top: px(y), width: px(cw), height: px(ch) };
  const label = f.name;
  const base = { dataset: { field: f.name, type: f.type }, 'aria-label': label, title: label, style: box };
  if (!FILLABLE.has(f.type)) {
    return h('div.form-ctl.form-unsupported', { ...base, 'aria-label': `${label}: not supported`, title: `${f.type === 'signature' ? 'Signature' : 'Button'} field "${label}": not supported`, role: 'note' });
  }
  const ro = !!f.readOnly;
  let el;
  if (f.type === 'text') {
    const fs = f.multiline ? Math.min(10, Math.max(6, ch * 0.6)) : Math.min(12, Math.max(5, ch * 0.62));
    el = h(f.multiline ? 'textarea.form-ctl.form-text' : 'input.form-ctl.form-text', { ...base, type: f.multiline ? null : 'text', readonly: ro, 'aria-readonly': ro ? 'true' : null, maxlength: f.maxLength ?? null, spellcheck: 'false' });
    el.style.fontSize = px(fs);
    el.value = valueOf(tab, f) ?? '';
    const warn = h('div.form-warn', { role: 'status', hidden: true, style: { left: px(x), top: px(y + ch + 1), minWidth: px(cw) } }, 'Some characters cannot be saved with the standard PDF font and will appear as "?".');
    el.addEventListener('input', () => { setValue(tab, f, el.value); checkWinAnsi(el.value, warn); });
    checkWinAnsi(el.value, warn);
    return [el, warn];
  }
  if (f.type === 'checkbox') {
    el = h('input.form-ctl.form-check', { ...base, type: 'checkbox', disabled: ro, 'aria-readonly': ro ? 'true' : null });
    el.checked = !!valueOf(tab, f);
    el.addEventListener('change', () => setValue(tab, f, el.checked));
    return el;
  }
  if (f.type === 'radio') {
    const opt = radioOption(f, w, k);
    el = h('input.form-ctl.form-radio', { ...base, type: 'radio', name: `${tab.id}::${f.name}`, value: opt, disabled: ro, 'aria-label': `${label}: ${opt}`, title: `${label}: ${opt}`, dataset: { field: f.name, type: f.type, option: opt } });
    el.checked = valueOf(tab, f) === opt;
    el.addEventListener('change', () => { if (el.checked) setValue(tab, f, opt); });
    return el;
  }
  // dropdown / optionlist
  const multi = f.type === 'optionlist';
  const cur = valueOf(tab, f);
  const selected = new Set([cur].flat().filter((v) => v != null && v !== ''));
  const opts = [...(f.options ?? [])];
  for (const v of selected) if (!opts.includes(v)) opts.push(v);
  el = h('select.form-ctl.form-select', { ...base, multiple: multi, disabled: ro, 'aria-readonly': ro ? 'true' : null },
    multi ? null : h('option', { value: '' }, ''),
    opts.map((o) => h('option', { value: o, selected: selected.has(o) }, o)));
  el.style.fontSize = px(Math.min(12, Math.max(5, multi ? 10 : ch * 0.6)));
  if (!multi) el.value = [...selected][0] ?? '';
  el.addEventListener('change', () => setValue(tab, f, multi ? [...el.selectedOptions].map((o) => o.value) : el.value));
  return el;
}

function checkWinAnsi(value, warn) {
  if (!core) return;
  const norm = String(value).replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
  warn.hidden = core.sanitizeText(norm) === norm;
}

/** Re-show a field's value in every widget of it (other pages / duplicates). */
function syncField(tab, f) {
  const v = valueOf(tab, f);
  for (let i = 0; i < tab.numPages; i++) {
    for (const el of layerOf(tab, i)?.querySelectorAll('.form-ctl') ?? []) {
      if (el.dataset.field !== f.name || el === document.activeElement) continue;
      if (f.type === 'text') el.value = v ?? '';
      else if (f.type === 'checkbox') el.checked = !!v;
      else if (f.type === 'radio') el.checked = v === el.dataset.option;
      else if (f.type === 'dropdown') el.value = v ?? '';
      else if (f.type === 'optionlist') for (const o of el.options) o.selected = [v].flat().includes(o.value);
    }
  }
}

// ---------------------------------------------------------------- highlight / bar
function setHighlight(on) {
  highlight = !!on;
  document.body.classList.toggle('forms-highlight', highlight);
  barHighlight?.setAttribute('aria-pressed', String(highlight));
}

function updateBar() {
  if (!bar) return;
  const tab = activeTab();
  const n = tab?.forms?.fields.length ?? 0;
  bar.hidden = !n || !!tab.forms.barDismissed;
  barText.textContent = `This document has fillable fields — ${n} field${n === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------- reset / flatten / save
function resetForm(tab) {
  if (!tab?.forms) return;
  const empty = { text: '', checkbox: false, radio: null, dropdown: '', optionlist: [] };
  for (const f of tab.forms.fields) if (FILLABLE.has(f.type) && !f.readOnly) tab.forms.values[f.name] = empty[f.type];
  markDirty(tab);
  for (let i = 0; i < tab.numPages; i++) renderPage(tab, i);
  toast('Form reset');
}

async function flattenDialog(tab = activeTab()) {
  if (!tab?.forms || tab.readOnly) return;
  const ok = await showDialog({
    title: 'Flatten form',
    body: 'Flattening draws the current field values into the pages and removes the form fields. The fields can no longer be edited. Continue?',
    buttons: [{ label: 'Cancel', value: 'cancel', cancel: true }, { label: 'Flatten', value: 'flatten', primary: true }],
  });
  if (ok !== 'flatten') return;
  try {
    const { fillFields } = await loadCore();
    const newBytes = await fillFields(tab.bytes, tab.forms.values, { flatten: true });
    tab.forms = null;
    for (let i = 0; i < tab.numPages; i++) layerOf(tab, i)?.remove();
    updateBar();
    tab.bytes = newBytes;
    markDirty(tab);
    bus.emit('tab:bytesChanged', { tab });
  } catch (err) {
    showError('Could not flatten the form', err);
  }
}

// Transient, like the annotations hook: only the bytes being written get the values. tab.bytes
// stays the unfilled document and `values` is kept until the tab is closed, so a page-operation
// undo/redo (which swaps tab.bytes for a snapshot taken before this save) cannot drop them.
async function saveHook(tab, bytes = tab.bytes) {
  const forms = tab.forms;
  if (!forms || !Object.keys(forms.values).length) return undefined;
  const { fillFields } = await loadCore();
  return fillFields(bytes, forms.values, { flatten: false, updateAppearances: true });
}
saveHook.id = 'forms';
saveHook.transient = true;
