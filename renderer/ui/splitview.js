// Split view: View > Split vertically / Split horizontally / Unsplit.
//
// The viewer host becomes a two-pane grid; each pane shows one open tab's own view (its own
// scroll container, zoom and current page), so the panes scroll independently. The focused
// pane is the active tab: tools, menus and the status bar act on it. A pane header holds a
// picker to choose the pane's tab; the divider between the panes drags to resize
// (double-click resets 50/50). Unsplit hides the other pane's view (its canvases are released
// by the viewer's normal hidden-tab path). Single-pane mode leaves the viewer untouched.
// Both panes may show the SAME document (one tab open, or the picker's "same document" entry):
// the second pane gets the tab's secondary view (viewer.secondary) with its own scroll, zoom and
// current page; focusing that pane swaps the views (viewer.swapViews) so the focused pane is still
// the tab's own view. Leaving same-document mode keeps the view that stays on screen.
// "Scroll and zoom together" (View and Split menus, the link button in the pane headers) links the
// panes: scrolling one shows the same page at the same fraction of its height (and width) in the
// other, and a zoom of one (factor or fit mode) is given to the other. The sync maps by page index and
// fraction (splitview-lib.js syncScroll), never raw pixels, as the documents may differ in page sizes
// and count. The toggle outlives Unsplit and is remembered in the settings store (view.splitSync).
import { bus } from '../bus.js';
import { state, getTab } from '../state.js';
import { h } from './dom.js';
import { viewer } from './viewer.js';
import { showDialog } from './dialogs.js';
import { icon } from './icons.js';
import { defaultPair, chooseTab, pickForPane, closeTabIn, clampRatio, syncScroll, zoomToSync } from './splitview-lib.js';

let host = null;
let activate = null;
let split = null; // {dir: 'v'|'h', ratio, ids: [paneA tab id, paneB tab id], focus: focused pane index}
let recent = []; // tab ids, most recently active first (the plain Split pairs the current and the previous one)
const heads = [];
let divider = null;
// Every change of the split (opened, closed, orientation, documents, focused pane, divider) emits
// split:changed, so the last session can record it.
const changed = () => bus.emit('split:changed', split ? { split: true, dir: split.dir, sync: together } : { split: false });
const SYNC_KEY = 'view.splitSync';
let together = false;   // "Scroll and zoom together" (kept across Unsplit)
let togetherSet = false; // set this session: the stored default no longer applies
let syncing = false;    // a change made by the sync (or a view swap) in progress: its zoom events are not synced back
const expected = new WeakMap(); // scrollEl -> {top, left} the sync scrolled it to (its scroll event is ignored)
let syncRaf = 0;
let syncSource = -1;

export const splitView = {
  split: splitOn,
  unsplit,
  setPane,
  open: openSplit,
  chooseDialog,
  get together() { return together; },
  setTogether,
  get state() { return split && { dir: split.dir, ratio: split.ratio, ids: [...split.ids], focus: split.focus, sync: together }; },
};

export function initSplitView(app) {
  host = app.host;
  activate = app.activate;
  const M = app.registerMenuItem;
  const canSplit = () => state.tabs.length >= 1;
  M('View', { separator: true });
  M('View', { id: 'split-v', label: 'Split vertically', action: () => splitOn('v'), enabled: canSplit });
  M('View', { id: 'split-h', label: 'Split horizontally', action: () => splitOn('h'), enabled: canSplit });
  M('View', { id: 'unsplit', label: 'Unsplit', action: unsplit, enabled: () => !!split });
  M('View', { id: 'split-sync', label: syncLabel(), labelFn: syncLabel, action: () => setTogether(!together) });
  window.api?.settingsGet?.(SYNC_KEY).then((v) => { if (!togetherSet && typeof v === 'boolean') { together = v; markSync(); } }).catch(() => {});
  // A tab chosen from the tab strip while split goes into the focused pane.
  bus.on('tab:activated', ({ tab }) => {
    if (tab) recent = [tab.id, ...recent.filter((id) => id !== tab.id)];
    if (!split || !tab) return;
    Object.assign(split, chooseTab(split, tab.id));
    apply();
    changed();
  });
  // A closed tab shown in a pane is replaced by another open document (none left: unsplit).
  bus.on('tab:closed', ({ tab }) => {
    recent = recent.filter((id) => id !== tab.id);
    if (!split?.ids.includes(tab.id)) return;
    const next = closeTabIn(split, tab.id, state.tabs.map((t) => t.id), recent);
    if (!next) { unsplit(); return; }
    Object.assign(split, next);
    apply();
    changed();
  });
  bus.on('state:changed', ({ key }) => { if (key === 'tabs' && split) syncPickers(); });
  host.addEventListener('pointerdown', onPaneFocus, true);
  host.addEventListener('focusin', onPaneFocus);
  host.addEventListener('scroll', onPaneScroll, true); // scroll does not bubble: listen in the capture phase
  bus.on('zoom:changed', ({ tab }) => {
    if (!split || !together || syncing) return;
    const k = paneHolders().indexOf(tab);
    if (k >= 0) alignFrom(k);
  });
}

/** Menu label of the toggle: a check mark while on. */
export const syncLabel = () => `${together ? '\u2713 ' : ''}Scroll and zoom together`;

/** Turn "Scroll and zoom together" on or off; turning it on brings the other pane to the focused one. */
function setTogether(on, { save = true } = {}) {
  together = !!on;
  togetherSet = true;
  if (save) window.api?.settingsSet?.(SYNC_KEY, together).catch(() => {});
  markSync();
  if (!split) return;
  if (together) alignFrom(split.focus);
  changed();
}

function markSync() {
  for (const el of heads) {
    const b = el?.querySelector('.split-sync');
    if (b) { b.setAttribute('aria-pressed', String(together)); b.classList.toggle('on', together); }
  }
}

/** The view holders in panes a and b (the same document: the tab and its secondary). */
function paneHolders() {
  const tabs = split.ids.map(getTab);
  if (!same()) return tabs;
  const hs = [];
  hs[split.focus] = tabs[0];
  hs[1 - split.focus] = viewer.secondaryOf(tabs[0]);
  return hs;
}

function geometry(t) {
  const { scrollEl: el, pageEls } = t.view;
  return {
    tops: pageEls.map((p) => p.offsetTop), heights: pageEls.map((p) => p.offsetHeight),
    lefts: pageEls.map((p) => p.offsetLeft), widths: pageEls.map((p) => p.offsetWidth),
    clientWidth: el.clientWidth, scrollTop: el.scrollTop, scrollLeft: el.scrollLeft,
  };
}

// A pane scrolled by the user (or by page navigation): sync the other once per animation frame.
// The scroll event of a pane the sync itself moved is ignored, so the panes do not chase each other.
function onPaneScroll(e) {
  if (!split || !together) return;
  const el = e.target;
  const k = PANE.indexOf(el?.dataset?.pane || '-');
  if (k < 0 || !el.classList.contains('viewer-scroll')) return;
  const exp = expected.get(el);
  if (exp) {
    expected.delete(el);
    if (Math.abs(el.scrollTop - exp.top) <= 1 && Math.abs(el.scrollLeft - exp.left) <= 1) return;
  }
  syncSource = k;
  if (!syncRaf) syncRaf = requestAnimationFrame(() => { syncRaf = 0; if (syncSource >= 0) syncFrom(syncSource); syncSource = -1; });
}

/** Scroll the other pane to pane k's page and fraction. */
function syncFrom(k) {
  if (!split || !together) return;
  const hs = paneHolders();
  const src = hs[k], dst = hs[1 - k];
  if (!src?.view || !dst?.view || !src.numPages || !dst.numPages || dst.view.scrollEl.hidden) return;
  const r = syncScroll(geometry(src), geometry(dst));
  const el = dst.view.scrollEl;
  el.scrollTop = r.top;
  el.scrollLeft = r.left;
  expected.set(el, { top: el.scrollTop, left: el.scrollLeft });
}

/** Give the other pane pane k's zoom (mode or factor), then its scroll position. */
function alignFrom(k) {
  const hs = paneHolders();
  const src = hs[k], dst = hs[1 - k];
  if (!src?.view || !dst?.view) return;
  const differs = dst.zoomMode !== src.zoomMode || (src.zoomMode === 'custom' && Math.abs(dst.zoom - src.zoom) > 1e-6);
  if (differs) {
    syncing = true;
    try { viewer.setZoom(dst, zoomToSync(src)); } finally { syncing = false; }
  }
  syncFrom(k);
}

const same = () => split.ids[0] === split.ids[1];
const PANE = ['a', 'b'];
/** The scroll containers in panes a and b. */
function paneEls(tabs) {
  if (!same()) return tabs.map((t) => t.view.scrollEl);
  const els = [];
  els[split.focus] = tabs[0].view.scrollEl;
  els[1 - split.focus] = viewer.secondary(tabs[0]).view.scrollEl;
  return els;
}

/** Split (one document: itself twice; several: the current and the previously active one) or set the orientation. */
function splitOn(dir) {
  if (!state.tabs.length) return;
  if (split) {
    split.dir = dir;
    apply();
    changed();
  } else openSplit(defaultPair(state.activeId, state.tabs.map((t) => t.id), recent), dir);
}

/**
 * Show tabs ids[0] (left / top) and ids[1] (right / bottom); the pane of the active tab keeps the
 * focus unless `opts.focus` (0 | 1) names the focused pane. `opts.ratio` sets the divider (a restored
 * session); otherwise a new split starts at 50 / 50 and an open one keeps its divider.
 */
function openSplit(ids, dir = split?.dir ?? 'v', opts = {}) {
  if (!ids?.every(getTab)) return;
  if (typeof opts.sync === 'boolean') setTogether(opts.sync, { save: false });
  const focus = opts.focus === 0 || opts.focus === 1 ? opts.focus : ids[0] !== ids[1] && ids[1] === state.activeId ? 1 : 0;
  const ratio = Number.isFinite(opts.ratio) ? clampRatio(opts.ratio) : split?.ratio ?? 0.5;
  if (!split) {
    split = { dir, ratio, ids: [...ids], focus };
    buildChrome();
  } else Object.assign(split, { dir, ratio, ids: [...ids], focus });
  apply();
  if (ids[focus] !== state.activeId) activate(ids[focus]);
  changed();
}

/** Show tab `id` in pane k (0 = first, 1 = second) and focus that pane. */
function setPane(k, id) {
  if (!split || !getTab(id)) return;
  Object.assign(split, pickForPane(split, k, id));
  apply();
  activate(split.ids[split.focus]);
  changed();
}

/** "Choose documents…": a document for each pane and the orientation. */
async function chooseDialog() {
  if (!state.tabs.length) return;
  const [a, b] = split?.ids ?? defaultPair(state.activeId, state.tabs.map((t) => t.id), recent);
  const pick = (label, id, name) => h('label.split-choose-row', {}, h('span', {}, label),
    h('select', { name, 'aria-label': label }, state.tabs.map((t) => h('option', { value: t.id, selected: t.id === id }, t.name))));
  const dir = split?.dir ?? 'v';
  const radio = (v, label) => h('label', {}, h('input', { type: 'radio', name: 'split-dir', value: v, checked: v === dir }), ` ${label}`);
  let form = null;
  const r = await showDialog({
    title: 'Split view', className: 'split-choose-dialog',
    body: () => (form = h('div.split-choose', {}, pick('Left / top pane', a, 'pane-a'), pick('Right / bottom pane', b, 'pane-b'),
      h('div.split-choose-dir', { role: 'radiogroup', 'aria-label': 'Orientation' }, radio('v', 'Vertical (side by side)'), radio('h', 'Horizontal (top / bottom)')))),
    buttons: [{ label: 'Cancel', value: 'cancel', cancel: true }, { label: 'Split', value: 'ok', primary: true }],
  });
  if (r !== 'ok') return;
  const val = (sel) => form.querySelector(sel).value;
  openSplit([val('select[name="pane-a"]'), val('select[name="pane-b"]')], form.querySelector('input[name="split-dir"]:checked')?.value ?? 'v');
}

function buildChrome() {
  for (const k of [0, 1]) {
    const select = h('select.split-pick', { 'aria-label': `Document in pane ${k + 1}`, onchange: (e) => setPane(k, e.target.value) });
    const link = h('button.split-sync', { type: 'button', title: 'Scroll and zoom together', 'aria-label': 'Scroll and zoom together', 'aria-pressed': String(together),
      html: icon('link', 14), onclick: () => setTogether(!together) });
    heads[k] = h('div.split-head', { dataset: { pane: k ? 'b' : 'a' }, style: `grid-area: ${k ? 'hb' : 'ha'}` }, select, link);
  }
  divider = h('div.split-divider', { role: 'separator', tabindex: '-1', title: 'Drag to resize; double-click for 50 / 50', style: 'grid-area: dv' });
  divider.addEventListener('pointerdown', startDrag);
  divider.addEventListener('dblclick', () => { split.ratio = 0.5; applyTracks(); viewer.refit(); changed(); });
  host.append(heads[0], divider, heads[1]);
  markSync();
}

function syncPickers() {
  split.ids.forEach((id, k) => {
    const sel = heads[k].firstChild;
    const twice = (t) => t.id === split.ids[1 - k] && !same();
    sel.replaceChildren(...state.tabs.map((t) => h('option', { value: t.id }, twice(t) ? `${t.name} (same document)` : t.name)));
    sel.value = id;
  });
}

// The layout's own zoom and scroll events are not synced; afterwards, with the panes linked, the
// other pane follows the focused one.
function apply() {
  syncing = true;
  try { applyLayout(); } finally { syncing = false; }
  if (split && together) alignFrom(split.focus);
}

function applyLayout() {
  const tabs = split.ids.map(getTab);
  if (tabs.some((t) => !t?.view)) { unsplit(); return; }
  // A tab leaving same-document mode keeps the view of the pane it stays in.
  for (const t of state.tabs) {
    const sec = viewer.secondaryOf(t);
    if (!sec || (same() && tabs[0] === t)) continue;
    const k = split.ids.indexOf(t.id);
    if (k >= 0 && sec.view.scrollEl.dataset.pane === PANE[k]) viewer.swapViews(t);
    viewer.dropSecondary(t);
  }
  host.classList.add('split');
  host.classList.toggle('split-v', split.dir === 'v');
  host.classList.toggle('split-h', split.dir === 'h');
  applyTracks();
  viewer.setShown(tabs);
  const fresh = same() && !viewer.secondaryOf(tabs[0]);
  const els = paneEls(tabs);
  for (const t of state.tabs) {
    for (const v of [t.view, viewer.secondaryOf(t)?.view]) {
      if (!v) continue;
      const k = els.indexOf(v.scrollEl);
      v.scrollEl.style.gridArea = k < 0 ? '' : k ? 'pb' : 'pa';
      v.scrollEl.dataset.pane = k < 0 ? '' : PANE[k];
      if (k < 0 && v === t.view && !v.scrollEl.hidden) viewer.deactivate(t);
    }
  }
  // Show the unfocused pane's tab without moving focus away from the active one.
  for (const t of tabs) if (t.id !== state.activeId && t.view.scrollEl.hidden) viewer.activate(t);
  syncPickers();
  markFocus();
  viewer.refit();
  if (fresh) { const sec = viewer.secondaryOf(tabs[0]); viewer.scrollToPage(sec, sec.currentPage); }
}

function applyTracks() {
  const a = split.ratio, b = 1 - split.ratio;
  host.style.gridTemplateColumns = split.dir === 'v' ? `minmax(0, ${a}fr) 6px minmax(0, ${b}fr)` : '';
  host.style.gridTemplateRows = split.dir === 'h' ? `auto minmax(0, ${a}fr) 6px auto minmax(0, ${b}fr)` : '';
}

function markFocus() {
  const f = split ? split.focus : -1;
  heads.forEach((el, k) => el?.classList.toggle('focused', k === f));
  const focused = split ? paneEls(split.ids.map(getTab))[f] : null;
  for (const el of host.querySelectorAll('.viewer-scroll')) el.classList.toggle('pane-focused', el === focused);
}

// A click (or focus) in a pane or its header focuses that pane; its document becomes the active tab.
function onPaneFocus(e) {
  if (!split) return;
  const el = e.target.closest?.('.viewer-scroll, .split-head');
  const k = PANE.indexOf(el?.dataset.pane || '-');
  if (k < 0) return;
  const changedFocus = k !== split.focus;
  if (changedFocus) {
    if (same()) { // the focused pane holds the tab's own view
      syncing = true;
      try { viewer.swapViews(getTab(split.ids[0])); } finally { syncing = false; }
    }
    split.focus = k;
    markFocus();
  }
  if (split.ids[k] !== state.activeId) activate(split.ids[k]);
  if (changedFocus) changed();
}

function startDrag(e) {
  e.preventDefault();
  divider.setPointerCapture(e.pointerId);
  divider.classList.add('dragging');
  let raf = 0;
  const move = (ev) => {
    const r = host.getBoundingClientRect();
    const f = split.dir === 'v' ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height;
    split.ratio = clampRatio(f);
    applyTracks();
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; viewer.refit(); });
  };
  const up = () => {
    divider.classList.remove('dragging');
    changed();
    divider.removeEventListener('pointermove', move);
    divider.removeEventListener('pointerup', up);
    divider.removeEventListener('pointercancel', up);
  };
  divider.addEventListener('pointermove', move);
  divider.addEventListener('pointerup', up);
  divider.addEventListener('pointercancel', up);
}

function unsplit() {
  if (!split) return;
  const ids = split.ids;
  split = null;
  changed();
  for (const t of state.tabs) viewer.dropSecondary(t); // the focused pane (the tab's own view) stays
  viewer.setShown([]);
  host.classList.remove('split', 'split-v', 'split-h');
  host.style.gridTemplateColumns = host.style.gridTemplateRows = '';
  for (const el of [...heads, divider]) el?.remove();
  heads.length = 0;
  divider = null;
  for (const t of state.tabs) {
    if (!t.view) continue;
    t.view.scrollEl.style.gridArea = '';
    delete t.view.scrollEl.dataset.pane;
    t.view.scrollEl.classList.remove('pane-focused');
    if (t.id !== state.activeId && ids.includes(t.id) && !t.view.scrollEl.hidden) viewer.deactivate(t);
  }
  viewer.refit();
}
