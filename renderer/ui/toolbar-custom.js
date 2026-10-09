// View > Customize toolbar…: hide tool buttons, reorder them, move them between groups, reorder the
// groups and fold groups into one compact dropdown. Also View > Toolbar: Expanded / Compact and a
// right-click menu on the tool row (Hide <tool>, Customize toolbar…). Hidden tools keep their menu
// items and shortcuts; only the toolbar button goes. Stored in settings 'toolbar.layout'.
//   initToolbarCustomize({ registerMenuItem }) -> Promise (the stored layout applied)
import { h } from './dom.js';
import { showDialog } from './dialogs.js';
import { getToolbarLayout, setToolbarLayout, toolbarItemOf, toolbarItemInfo } from './toolbar.js';
import {
  defaultLayout, cleanLayout, groupLabel, isHidden, isCompact, canHide, setHidden, setGroupShown, moveItem, moveToGroup,
  moveGroup, setCompact, setAllCompact, compactMode,
} from './toolbar-layout.js';

const KEY = 'toolbar.layout';
const api = window.api;
let modeItems = [];

function apply(layout, persist = true) {
  setToolbarLayout(layout);
  syncModeItems();
  if (persist) api.settingsSet(KEY, getToolbarLayout()).catch(() => {});
}

function syncModeItems() {
  const mode = compactMode(getToolbarLayout());
  for (const it of modeItems) it.el?.setAttribute('aria-checked', String(it.mode === mode));
}

// ---------------------------------------------------------------- dialog
function buildBody(get, set) {
  const root = h('div.tbc');
  const render = (focusKey) => {
    const L = get();
    const info = toolbarItemInfo();
    const groupSelect = (id, g) => h('select.input.tbc-group', { 'aria-label': `Group for ${info[id]?.label ?? id}`, dataset: { key: `grp:${id}` }, onchange: (e) => set(moveToGroup(get(), id, e.target.value), `grp:${id}`) },
      L.groupOrder.map((k) => h('option', { value: k, selected: k === g }, groupLabel(k))));
    const mini = (text, label, key, disabled, fn) => h('button.btn.tbc-mini', { type: 'button', 'aria-label': label, title: label, disabled, dataset: { key }, onclick: () => set(fn(), key) }, text);
    root.replaceChildren(...L.groupOrder.map((g, gi) => {
      const name = groupLabel(g);
      const ids = L.order[g].filter((id) => info[id]);
      const head = h('div.tbc-head', {},
        h('h3.tbc-title', { id: `tbc-g-${g}` }, name),
        mini('↑', `Move group ${name} left`, `gup:${g}`, gi === 0, () => moveGroup(get(), g, -1)),
        mini('↓', `Move group ${name} right`, `gdown:${g}`, gi === L.groupOrder.length - 1, () => moveGroup(get(), g, 1)),
        h('label.tbc-compact', {}, h('input', { type: 'checkbox', checked: isCompact(L, g), dataset: { key: `compact:${g}` }, onchange: (e) => set(setCompact(get(), g, e.target.checked), `compact:${g}`) }), h('span', {}, 'Compact')),
        mini('All', `Show all ${name} tools`, `all:${g}`, !ids.length, () => setGroupShown(get(), g, true)),
        mini('None', `Hide all ${name} tools`, `none:${g}`, !ids.length, () => setGroupShown(get(), g, false)));
      const rows = ids.map((id, i) => h('li.tbc-row', { dataset: { id } },
        h('label.tbc-check', {},
          h('input', { type: 'checkbox', checked: !isHidden(L, id), disabled: !canHide(id), dataset: { key: `show:${id}` }, onchange: (e) => set(setHidden(get(), id, !e.target.checked), `show:${id}`) }),
          h('span.tbc-icon', { 'aria-hidden': 'true', html: info[id].icon }), h('span', {}, info[id].label)),
        mini('↑', `Move ${info[id].label} up`, `up:${id}`, i === 0, () => moveItem(get(), id, -1)),
        mini('↓', `Move ${info[id].label} down`, `down:${id}`, i === ids.length - 1, () => moveItem(get(), id, 1)),
        groupSelect(id, g)));
      return h('section.tbc-groupbox', { 'aria-labelledby': `tbc-g-${g}`, dataset: { group: g } }, head,
        rows.length ? h('ul.tbc-list', {}, rows) : h('p.tbc-empty', {}, 'No tools'));
    }));
    if (focusKey) {
      const el = root.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
      // A move button at the end of its list is disabled: keep the focus on the row.
      (el && !el.disabled ? el : el?.closest('.tbc-row, .tbc-groupbox')?.querySelector('input:not(:disabled)'))?.focus();
    }
  };
  render();
  return { root, render };
}

export async function openCustomize() {
  let draft = getToolbarLayout();
  let body = null;
  const v = await showDialog({
    title: 'Customize toolbar',
    className: 'tbc-dlg',
    body: () => (body = buildBody(() => draft, (l, key) => { draft = l; body.render(key); })).root,
    initialFocus: '.tbc input:not(:disabled)',
    buttons: [
      { label: 'Reset to default', value: 'reset', validate: () => { draft = defaultLayout(); body.render(); return false; } },
      { label: 'Cancel', value: 'cancel', cancel: true },
      { label: 'OK', value: 'ok', primary: true },
    ],
  });
  if (v === 'ok') apply(draft);
  return v === 'ok';
}

// ---------------------------------------------------------------- right-click on the tool row
let ctx = null;
function closeContext(refocus) {
  if (!ctx) return;
  const { el, origin } = ctx;
  ctx = null;
  el.remove();
  document.removeEventListener('mousedown', onDocDown, true);
  document.removeEventListener('keydown', onKey, true);
  if (refocus && origin?.isConnected) origin.focus();
}
function onDocDown(e) { if (ctx && !ctx.el.contains(e.target)) closeContext(); }
function onKey(e) {
  if (!ctx) return;
  const list = [...ctx.el.querySelectorAll('button:not(:disabled)')];
  const k = list.indexOf(document.activeElement);
  if (e.key === 'Escape' || e.key === 'Tab') closeContext(true);
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') list[(k + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
  else if (e.key === 'Home' || e.key === 'End') list[e.key === 'Home' ? 0 : list.length - 1]?.focus();
  else return;
  e.preventDefault();
  e.stopPropagation();
}

function openContext(e) {
  const tools = e.target.closest('.tb-tools');
  if (!tools) return;
  e.preventDefault();
  closeContext();
  const id = toolbarItemOf(e.target);
  const name = id ? toolbarItemInfo()[id]?.label ?? id : null;
  const item = (key, text, action, disabled = false) => h('button.menu-item', { type: 'button', role: 'menuitem', disabled, dataset: { id: key }, onclick: () => { closeContext(true); action(); } }, h('span', {}, text), h('kbd', {}, ''));
  const el = h('div.ctx-menu.tb-ctx-menu', { role: 'menu', 'aria-label': 'Toolbar' },
    name && item('hide', `Hide ${name}`, () => apply(setHidden(getToolbarLayout(), id, true)), !canHide(id)),
    item('customize', 'Customize toolbar…', () => openCustomize()));
  document.body.append(el);
  let x = e.clientX, y = e.clientY;
  if (!x && !y) { const r = e.target.getBoundingClientRect(); x = r.left + 10; y = r.bottom; }
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  el.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
  ctx = { el, origin: document.activeElement };
  document.addEventListener('mousedown', onDocDown, true);
  document.addEventListener('keydown', onKey, true);
  el.querySelector('button:not(:disabled)')?.focus();
}

export async function initToolbarCustomize({ registerMenuItem }) {
  registerMenuItem('View', { id: 'tbcustomize', label: 'Customize toolbar…', action: () => openCustomize() });
  modeItems = [
    { id: 'tbexpanded', mode: 'expanded', label: 'Toolbar: Expanded', action: () => apply(setAllCompact(getToolbarLayout(), false)) },
    { id: 'tbcompact', mode: 'compact', label: 'Toolbar: Compact', action: () => apply(setAllCompact(getToolbarLayout(), true)) },
  ];
  for (const it of modeItems) { registerMenuItem('View', it); it.el.setAttribute('role', 'menuitemradio'); }
  document.addEventListener('contextmenu', (e) => { if (e.target.closest?.('.toolbar .tb-tools')) openContext(e); });
  let stored;
  try { stored = await api.settingsGet(KEY); } catch { stored = undefined; }
  apply(cleanLayout(stored ?? null), false);
}
