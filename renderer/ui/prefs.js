// Edit > Preferences… (Ctrl+,): the user's default settings in one dialog, sectioned
// General / Documents / Annotations / Toolbar, plus View > Show tool labels.
//   initPrefs({ registerMenuItem, setTheme }) -> { openPrefs, loadPrefs }
//   prefsForNewTab() -> {zoomMode, zoom} for a tab about to be built
//   applySidebarOnOpen() after a document opened
// Values live in the settings store (api.settingsGet/Set); a copy is cached here so opening
// a document does not wait on IPC. See prefs-lib.js for defaults and cleaning.
import { bus } from '../bus.js';
import { state } from '../state.js';
import { h } from './dom.js';
import { showDialog } from './dialogs.js';
import { setAuthor, DEFAULT_AUTHOR } from './annotations.js';
import { PREF_DEFAULTS, cleanPref, initialZoom, shortLabel, AUTHOR_MAX } from './prefs-lib.js';

const api = window.api;
const cache = { ...PREF_DEFAULTS };
let lastZoom = null;   // 'view.lastZoom': 'fit-width' | 'fit-page' | number
let setThemeFn = null;
let labelsItem = null;

export async function loadPrefs() {
  const keys = Object.keys(PREF_DEFAULTS);
  const vals = await Promise.all([...keys, 'view.lastZoom'].map((k) => api.settingsGet(k).catch(() => undefined)));
  keys.forEach((k, i) => { cache[k] = cleanPref(k, vals[i]); });
  lastZoom = vals[keys.length] ?? null;
  return { ...cache };
}

export function prefsForNewTab() { return initialZoom(cache['view.defaultZoom'], lastZoom); }

export function applySidebarOnOpen() { state.sidebarOpen = cache['view.sidebarOnOpen']; }

const save = (key, value) => api.settingsSet(key, value).catch(() => {});

/** Show or hide the text under the toolbar icons (visual only; callers persist). */
function setToolLabels(on) {
  cache['ui.toolLabels'] = !!on;
  document.body.classList.toggle('tool-labels', !!on);
  labelsItem?.el?.setAttribute('aria-checked', String(!!on));
}

/** Keep data-label on every toolbar button in step with its tooltip (tools register later). */
function watchToolbarLabels(toolbar) {
  const sync = () => {
    for (const b of toolbar.querySelectorAll('button.tb-btn')) {
      const text = shortLabel(b.title || b.getAttribute('aria-label'));
      if (b.dataset.label !== text) b.dataset.label = text;
      // Buttons that already carry visible text (e.g. Sign) get no second label.
      b.classList.toggle('has-text', [...b.childNodes].some((n) => n.nodeType === 3 ? n.textContent.trim() : n.tagName === 'SPAN'));
    }
  };
  sync();
  new MutationObserver(sync).observe(toolbar, { subtree: true, childList: true, attributes: true, attributeFilter: ['title', 'aria-label'] });
}

// ---------------------------------------------------------------- dialog
const radios = (key, legend, options) => h('fieldset.prefs-group', {}, h('legend', {}, legend),
  options.map(([v, label]) => h('label.prefs-choice', {}, h('input', { type: 'radio', name: key, value: v }), h('span', {}, label))));
const select = (key, label, options) => h('label.prefs-field', {}, h('span', {}, label),
  h('select.input', { name: key }, options.map(([v, l]) => h('option', { value: v }, l))));
const check = (key, label) => h('label.prefs-choice', {}, h('input', { type: 'checkbox', name: key }), h('span', {}, label));

const SECTIONS = [
  ['general', 'General', () => [
    radios('theme', 'Theme', [['light', 'Light'], ['dark', 'Dark']]),
    radios('startup.mode', 'On start-up', [['ask', 'Ask'], ['restore', 'Restore last session'], ['new', 'Start empty']]),
    radios('open.target', 'Open files in', [['tab', 'New tab'], ['window', 'New window']]),
  ]],
  ['documents', 'Documents', () => [
    select('view.defaultZoom', 'Default zoom', [['fit-width', 'Fit width'], ['fit-page', 'Fit page'], ['1', '100 %'], ['last', 'Last used']]),
    check('view.sidebarOnOpen', 'Show the sidebar when a document opens'),
  ]],
  ['annotations', 'Annotations', () => [
    h('label.prefs-field', {}, h('span', {}, 'Author name'),
      h('input.input', { type: 'text', name: 'annotations.author', maxlength: String(AUTHOR_MAX), placeholder: DEFAULT_AUTHOR, autocomplete: 'off' })),
    select('stamps.shape', 'Default stamp shape', [['rect', 'Rectangle'], ['rounded', 'Rounded'], ['circle', 'Circle'], ['ellipse', 'Ellipse']]),
  ]],
  ['toolbar', 'Toolbar', () => [check('ui.toolLabels', 'Show tool labels under the icons')]],
];

function fill(root, values) {
  for (const [k, v] of Object.entries(values)) {
    for (const el of root.querySelectorAll(`[name="${k}"]`)) {
      if (el.type === 'radio') el.checked = el.value === String(v);
      else if (el.type === 'checkbox') el.checked = !!v;
      else el.value = String(v);
    }
  }
}

function read(root) {
  const out = {};
  for (const k of Object.keys(PREF_DEFAULTS)) {
    const els = [...root.querySelectorAll(`[name="${k}"]`)];
    const el = els.find((e) => e.type !== 'radio' || e.checked) ?? els[0];
    out[k] = cleanPref(k, el.type === 'checkbox' ? el.checked : el.value);
  }
  return out;
}

function buildBody() {
  const nav = h('div.prefs-nav', { role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': 'Preference sections' });
  const panels = h('div.prefs-panels');
  const tabs = [];
  const show = (id, focus) => {
    for (const t of tabs) {
      const on = t.dataset.section === id;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
    }
    for (const p of panels.children) p.hidden = p.dataset.section !== id;
  };
  for (const [id, label, controls] of SECTIONS) {
    const t = h('button.prefs-tab', { type: 'button', role: 'tab', id: `prefs-tab-${id}`, 'aria-controls': `prefs-panel-${id}`, dataset: { section: id }, onclick: () => show(id) }, label);
    tabs.push(t);
    nav.append(t);
    panels.append(h('div.prefs-panel', { role: 'tabpanel', id: `prefs-panel-${id}`, 'aria-labelledby': `prefs-tab-${id}`, dataset: { section: id } }, controls()));
  }
  nav.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const k = tabs.indexOf(document.activeElement);
    show(tabs[(k + (e.key === 'ArrowDown' ? 1 : -1) + tabs.length) % tabs.length].dataset.section, true);
  });
  const root = h('div.prefs', {}, nav, panels);
  show('general');
  fill(root, cache);
  return root;
}

async function applyPrefs(next) {
  await setThemeFn(next.theme); // switches and persists 'theme'
  setToolLabels(next['ui.toolLabels']);
  await save('ui.toolLabels', next['ui.toolLabels']);
  await save('startup.mode', next['startup.mode']);
  await save('open.target', next['open.target']);
  await save('view.defaultZoom', next['view.defaultZoom']);
  await save('view.sidebarOnOpen', next['view.sidebarOnOpen']);
  await setAuthor(next['annotations.author']).catch(() => {});
  await save('stamps.shape', next['stamps.shape']);
  Object.assign(cache, next);
  bus.emit('prefs:changed', { prefs: { ...cache } });
}

/** Show the dialog; resolves true when OK applied the values. */
export async function openPrefs() {
  await loadPrefs();
  let root = null;
  const v = await showDialog({
    title: 'Preferences',
    className: 'prefs-dlg',
    body: () => (root = buildBody()),
    initialFocus: '.prefs-tab',
    buttons: [
      { label: 'Reset to defaults', value: 'reset', validate: () => { fill(root, PREF_DEFAULTS); return false; } },
      { label: 'Cancel', value: 'cancel', cancel: true },
      { label: 'OK', value: 'ok', primary: true },
    ],
  });
  if (v !== 'ok') return false;
  await applyPrefs(read(root));
  return true;
}

export function initPrefs({ registerMenuItem, setTheme, toolbar }) {
  setThemeFn = setTheme;
  registerMenuItem('Edit', { separator: true });
  registerMenuItem('Edit', { id: 'prefs', label: 'Preferences…', shortcut: 'Ctrl+,', action: () => openPrefs() });
  labelsItem = { id: 'toollabels', label: 'Show tool labels', action: () => {
    setToolLabels(!cache['ui.toolLabels']);
    save('ui.toolLabels', cache['ui.toolLabels']);
  } };
  registerMenuItem('View', labelsItem);
  labelsItem.el.setAttribute('role', 'menuitemcheckbox');
  watchToolbarLabels(toolbar);
  // Remember the zoom in use for 'Last used' (debounced: zooming emits many events).
  let timer = 0;
  bus.on('zoom:changed', ({ tab, mode, zoom }) => {
    if (!tab) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      lastZoom = mode === 'custom' ? zoom : mode;
      save('view.lastZoom', lastZoom);
    }, 400);
  });
  return loadPrefs().then(() => setToolLabels(cache['ui.toolLabels']));
}
