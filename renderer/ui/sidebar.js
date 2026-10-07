// Left sidebar: a tab strip (Thumbnails / Outline / Search results, plus any tab added
// with registerSidebarTab) above one panel per tab. See docs/UI-ARCHITECTURE.md.
//
//   registerSidebarTab({ id, label, icon, render(container, tab) })
//     render() is called when the panel becomes visible, when the active document changes
//     and when the document is reloaded (tab:loaded {reloaded:true}) while it is visible.
//     `tab` is the active tab or null. The module may also redraw its own panel at any time.
import { bus } from '../bus.js';
import { state, activeTab } from '../state.js';
import { h } from './dom.js';
import { icon } from './icons.js';
import { viewer } from './viewer.js';
import { showExternalLink } from './dialogs.js';

const THUMB_W = 140;            // CSS px
const sidebarTabs = new Map();  // id -> {def, button, panel}
let root = null;
let strip = null;
let panels = null;

/** Create the sidebar and insert it as the first child of `workArea` (div.work). */
export function initSidebar(workArea) {
  strip = h('div.sb-tabs', { role: 'tablist', 'aria-label': 'Sidebar' });
  panels = h('div.sb-panels');
  root = h('aside.sidebar', { 'aria-label': 'Sidebar' }, strip, panels);
  workArea.prepend(root);
  strip.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const ids = [...sidebarTabs.keys()];
    const k = ids.indexOf(state.sidebarTab);
    const next = ids[(k + (e.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length];
    e.preventDefault();
    showSidebarTab(next);
    sidebarTabs.get(next).button.focus();
  });
  registerSidebarTab({ id: 'thumbs', label: 'Thumbnails', icon: 'thumbs', render: renderThumbs });
  registerSidebarTab({ id: 'outline', label: 'Outline', icon: 'outline', render: renderOutline });
  document.body.classList.toggle('sidebar-closed', !state.sidebarOpen);
  return root;
}

export const SIDEBAR_MIN = 160;
/** Set the sidebar width in CSS px, clamped to [SIDEBAR_MIN, 50 % of the window]; returns it. */
export function setSidebarWidth(px) {
  const w = Math.round(Math.min(window.innerWidth / 2, Math.max(SIDEBAR_MIN, Number(px) || 200)));
  root.style.width = `${w}px`;
  return w;
}

/** Add the drag handle on the sidebar's right edge; onCommit(width) runs when a drag ends. */
export function initSidebarResize(onCommit) {
  const grip = h('div.sb-resize', { role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize sidebar', title: 'Drag to resize the sidebar' });
  root.append(grip);
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('dragging');
    const left = root.getBoundingClientRect().left;
    let w = root.offsetWidth;
    const move = (ev) => { w = setSidebarWidth(ev.clientX - left); };
    const up = () => {
      grip.classList.remove('dragging');
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      onCommit(w);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  });
}

export function registerSidebarTab(def) {
  if (!def?.id || typeof def.render !== 'function') throw new TypeError('registerSidebarTab: id and render() required');
  if (!strip) throw new Error('registerSidebarTab: initSidebar() has not run');
  const button = h('button.sb-tab', {
    type: 'button', role: 'tab', id: `sb-tab-${def.id}`, title: def.label, 'aria-label': def.label,
    'aria-controls': `sb-panel-${def.id}`, dataset: { sbTab: def.id },
    html: def.icon?.trim().startsWith('<') ? def.icon : icon(def.icon ?? 'info'),
  });
  button.addEventListener('click', () => { showSidebarTab(def.id); if (!state.sidebarOpen) state.sidebarOpen = true; });
  const panel = h('div.sb-panel', { role: 'tabpanel', id: `sb-panel-${def.id}`, 'aria-labelledby': `sb-tab-${def.id}`, dataset: { sbPanel: def.id } });
  strip.append(button);
  panels.append(panel);
  sidebarTabs.set(def.id, { def, button, panel });
  syncTabs();
  return def;
}

/** Make sidebar tab `id` visible (sets state.sidebarTab). */
export function showSidebarTab(id) {
  if (!sidebarTabs.has(id)) return;
  state.sidebarTab = id;   // -> state:changed -> syncTabs + render
}

/** Re-run render() of sidebar tab `id` if it is the visible one. */
export function refreshSidebarTab(id = state.sidebarTab) {
  const t = sidebarTabs.get(id);
  if (t && id === state.sidebarTab) t.def.render(t.panel, activeTab());
}

let shownId = null;
let shownFor = null;
function syncTabs(forceRender = false) {
  for (const [id, { button, panel }] of sidebarTabs) {
    const on = id === state.sidebarTab;
    button.setAttribute('aria-selected', String(on));
    button.tabIndex = on ? 0 : -1;
    panel.hidden = !on;
  }
  const t = sidebarTabs.get(state.sidebarTab);
  const tab = activeTab();
  if (t && (forceRender || shownId !== state.sidebarTab || shownFor !== tab)) {
    shownId = state.sidebarTab;
    shownFor = tab;
    t.def.render(t.panel, tab);
  }
}

bus.on('state:changed', ({ key }) => { if (key === 'sidebarTab') syncTabs(); });
bus.on('tab:activated', () => syncTabs());
bus.on('tab:closed', () => syncTabs());
bus.on('tab:loaded', ({ tab, reloaded }) => { if (reloaded && tab === activeTab()) syncTabs(true); });

// ================================================================ thumbnails
const selectListeners = new Set();
const contextListeners = new Set();
const T = {
  tab: null, list: null, els: [], observer: null, queue: [], running: false,
  rendered: new Set(), selection: new Set(), anchor: null, gen: 0, stale: false,
};

/** Public thumbnail API for page tools (see docs/UI-ARCHITECTURE.md). */
export const thumbs = {
  /** The div.thumb element of page i (0-based) in the visible thumbnail list, or null. */
  getEl: (i) => T.els[i] ?? null,
  /** cb(event, {tab, pageIndex, selection}) on right-click / context-menu key. Returns unsubscribe. */
  onContext(cb) { contextListeners.add(cb); return () => contextListeners.delete(cb); },
  /** Selected page indices (Set<number>). Mutate via setSelection to keep the UI in sync. */
  get selection() { return T.selection; },
  setSelection(indices) { setSelection(new Set(indices)); },
  /** cb({tab, selection}) whenever the selection changes. Returns unsubscribe. */
  onSelect(cb) { selectListeners.add(cb); return () => selectListeners.delete(cb); },
  /** Rebuild the thumbnail list for the active tab (call after changing tab.pdfDoc yourself). */
  // (When the Thumbnails panel is hidden it is rebuilt anyway the next time it is shown.)
  refresh: () => refreshSidebarTab('thumbs'),
  get listEl() { return T.list; },
};

function renderThumbs(container, tab) {
  T.gen++;
  T.observer?.disconnect();
  T.queue = [];
  T.rendered = new Set();
  T.els = [];
  T.tab = tab;
  T.stale = false;
  T.anchor = null;
  if (T.selection.size) setSelection(new Set());
  if (!tab?.pdfDoc) { container.replaceChildren(h('p.sb-empty', {}, tab ? 'Loading…' : 'No document open')); T.list = null; return; }
  const list = h('div.thumb-list', { role: 'listbox', 'aria-label': 'Page thumbnails', 'aria-multiselectable': 'true' });
  T.observer = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) enqueueThumb(Number(e.target.dataset.pageIndex));
  }, { root: container, rootMargin: '200px 0px' });
  for (let i = 0; i < tab.numPages; i++) {
    const el = h('div.thumb', { role: 'option', tabindex: i === tab.currentPage ? '0' : '-1', 'aria-selected': 'false', 'aria-label': `Page ${i + 1}`, dataset: { pageIndex: String(i) } },
      h('div.thumb-img', { style: thumbBoxStyle(tab, i) }),
      h('span.thumb-label', {}, String(i + 1)));
    T.els.push(el);
    list.append(el);
    T.observer.observe(el);
  }
  list.addEventListener('click', onThumbClick);
  list.addEventListener('keydown', onThumbKey);
  list.addEventListener('contextmenu', onThumbContext);
  T.list = list;
  container.replaceChildren(list);
  markCurrent(tab.currentPage);
  T.els[tab.currentPage]?.scrollIntoView({ block: 'nearest' });
  bus.emit('thumbs:rebuilt', { tab, count: tab.numPages });
}

// Thumbnails show the page as the main view does: /Rotate plus the tab's view rotation.
function thumbBoxStyle(tab, i) {
  const vp = viewer.getViewport(tab, i, 1);
  return { width: `${THUMB_W}px`, height: `${Math.round(THUMB_W * vp.height / vp.width)}px` };
}

// View rotation changed: resize every box and re-render the visible thumbnails in place
// (a full rebuild would drop the selection).
function rotateThumbs() {
  T.gen++;
  T.queue = [];
  T.rendered = new Set();
  T.observer?.disconnect();
  T.els.forEach((el, i) => {
    const img = el.querySelector('.thumb-img');
    Object.assign(img.style, thumbBoxStyle(T.tab, i));
    img.replaceChildren();
    T.observer.observe(el);
  });
}

function enqueueThumb(i) {
  if (T.rendered.has(i) || T.queue.includes(i)) return;
  T.queue.push(i);
  pumpThumbs();
}

async function pumpThumbs() {
  if (T.running) return;
  T.running = true;
  try {
    while (T.queue.length) {
      const gen = T.gen;
      const tab = T.tab;
      const i = T.queue.shift();
      if (!tab?.pdfDoc || T.stale || T.rendered.has(i)) continue;
      T.rendered.add(i);
      const page = tab.pages[i];
      const vp1 = viewer.getViewport(tab, i, 1);
      const dpr = window.devicePixelRatio || 1;
      const vp = viewer.getViewport(tab, i, (THUMB_W / vp1.width) * dpr);
      const canvas = h('canvas.thumb-canvas', { 'aria-hidden': 'true' });
      canvas.width = Math.max(1, Math.floor(vp.width));
      canvas.height = Math.max(1, Math.floor(vp.height));
      try {
        await page.render({ canvas, viewport: vp, ...viewer.optionalContent(tab) }).promise;
      } catch (err) {
        T.rendered.delete(i);
        if (gen === T.gen) console.warn(`Thumbnail ${i + 1} failed`, err);
        continue;
      }
      if (gen !== T.gen) { canvas.width = 0; continue; }
      T.els[i]?.querySelector('.thumb-img')?.replaceChildren(canvas);
    }
  } finally {
    T.running = false;
  }
}

function markCurrent(i) {
  for (const el of T.list?.querySelectorAll('.thumb.current') ?? []) { el.classList.remove('current'); el.removeAttribute('aria-current'); }
  const el = T.els[i];
  if (!el) return;
  el.classList.add('current');
  el.setAttribute('aria-current', 'page');
}

function setSelection(sel) {
  T.selection = sel;
  T.els.forEach((el, i) => { const on = sel.has(i); el.classList.toggle('selected', on); el.setAttribute('aria-selected', String(on)); });
  for (const cb of selectListeners) cb({ tab: T.tab, selection: sel });
  bus.emit('thumbs:selectionChanged', { tab: T.tab, selection: sel });
}

function selectFrom(i, e) {
  if (e.shiftKey && T.anchor != null) {
    const sel = e.ctrlKey || e.metaKey ? new Set(T.selection) : new Set();
    for (let k = Math.min(T.anchor, i); k <= Math.max(T.anchor, i); k++) sel.add(k);
    setSelection(sel);
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    const sel = new Set(T.selection);
    if (sel.has(i)) sel.delete(i); else sel.add(i);
    T.anchor = i;
    setSelection(sel);
    return;
  }
  T.anchor = i;
  setSelection(new Set([i]));
}

function focusThumb(i) {
  for (const el of T.els) el.tabIndex = -1;
  const el = T.els[i];
  if (!el) return;
  el.tabIndex = 0;
  el.focus();
}

function onThumbClick(e) {
  const el = e.target.closest('.thumb');
  if (!el || !T.tab) return;
  const i = Number(el.dataset.pageIndex);
  selectFrom(i, e);
  focusThumb(i);
  if (!e.shiftKey && !e.ctrlKey && !e.metaKey) viewer.scrollToPage(T.tab, i);
}

function onThumbKey(e) {
  const el = e.target.closest('.thumb');
  if (!el || !T.tab) return;
  const i = Number(el.dataset.pageIndex);
  const n = T.els.length;
  const move = { ArrowDown: 1, ArrowUp: -1, Home: -n, End: n }[e.key];
  if (move != null) {
    e.preventDefault();
    const j = Math.max(0, Math.min(n - 1, i + move));
    focusThumb(j);
    if (e.shiftKey) selectFrom(j, e);
    else if (!e.ctrlKey) { T.anchor = j; setSelection(new Set([j])); viewer.scrollToPage(T.tab, j); }
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    selectFrom(i, e);
    if (e.key === 'Enter') viewer.scrollToPage(T.tab, i);
  }
}

function onThumbContext(e) {
  const el = e.target.closest('.thumb');
  if (!el || !T.tab || !contextListeners.size) return;
  e.preventDefault();
  const i = Number(el.dataset.pageIndex);
  if (!T.selection.has(i)) { T.anchor = i; setSelection(new Set([i])); }
  for (const cb of contextListeners) cb(e, { tab: T.tab, pageIndex: i, selection: T.selection });
}

bus.on('page:changed', ({ tab, pageIndex }) => {
  if (tab !== T.tab) return;
  markCurrent(pageIndex);
  const el = T.els[pageIndex];
  if (el && !root?.contains(document.activeElement)) el.scrollIntoView({ block: 'nearest' });
});
// Bytes replaced: the old pdfDoc is about to be destroyed; stop rendering from it. The
// list is rebuilt on tab:loaded {reloaded:true} once the viewer has the new document.
bus.on('tab:bytesChanged', ({ tab }) => { if (tab === T.tab) { T.stale = true; T.queue = []; } });
bus.on('tab:opened', () => { if (state.sidebarTab === 'thumbs') syncTabs(); });
bus.on('rotation:changed', ({ tab }) => { if (tab === T.tab && T.list && !T.stale) rotateThumbs(); });
bus.on('layers:changed', ({ tab }) => { if (tab === T.tab && T.list && !T.stale) rotateThumbs(); }); // same in-place re-render

// ================================================================ outline
let outlineGen = 0;
async function renderOutline(container, tab) {
  const gen = ++outlineGen;
  if (!tab?.pdfDoc) { container.replaceChildren(h('p.sb-empty', {}, tab ? 'Loading…' : 'No document open')); return; }
  let outline = null;
  try { outline = await tab.pdfDoc.getOutline(); } catch (err) { console.warn('Outline could not be read', err); }
  if (gen !== outlineGen) return;
  if (!outline?.length) { container.replaceChildren(h('p.sb-empty', {}, 'No bookmarks')); return; }
  const tree = h('ul.outline-tree', { role: 'tree', 'aria-label': 'Bookmarks' });
  const build = (items, parent, level) => {
    for (const it of items) {
      const kids = it.items ?? [];
      const label = h('span.ol-label', { style: { fontWeight: it.bold ? '600' : null, fontStyle: it.italic ? 'italic' : null } }, it.title || '(untitled)');
      const twisty = h('span.ol-twisty', { 'aria-hidden': 'true', html: kids.length ? icon('chevron', 14) : '' });
      const li = h('li.ol-item', { role: 'treeitem', tabindex: '-1', 'aria-level': String(level), 'aria-expanded': kids.length ? 'false' : null },
        h('div.ol-row', { style: { paddingLeft: `${(level - 1) * 14 + 4}px` } }, twisty, label));
      li._ol = it;
      if (kids.length) {
        const group = h('ul.ol-group', { role: 'group', hidden: true });
        build(kids, group, level + 1);
        li.append(group);
        if (it.count > 0) setExpanded(li, true);
      }
      parent.append(li);
    }
  };
  build(outline, tree, 1);
  tree.querySelector('[role=treeitem]').tabIndex = 0;
  tree.addEventListener('click', (e) => {
    const li = e.target.closest('[role=treeitem]');
    if (!li) return;
    focusItem(tree, li);
    if (e.target.closest('.ol-twisty') && li.hasAttribute('aria-expanded')) setExpanded(li, li.getAttribute('aria-expanded') !== 'true');
    else activateItem(tab, li);
  });
  tree.addEventListener('keydown', (e) => onTreeKey(e, tree, tab));
  container.replaceChildren(tree);
}

function setExpanded(li, on) {
  li.setAttribute('aria-expanded', String(on));
  li.querySelector(':scope > [role=group]').hidden = !on;
}

function visibleItems(tree) {
  return [...tree.querySelectorAll('[role=treeitem]')].filter((li) => !li.parentElement.closest('[role=group][hidden]'));
}

function focusItem(tree, li) {
  for (const x of tree.querySelectorAll('[role=treeitem][tabindex="0"]')) x.tabIndex = -1;
  li.tabIndex = 0;
  li.focus();
}

function activateItem(tab, li) {
  const it = li._ol;
  if (it.url) showExternalLink(it.url);
  else if (it.dest) viewer.goToDest(tab, it.dest);
  else if (li.hasAttribute('aria-expanded')) setExpanded(li, li.getAttribute('aria-expanded') !== 'true');
}

function onTreeKey(e, tree, tab) {
  const li = e.target.closest('[role=treeitem]');
  if (!li) return;
  const vis = visibleItems(tree);
  const k = vis.indexOf(li);
  const expanded = li.getAttribute('aria-expanded');
  let target = null;
  switch (e.key) {
    case 'ArrowDown': target = vis[k + 1]; break;
    case 'ArrowUp': target = vis[k - 1]; break;
    case 'Home': target = vis[0]; break;
    case 'End': target = vis[vis.length - 1]; break;
    case 'ArrowRight':
      if (expanded === 'false') setExpanded(li, true);
      else if (expanded === 'true') target = li.querySelector('[role=treeitem]');
      break;
    case 'ArrowLeft':
      if (expanded === 'true') setExpanded(li, false);
      else target = li.parentElement.closest('[role=treeitem]');
      break;
    case 'Enter': case ' ': activateItem(tab, li); break;
    default: return;
  }
  e.preventDefault();
  if (target) focusItem(tree, target);
}
