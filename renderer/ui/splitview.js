// Split view: View > Split vertically / Split horizontally / Unsplit.
//
// The viewer host becomes a two-pane grid; each pane shows one open tab's own view (its own
// scroll container, zoom and current page), so the panes scroll independently. The focused
// pane is the active tab: tools, menus and the status bar act on it. A pane header holds a
// picker to choose the pane's tab; the divider between the panes drags to resize
// (double-click resets 50/50). Unsplit hides the other pane's view (its canvases are released
// by the viewer's normal hidden-tab path). Single-pane mode leaves the viewer untouched.
import { bus } from '../bus.js';
import { state, getTab } from '../state.js';
import { h } from './dom.js';
import { viewer } from './viewer.js';

let host = null;
let activate = null;
let split = null; // {dir: 'v'|'h', ratio, ids: [paneA tab id, paneB tab id]}
const heads = [];
let divider = null;

export const splitView = {
  split: splitOn,
  unsplit,
  setPane,
  get state() { return split && { dir: split.dir, ratio: split.ratio, ids: [...split.ids] }; },
};

export function initSplitView(app) {
  host = app.host;
  activate = app.activate;
  const M = app.registerMenuItem;
  const canSplit = () => state.tabs.length >= 2;
  M('View', { separator: true });
  M('View', { id: 'split-v', label: 'Split vertically', action: () => splitOn('v'), enabled: canSplit });
  M('View', { id: 'split-h', label: 'Split horizontally', action: () => splitOn('h'), enabled: canSplit });
  M('View', { id: 'unsplit', label: 'Unsplit', action: unsplit, enabled: () => !!split });
  // A tab chosen from the tab strip while split goes into the focused pane.
  bus.on('tab:activated', ({ tab }) => {
    if (!split || !tab) return;
    if (!split.ids.includes(tab.id)) split.ids[focusIndex()] = tab.id;
    apply();
  });
  bus.on('tab:closed', ({ tab }) => { if (split?.ids.includes(tab.id)) unsplit(); });
  bus.on('state:changed', ({ key }) => { if (key === 'tabs' && split) syncPickers(); });
  host.addEventListener('pointerdown', onPaneFocus, true);
  host.addEventListener('focusin', onPaneFocus);
}

function focusIndex() { return Math.max(0, split.ids.indexOf(state.activeId)); }

function splitOn(dir) {
  if (state.tabs.length < 2) return;
  if (!split) {
    const a = state.activeId ?? state.tabs[0].id;
    const i = state.tabs.findIndex((t) => t.id === a);
    split = { dir, ratio: 0.5, ids: [a, state.tabs[(i + 1) % state.tabs.length].id] };
    buildChrome();
  }
  split.dir = dir;
  apply();
}

/** Show tab `id` in pane k (0 = first, 1 = second). Choosing the other pane's tab swaps them. */
function setPane(k, id) {
  if (!split || !getTab(id)) return;
  const other = split.ids[1 - k];
  if (other === id) split.ids[1 - k] = split.ids[k];
  split.ids[k] = id;
  apply();
  activate(id);
}

function buildChrome() {
  for (const k of [0, 1]) {
    const select = h('select.split-pick', { 'aria-label': `Document in pane ${k + 1}`, onchange: (e) => setPane(k, e.target.value) });
    heads[k] = h('div.split-head', { dataset: { pane: k ? 'b' : 'a' }, style: `grid-area: ${k ? 'hb' : 'ha'}` }, select);
  }
  divider = h('div.split-divider', { role: 'separator', tabindex: '-1', title: 'Drag to resize; double-click for 50 / 50', style: 'grid-area: dv' });
  divider.addEventListener('pointerdown', startDrag);
  divider.addEventListener('dblclick', () => { split.ratio = 0.5; applyTracks(); viewer.refit(); });
  host.append(heads[0], divider, heads[1]);
}

function syncPickers() {
  split.ids.forEach((id, k) => {
    const sel = heads[k].firstChild;
    sel.replaceChildren(...state.tabs.map((t) => h('option', { value: t.id }, t.name)));
    sel.value = id;
  });
}

function apply() {
  const tabs = split.ids.map(getTab);
  if (tabs.some((t) => !t?.view)) { unsplit(); return; }
  host.classList.add('split');
  host.classList.toggle('split-v', split.dir === 'v');
  host.classList.toggle('split-h', split.dir === 'h');
  applyTracks();
  viewer.setShown(tabs);
  for (const t of state.tabs) {
    if (!t.view) continue;
    const k = tabs.indexOf(t);
    t.view.scrollEl.style.gridArea = k < 0 ? '' : k ? 'pb' : 'pa';
    t.view.scrollEl.dataset.pane = k < 0 ? '' : k ? 'b' : 'a';
    if (k < 0 && !t.view.scrollEl.hidden) viewer.deactivate(t);
  }
  // Show the unfocused pane's tab without moving focus away from the active one.
  for (const t of tabs) if (t.id !== state.activeId && t.view.scrollEl.hidden) viewer.activate(t);
  syncPickers();
  markFocus();
  viewer.refit();
}

function applyTracks() {
  const a = split.ratio, b = 1 - split.ratio;
  host.style.gridTemplateColumns = split.dir === 'v' ? `minmax(0, ${a}fr) 6px minmax(0, ${b}fr)` : '';
  host.style.gridTemplateRows = split.dir === 'h' ? `auto minmax(0, ${a}fr) 6px auto minmax(0, ${b}fr)` : '';
}

function markFocus() {
  const f = split ? focusIndex() : -1;
  heads.forEach((el, k) => el?.classList.toggle('focused', k === f));
  for (const t of state.tabs) t.view?.scrollEl.classList.toggle('pane-focused', !!split && t.id === split.ids[f]);
}

function onPaneFocus(e) {
  if (!split) return;
  const el = e.target.closest?.('.viewer-scroll');
  const id = el?.dataset.tabId;
  if (id && split.ids.includes(id) && id !== state.activeId) activate(id);
}

function startDrag(e) {
  e.preventDefault();
  divider.setPointerCapture(e.pointerId);
  divider.classList.add('dragging');
  let raf = 0;
  const move = (ev) => {
    const r = host.getBoundingClientRect();
    const f = split.dir === 'v' ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height;
    split.ratio = Math.min(0.85, Math.max(0.15, f));
    applyTracks();
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; viewer.refit(); });
  };
  const up = () => {
    divider.classList.remove('dragging');
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
