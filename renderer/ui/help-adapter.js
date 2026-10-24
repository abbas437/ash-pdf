// ASH PDF Studio side of the in-app help (renderer/help/help-engine.js is app-agnostic).
// Help menu: User guide (F1), Guided tours…; F1 context help via data-help and help/context*.json;
// dialogs get data-help and a "?" (dialogs.js setDialogDecorator); tours hear app events (helpEvent).
import data from '../help/help-data.js';
import { initHelp, openHelp, helpEvent, helpButton, maybeWelcome } from '../help/help-engine.js';
import { setDialogDecorator } from './dialogs.js';

const BTN = {
  open: '#btn-open', save: '#btn-save', saveas: '#btn-saveas', print: '#btn-print', prev: '#btn-prev', next: '#btn-next',
  zoomout: '#btn-zoomout', zoomin: '#btn-zoomin', rotl: '#btn-rotl', rotr: '#btn-rotr', find: '#btn-find', sidebar: '#btn-sidebar',
  theme: '#theme-toggle', page: 'input.page-input', zoom: 'select.zoom-select', pages: '[data-tb-item="pages"]', sign: '[data-tb-item="sign"]',
  split: '#btn-split', more: '.tb-more-btn', undo: '#btn-undo', redo: '#btn-redo',
};
const PANEL = {
  'options-bar': '.options-bar', sidebar: 'aside.sidebar', thumbnails: '#sb-tab-thumbs', bookmarks: '#sb-tab-outline', comments: '[data-sb-tab="comments"]',
  tabs: '.tabstrip', viewer: '.viewer-host', toolbar: '.toolbar .tb-tools', menubar: '.menubar', statusbar: '.statusbar',
};

/** Selector for a target id: tool:<id>, btn:<name>, panel:<name>, menu:<Name>, bar:text-format, or a bare name. */
function selectorFor(id) {
  const [kind, name] = id.includes(':') ? [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)] : ['', id];
  if (kind === 'tool') return `[data-tool="${CSS.escape(name)}"]`;
  if (kind === 'btn') return BTN[name];
  if (kind === 'panel') return PANEL[name];
  if (kind === 'menu') return `.menu-btn[data-menu="${CSS.escape(name)}"]`;
  if (kind === 'bar' && name === 'text-format') return '.text-format-bar';
  if (!kind) return BTN[name] ?? PANEL[name] ?? (document.querySelector(`[data-tool="${CSS.escape(name)}"]`) ? `[data-tool="${CSS.escape(name)}"]` : undefined);
  return undefined;
}

/** A visible stand-in for a hidden control: the More button, a folded group's caret, the menu's button. */
function fallback(id, el) {
  if (!el) return null;
  if (el.closest('.tb-more-panel')) return document.querySelector('.tb-more-btn');
  if (el.hasAttribute('data-tb-folded')) return el.closest('.tb-cg')?.querySelector('.tb-cg-caret') ?? el.closest('.tb-cg');
  const menu = el.closest('.menu[hidden]');
  if (menu) return menu.parentElement?.querySelector('.menu-btn');
  return null;
}

/** Context help from help/context*.json selector keys: the deepest matching element wins. */
function contextOf(el) {
  let best = null, depth = -1;
  for (const [sel, ref] of Object.entries(data.context ?? {})) {
    if (sel.startsWith('dialog:')) continue;
    let m;
    try { m = el.closest(sel); } catch { continue; }
    if (!m) continue;
    let d = 0;
    for (let n = m; n; n = n.parentElement) d++;
    if (d > depth) { best = ref; depth = d; }
  }
  return best;
}

/** Topic for a dialog title: an exact "dialog:<Title>" key, else a "dialog:<Prefix>*" key. */
function dialogTopic(title) {
  const ctx = data.context ?? {};
  if (ctx[`dialog:${title}`]) return ctx[`dialog:${title}`];
  for (const [k, v] of Object.entries(ctx)) if (k.startsWith('dialog:') && k.endsWith('*') && title.startsWith(k.slice(7, -1))) return v;
  return null;
}

export function initHelpAdapter({ registerMenuItem, bus, api, showShortcuts }) {
  const known = new Set(data.topics.map((t) => t.id));
  initHelp({
    appName: 'ASH PDF Studio',
    data,
    targets: new Proxy({}, { get: (_, id) => (typeof id === 'string' ? selectorFor(id) : undefined) }),
    fallback,
    contextOf,
    getPref: (k) => api.settingsGet(k),
    setPref: (k, v) => api.settingsSet(k, v),
    openUrl: (url) => api.openExternal(url),
    top: () => document.querySelector('header.titlebar')?.getBoundingClientRect().bottom ?? 0,
    home: known.has('welcome') ? 'welcome' : data.topics[0]?.id,
  });
  setDialogDecorator(({ dialog, titleEl, title, help }) => {
    const ref = help ?? dialogTopic(title);
    if (!ref || !known.has(String(ref).split('/')[0])) return;
    dialog.setAttribute('data-help', ref);
    titleEl.append(helpButton(ref));
  });
  registerMenuItem('Help', { id: 'guide', label: 'User guide', shortcut: 'F1', action: () => openHelp() });
  if (data.tours?.length) registerMenuItem('Help', { id: 'tours', label: 'Guided tours…', action: () => openHelp() });
  registerMenuItem('Help', { separator: true });
  bus.on('tool:changed', ({ tool }) => helpEvent(`tool:${tool}`));
  bus.on('tab:opened', () => helpEvent('file:opened'));
  bus.on('file:saved', () => helpEvent('file:saved'));
  bus.on('annotations:changed', () => helpEvent('annotation:added'));
  return {
    openTopic: (id) => (known.has(id) ? (openHelp(id), true) : false),
    // First start only (pref help.welcomeShown); not under test automation unless a test asks for it.
    welcome: () => { if (!navigator.webdriver || window.__ashHelpWelcome) maybeWelcome(); },
    showShortcuts,
  };
}
