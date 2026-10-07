// ASH PDF Studio renderer entry: builds the shell (menus, tabs, toolbar, viewer, status bar)
// and wires documents, shortcuts, drag-and-drop and theme. See docs/UI-ARCHITECTURE.md.
import { bus } from './bus.js';
import { state, createTab, activeTab, markDirty } from './state.js';
import { h, $, isTyping, formatBytes } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { showDialog, showError, confirmDiscard, toast, dialogOpen } from './ui/dialogs.js';
import { viewer } from './ui/viewer.js';
import { buildToolbar, btn, registerTool, setTool, getTool } from './ui/toolbar.js';
import { initSidebar, registerSidebarTab, showSidebarTab, thumbs } from './ui/sidebar.js';
import { initSearch, search } from './ui/search.js';
import { initAnnotations, annotations } from './ui/annotations.js';
import { initShapeTools } from './ui/tools-shapes.js';
import { initForms } from './ui/forms.js';
import { initPageTools } from './ui/pagetools.js';

const api = window.api;
const root = document.getElementById('app');

// ---------------------------------------------------------------- shell
const menubar = h('nav.menubar', { role: 'menubar', 'aria-label': 'Application menu' });
const tabstrip = h('div.tabstrip', { role: 'tablist', 'aria-label': 'Open documents' });
const toolbar = h('div.toolbar');
const optionsBar = h('div.options-bar', { hidden: true });
const banner = h('div.banner', { role: 'status', hidden: true });
const viewerHost = h('main.viewer-host', { 'aria-label': 'Document viewer' });
const welcome = h('div.welcome', {},
  h('div.welcome-card', {},
    h('div.welcome-mark', { html: icon('pages', 40) }),
    h('h1', {}, 'ASH PDF Studio'),
    h('p', {}, 'ASH PDF Studio is ready. Open a PDF or drop files here.'),
    h('button.btn.primary', { type: 'button', onclick: () => openDialog() }, 'Open PDF…')));
const status = {
  page: h('span.st-page'), zoom: h('span.st-zoom'), name: h('span.st-name'),
  dirty: h('span.st-dirty', { title: 'Unsaved changes', hidden: true }), badge: h('span.st-badge', { hidden: true }),
};
const statusbar = h('footer.statusbar', { role: 'status', 'aria-live': 'polite' }, status.page, status.zoom, status.dirty, status.name, status.badge);
const workArea = h('div.work', {}, viewerHost);
viewerHost.append(welcome);
root.append(h('header.titlebar', {}, menubar, tabstrip), toolbar, optionsBar, banner, workArea, statusbar);
viewer.mount(viewerHost);
initSidebar(workArea);
initSearch(viewerHost);

// ---------------------------------------------------------------- menus
const menus = new Map(); // name -> {button, list, items: []}
/** registerMenuItem('View', {id, label, shortcut, action, enabled?: () => bool, separator?}) */
export function registerMenuItem(menu, item) {
  let m = menus.get(menu);
  if (!m) {
    const button = h('button.menu-btn', { type: 'button', role: 'menuitem', 'aria-haspopup': 'true', 'aria-expanded': 'false' }, menu);
    const list = h('div.menu', { role: 'menu', 'aria-label': menu, hidden: true });
    const wrap = h('div.menu-wrap', {}, button, list);
    m = { button, list, items: [] };
    menus.set(menu, m);
    menubar.append(wrap);
    button.addEventListener('click', () => (list.hidden ? openMenu(menu) : closeMenus()));
    button.addEventListener('mouseenter', () => { if ([...menus.values()].some((x) => !x.list.hidden)) openMenu(menu); });
    button.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); openMenu(menu, true); } });
  }
  m.items.push(item);
  if (item.separator) { m.list.append(h('div.menu-sep', { role: 'separator' })); return; }
  const el = h('button.menu-item', { type: 'button', role: 'menuitem', dataset: { id: item.id ?? '' } }, h('span', {}, item.label), h('kbd', {}, item.shortcut ?? ''));
  el.addEventListener('click', () => { closeMenus(); if (!el.disabled) item.action?.(); });
  item.el = el;
  m.list.append(el);
}

function openMenu(name, focusFirst) {
  closeMenus();
  const m = menus.get(name);
  for (const it of m.items) if (it.el) it.el.disabled = it.enabled ? !it.enabled() : false;
  m.list.hidden = false;
  m.button.setAttribute('aria-expanded', 'true');
  if (focusFirst) m.list.querySelector('button:not([disabled])')?.focus();
}
function closeMenus() {
  for (const m of menus.values()) { m.list.hidden = true; m.button.setAttribute('aria-expanded', 'false'); }
}
menubar.addEventListener('keydown', (e) => {
  const names = [...menus.keys()];
  const openName = names.find((n) => !menus.get(n).list.hidden);
  if (e.key === 'Escape' && openName) { e.preventDefault(); closeMenus(); menus.get(openName).button.focus(); return; }
  if (!openName || !/^Arrow(Up|Down|Left|Right)$/.test(e.key)) return;
  e.preventDefault();
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const n = names[(names.indexOf(openName) + (e.key === 'ArrowRight' ? 1 : -1) + names.length) % names.length];
    openMenu(n, true); menus.get(n).button.focus(); openMenu(n, true);
    return;
  }
  const items = [...menus.get(openName).list.querySelectorAll('button:not([disabled])')];
  const k = items.indexOf(document.activeElement);
  items[(k + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
});
document.addEventListener('mousedown', (e) => { if (!menubar.contains(e.target)) closeMenus(); });

// ---------------------------------------------------------------- documents
const hasDoc = () => !!activeTab();

/** Open {name, path?, bytes} in a new tab. Returns the tab or null. */
export async function openBytes({ name, path = null, bytes }) {
  const tab = createTab({ name, path, bytes });
  try {
    await viewer.openDocument(tab);
  } catch (err) {
    if (!err?.cancelled) showError('Could not open the document', new Error(`"${name}": ${err?.message ?? err}`));
    return null;
  }
  state.tabs = [...state.tabs, tab];
  viewer.build(tab);
  bus.emit('tab:opened', { tab });
  activate(tab.id);
  return tab;
}

async function openFileObject(file) {
  try {
    const bytes = file.bytes instanceof Uint8Array ? file.bytes : await api.readFile(file.path);
    return await openBytes({ name: file.name ?? String(file.path).split(/[\\/]/).pop(), path: file.path ?? null, bytes });
  } catch (err) {
    showError('Could not open the file', err);
    return null;
  }
}

export function openDialog() {
  // No await before openFiles: the browser shim needs the user gesture for its file input.
  return api.openFiles({ filters: [{ name: 'PDF', extensions: ['pdf'] }], multiple: true })
    .then(async (files) => { for (const f of files ?? []) await openFileObject(f); })
    .catch((err) => showError('Could not open the file', err));
}

export function activate(id) {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return;
  state.activeId = id;
  welcome.hidden = true;
  viewer.activate(tab);
  bus.emit('tab:activated', { tab });
}

export async function closeTab(tab = activeTab()) {
  if (!tab) return false;
  if (tab.dirty) {
    activate(tab.id);
    const choice = await confirmDiscard(tab.name);
    if (choice === 'cancel' || choice == null) return false;
    if (choice === 'save' && !(await saveTab(tab, false))) return false;
  }
  const idx = state.tabs.indexOf(tab);
  viewer.destroy(tab);
  state.tabs = state.tabs.filter((t) => t !== tab);
  bus.emit('tab:closed', { tab });
  if (state.activeId === tab.id) {
    const next = state.tabs[Math.min(idx, state.tabs.length - 1)];
    if (next) activate(next.id);
    else { state.activeId = null; welcome.hidden = false; bus.emit('tab:activated', { tab: null }); }
  }
  return true;
}

/** Save (asNew=false, in place when the tab has a path) or Save As. Returns true when written. */
export async function saveTab(tab = activeTab(), asNew = false) {
  if (!tab) return false;
  if (tab.readOnly) { await showDialog({ title: 'Read-only document', body: 'This document is encrypted: viewing and printing only (editing is not supported).' }); return false; }
  try {
    let bytes = tab.bytes;
    for (const hook of state.hooks.beforeSave) {
      // hook(tab, bytesSoFar); a hook flagged `transient` changes only the written bytes, not tab.bytes.
      const out = await hook(tab, bytes);
      if (out instanceof Uint8Array) { bytes = out; if (!hook.transient) tab.bytes = out; }
    }
    let res;
    if (!asNew && tab.path && !String(tab.path).startsWith('dropped:')) res = await api.writeFile(tab.path, bytes);
    else res = await api.saveFile({ defaultPath: tab.name, filters: [{ name: 'PDF', extensions: ['pdf'] }], bytes });
    if (!res) return false;
    tab.path = res.path;
    tab.name = String(res.path).split(/[\\/]/).pop() || tab.name;
    markDirty(tab, false);
    renderTabs();
    toast(`Saved ${tab.name}`);
    return true;
  } catch (err) {
    showError('Could not save', err);
    return false;
  }
}

async function printTab(tab = activeTab()) {
  if (!tab) return;
  const host = h('div.print-container', { 'aria-hidden': 'true' });
  document.body.append(host);
  const urls = [];
  try {
    for (let i = 0; i < tab.numPages; i++) {
      const vp = tab.pages[i].getViewport({ scale: 150 / 72 });
      const c = document.createElement('canvas');
      c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      await tab.pages[i].render({ canvas: c, viewport: vp, intent: 'print' }).promise;
      const blob = await new Promise((r) => c.toBlob(r));
      c.width = 0; c.height = 0;
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const pt = tab.pages[i].getViewport({ scale: 1 });
      host.append(h('div.print-page', {}, h('img', { src: url, alt: '', style: { aspectRatio: `${pt.width} / ${pt.height}` } })));
    }
    document.body.classList.add('printing');
    await api.print();
  } catch (err) {
    showError('Could not print', err);
  } finally {
    document.body.classList.remove('printing');
    host.remove();
    for (const u of urls) URL.revokeObjectURL(u);
  }
}

async function showProperties(tab = activeTab()) {
  if (!tab) return;
  const info = tab.metadata?.info ?? {};
  let core = null;
  try { core = await (await import('../src/core/index.js')).getInfo(tab.bytes, tab.password ? { password: tab.password } : undefined); } catch { core = null; }
  const md = core?.metadata ?? {};
  const s = viewer.pageSize(tab, tab.currentPage);
  const rows = [
    ['Title', md.title ?? info.Title], ['Author', md.author ?? info.Author], ['Subject', md.subject ?? info.Subject],
    ['Producer', md.producer ?? info.Producer], ['Pages', tab.numPages],
    ['Page size', `${s.width.toFixed(1)} × ${s.height.toFixed(1)} pt (${(s.width / 72 * 25.4).toFixed(0)} × ${(s.height / 72 * 25.4).toFixed(0)} mm)`],
    ['File size', formatBytes(tab.bytes.length)], ['Encrypted', tab.encrypted ? 'Yes' : 'No'], ['File', tab.path ?? tab.name],
  ];
  const table = h('table.props', {}, rows.map(([k, v]) => h('tr', {}, h('th', { scope: 'row' }, k), h('td', {}, v == null || v === '' ? '—' : String(v)))));
  await showDialog({ title: 'Document properties', body: table, buttons: [{ label: 'Close', value: 'ok', primary: true, cancel: true }] });
}

// ---------------------------------------------------------------- tab strip
function renderTabs() {
  tabstrip.replaceChildren();
  for (const t of state.tabs) {
    const selected = t.id === state.activeId;
    const close = h('button.tab-close', { type: 'button', tabindex: '-1', title: 'Close (Ctrl+W)', 'aria-label': `Close ${t.name}`, html: icon('close', 14) });
    close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(t); });
    const el = h('div.doc-tab', { role: 'tab', tabindex: selected ? '0' : '-1', 'aria-selected': String(selected), title: t.path ?? t.name, dataset: { tabId: t.id } },
      t.encrypted ? h('span.tab-lock', { html: icon('lock', 13) }) : null,
      h('span.tab-name', {}, t.name), t.dirty ? h('span.tab-dirty', { 'aria-label': 'modified' }, '●') : null, close);
    el.addEventListener('click', () => activate(t.id));
    el.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t); } });
    el.addEventListener('keydown', (e) => {
      const k = state.tabs.indexOf(t);
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const n = state.tabs[(k + (e.key === 'ArrowRight' ? 1 : -1) + state.tabs.length) % state.tabs.length];
        activate(n.id);
        tabstrip.querySelector(`[data-tab-id="${n.id}"]`)?.focus();
      } else if (e.key === 'Delete') closeTab(t);
    });
    tabstrip.append(el);
  }
}

// ---------------------------------------------------------------- toolbar
const pageInput = h('input.page-input', { type: 'text', inputmode: 'numeric', 'aria-label': 'Page number', value: '' });
const pageTotal = h('span.page-total', {}, '/ 0');
pageInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const tab = activeTab();
  const n = parseInt(pageInput.value, 10);
  if (tab && n >= 1) viewer.scrollToPage(tab, Math.min(n, tab.numPages) - 1);
  tab?.view?.scrollEl.focus();
});
const zoomSelect = h('select.zoom-select', { 'aria-label': 'Zoom' },
  h('option', { value: 'custom', hidden: true }, '100%'),
  h('option', { value: 'fit-width' }, 'Fit width'), h('option', { value: 'fit-page' }, 'Fit page'),
  [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((z) => h('option', { value: String(z) }, `${z * 100}%`)));
zoomSelect.addEventListener('change', () => {
  const tab = activeTab();
  if (tab && zoomSelect.value !== 'custom') viewer.setZoom(tab, /^fit/.test(zoomSelect.value) ? zoomSelect.value : Number(zoomSelect.value));
});
const withTab = (fn) => () => { const t = activeTab(); if (t) fn(t); };
const themeBtn = btn('moon', 'Dark theme', () => setTheme(state.theme === 'dark' ? 'light' : 'dark'), { id: 'theme-toggle' });
const findBtn = btn('search', 'Find (Ctrl+F)', () => bus.emit('search:open', {}), { id: 'btn-find' });
buildToolbar(toolbar, [
  [btn('open', 'Open (Ctrl+O)', () => openDialog(), { id: 'btn-open' }), btn('save', 'Save (Ctrl+S)', withTab((t) => saveTab(t, false)), { id: 'btn-save' }),
    btn('saveAs', 'Save as (Ctrl+Shift+S)', withTab((t) => saveTab(t, true)), { id: 'btn-saveas' }), btn('print', 'Print (Ctrl+P)', withTab(printTab), { id: 'btn-print' })],
  [btn('prev', 'Previous page (Page Up)', withTab(viewer.prevPage), { id: 'btn-prev' }), btn('next', 'Next page (Page Down)', withTab(viewer.nextPage), { id: 'btn-next' }), h('span.page-box', {}, pageInput, pageTotal)],
  [btn('zoomOut', 'Zoom out (Ctrl+-)', withTab((t) => viewer.zoomOut(t)), { id: 'btn-zoomout' }), zoomSelect, btn('zoomIn', 'Zoom in (Ctrl+=)', withTab((t) => viewer.zoomIn(t)), { id: 'btn-zoomin' })],
  [btn('rotateLeft', 'Rotate view left', withTab((t) => viewer.rotateView(t, -90)), { id: 'btn-rotl' }), btn('rotateRight', 'Rotate view right', withTab((t) => viewer.rotateView(t, 90)), { id: 'btn-rotr' })],
  [findBtn, btn('sidebar', 'Toggle sidebar', () => { state.sidebarOpen = !state.sidebarOpen; }, { id: 'btn-sidebar' }), themeBtn],
], optionsBar);
// The Select tool is the default, always-available tool.
registerTool({ id: 'select', label: 'Select', icon: 'select', shortcut: 'V', cursor: 'auto' });
setTool('select');

// ---------------------------------------------------------------- status / chrome refresh
function refresh() {
  const tab = activeTab();
  renderTabs();
  const n = tab?.numPages ?? 0;
  pageInput.value = tab ? String(tab.currentPage + 1) : '';
  pageInput.disabled = !tab;
  pageTotal.textContent = `/ ${n}`;
  const pct = tab ? `${Math.round(tab.zoom * 100)}%` : '';
  zoomSelect.options[0].textContent = pct || '100%';
  zoomSelect.value = !tab ? 'custom' : tab.zoomMode !== 'custom' ? tab.zoomMode : ([...zoomSelect.options].some((o) => o.value === String(tab.zoom)) ? String(tab.zoom) : 'custom');
  status.page.textContent = tab ? `Page ${tab.currentPage + 1} of ${n}` : 'No document';
  status.zoom.textContent = pct;
  status.name.textContent = tab?.name ?? '';
  status.dirty.hidden = !tab?.dirty;
  status.badge.hidden = !tab?.readOnly;
  status.badge.textContent = tab?.readOnly ? 'Encrypted · read-only' : '';
  banner.hidden = !tab?.encrypted;
  banner.textContent = tab?.encrypted ? 'This document is encrypted: viewing and printing only (editing is not supported).' : '';
  api.setTitle(tab ? `${tab.dirty ? '• ' : ''}${tab.name}` : '');
  for (const id of ['btn-save', 'btn-saveas', 'btn-print', 'btn-prev', 'btn-next', 'btn-zoomout', 'btn-zoomin', 'btn-rotl', 'btn-rotr', 'btn-find']) $(`#${id}`).disabled = !tab;
  zoomSelect.disabled = !tab;
}
for (const ev of ['tab:opened', 'tab:closed', 'tab:activated', 'tab:dirtyChanged', 'page:changed', 'zoom:changed', 'tab:loaded']) bus.on(ev, refresh);
bus.on('state:changed', ({ key }) => { if (key === 'sidebarOpen') document.body.classList.toggle('sidebar-closed', !state.sidebarOpen); });

// ---------------------------------------------------------------- theme
async function setTheme(theme, persist = true) {
  state.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = state.theme;
  themeBtn.innerHTML = icon(state.theme === 'dark' ? 'sun' : 'moon');
  const label = state.theme === 'dark' ? 'Light theme' : 'Dark theme';
  themeBtn.title = label; themeBtn.setAttribute('aria-label', label);
  if (persist) await api.settingsSet('theme', state.theme);
  bus.emit('theme:changed', { theme: state.theme });
}

// ---------------------------------------------------------------- menus content
const zoomTo = (v) => withTab((t) => viewer.setZoom(t, v));
const M = registerMenuItem;
M('File', { id: 'open', label: 'Open…', shortcut: 'Ctrl+O', action: () => openDialog() });
M('File', { id: 'save', label: 'Save', shortcut: 'Ctrl+S', action: withTab((t) => saveTab(t, false)), enabled: hasDoc });
M('File', { id: 'saveas', label: 'Save as…', shortcut: 'Ctrl+Shift+S', action: withTab((t) => saveTab(t, true)), enabled: hasDoc });
M('File', { separator: true });
M('File', { id: 'print', label: 'Print…', shortcut: 'Ctrl+P', action: withTab(printTab), enabled: hasDoc });
M('File', { id: 'properties', label: 'Document properties', action: withTab(showProperties), enabled: hasDoc });
M('File', { separator: true });
M('File', { id: 'close', label: 'Close tab', shortcut: 'Ctrl+W', action: () => closeTab(), enabled: hasDoc });
M('Edit', { id: 'copy', label: 'Copy', shortcut: 'Ctrl+C', action: () => document.execCommand('copy') });
M('Edit', { id: 'find', label: 'Find…', shortcut: 'Ctrl+F', action: () => bus.emit('search:open', {}), enabled: hasDoc });
M('View', { id: 'zoomin', label: 'Zoom in', shortcut: 'Ctrl+=', action: withTab((t) => viewer.zoomIn(t)), enabled: hasDoc });
M('View', { id: 'zoomout', label: 'Zoom out', shortcut: 'Ctrl+-', action: withTab((t) => viewer.zoomOut(t)), enabled: hasDoc });
M('View', { id: 'fitwidth', label: 'Fit width', action: zoomTo('fit-width'), enabled: hasDoc });
M('View', { id: 'fitpage', label: 'Fit page', shortcut: 'Ctrl+0', action: zoomTo('fit-page'), enabled: hasDoc });
M('View', { id: 'actual', label: 'Actual size', shortcut: 'Ctrl+1', action: zoomTo(1), enabled: hasDoc });
M('View', { separator: true });
M('View', { id: 'rotl', label: 'Rotate view left', action: withTab((t) => viewer.rotateView(t, -90)), enabled: hasDoc });
M('View', { id: 'rotr', label: 'Rotate view right', action: withTab((t) => viewer.rotateView(t, 90)), enabled: hasDoc });
M('View', { separator: true });
M('View', { id: 'sidebar', label: 'Toggle sidebar', action: () => { state.sidebarOpen = !state.sidebarOpen; } });
M('View', { id: 'theme', label: 'Toggle light / dark theme', action: () => setTheme(state.theme === 'dark' ? 'light' : 'dark') });
M('Tools', { id: 'select', label: 'Select', shortcut: 'V', action: () => setTool('select') });
initForms({ registerMenuItem });
M('Help', { id: 'keys', label: 'Keyboard shortcuts', action: showShortcuts });
M('Help', { id: 'about', label: 'About ASH PDF Studio', action: async () => showDialog({ title: 'About ASH PDF Studio', body: `Version ${await api.version()}. Free and open source (MIT). Uses pdf.js (Apache-2.0) and pdf-lib (MIT).` }) });

function showShortcuts() {
  const keys = [['Ctrl+O', 'Open'], ['Ctrl+S / Ctrl+Shift+S', 'Save / Save as'], ['Ctrl+P', 'Print'], ['Ctrl+W', 'Close tab'], ['Ctrl+Tab', 'Next tab'],
    ['Ctrl+F', 'Find'], ['Ctrl+= / Ctrl+-', 'Zoom in / out'], ['Ctrl+0 / Ctrl+1', 'Fit page / Actual size'], ['Home / End', 'First / last page'], ['Page Up / Page Down', 'Previous / next page']];
  showDialog({ title: 'Keyboard shortcuts', body: h('table.props', {}, keys.map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v)))) });
}

// ---------------------------------------------------------------- keyboard
document.addEventListener('keydown', (e) => {
  if (dialogOpen()) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const tab = activeTab();
  const k = e.key.toLowerCase();
  const run = (fn) => { e.preventDefault(); fn(); };
  if (ctrl && k === 'o') return run(() => openDialog());
  if (ctrl && k === 's') return run(() => tab && saveTab(tab, e.shiftKey));
  if (ctrl && k === 'p') return run(() => tab && printTab(tab));
  if (ctrl && k === 'w') return run(() => tab && closeTab(tab));
  if (ctrl && k === 'f') return run(() => tab && bus.emit('search:open', {}));
  if (ctrl && e.key === 'Tab') return run(() => {
    if (state.tabs.length < 2) return;
    const i = state.tabs.indexOf(tab);
    activate(state.tabs[(i + (e.shiftKey ? -1 : 1) + state.tabs.length) % state.tabs.length].id);
  });
  if (!tab) return;
  if (ctrl && (k === '=' || k === '+')) return run(() => viewer.zoomIn(tab));
  if (ctrl && (k === '-' || k === '_')) return run(() => viewer.zoomOut(tab));
  if (ctrl && k === '0') return run(() => viewer.setZoom(tab, 'fit-page'));
  if (ctrl && k === '1') return run(() => viewer.setZoom(tab, 1));
  if (ctrl || e.altKey || isTyping(e.target)) return;
  if (e.key === 'Home') return run(() => viewer.scrollToPage(tab, 0));
  if (e.key === 'End') return run(() => viewer.scrollToPage(tab, tab.numPages - 1));
  if (e.key === 'PageDown') return run(() => viewer.nextPage(tab));
  if (e.key === 'PageUp') return run(() => viewer.prevPage(tab));
  if (e.key === 'Escape') closeMenus();
});

// Tool pointer dispatch: the active tool receives events on page overlays.
for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
  viewerHost.addEventListener(type, (e) => {
    const tool = getTool();
    const fn = tool?.[{ pointerdown: 'onPointerDown', pointermove: 'onPointerMove', pointerup: 'onPointerUp' }[type]];
    const tab = activeTab();
    if (!fn || !tab || !e.target.closest?.('.page')) return;
    fn(e, { tab, hit: viewer.clientToPage(tab, e.clientX, e.clientY), viewer });
  });
}
bus.on('tool:changed', ({ tool }) => { viewerHost.style.cursor = getTool(tool)?.cursor ?? ''; });

// ---------------------------------------------------------------- drag & drop, launch files
window.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); document.body.classList.add('drop-target'); } });
window.addEventListener('dragleave', (e) => { if (e.target === document.documentElement || !e.relatedTarget) document.body.classList.remove('drop-target'); });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  document.body.classList.remove('drop-target');
  const files = [...(e.dataTransfer?.files ?? [])].filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (!files.length && e.dataTransfer?.files?.length) toast('Only PDF files can be opened');
  for (const f of files) await openBytes({ name: f.name, path: null, bytes: new Uint8Array(await f.arrayBuffer()) });
});
window.addEventListener('beforeunload', (e) => { if (!api.isElectron && state.tabs.some((t) => t.dirty)) e.preventDefault(); });

bus.on('tab:dirtyChanged', refresh);

// ---------------------------------------------------------------- start-up
export const app = { state, bus, viewer, registerSidebarTab, showSidebarTab, thumbs, search, openBytes, openDialog, activate, closeTab, saveTab, printTab, showProperties, registerMenuItem, registerTool, setTool, showDialog, toast, markDirty, setTheme };
window.ashStudio = app;
initAnnotations();
initShapeTools();
app.annotations = annotations;
initPageTools(app);

(async () => {
  try {
    await setTheme((await api.settingsGet('theme')) ?? 'light', false);
  } catch { await setTheme('light', false); }
  refresh();
  api.onOpenFile((file) => openFileObject(file));
  try {
    for (const f of (await api.getLaunchFiles()) ?? []) await openFileObject(f);
  } catch (err) {
    showError('Could not open the start-up file', err);
  }
  document.body.dataset.ready = 'true';
})();
