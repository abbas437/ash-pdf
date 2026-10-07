// Main toolbar, tool registry and the contextual tool-options bar.
import { bus } from '../bus.js';
import { state } from '../state.js';
import { h } from './dom.js';
import { icon } from './icons.js';

const tools = new Map(); // id -> tool definition
let toolsEl = null;
let optionsEl = null;

let barEl = null;
let moreWrap = null, morePanel = null, moreBtn = null;

// Tool groups, left to right; ids not listed here go to Edit. Items keep this order in every group.
const GROUPS = [
  ['navigate', 'Navigate', ['select', 'hand']],
  ['edit', 'Edit', ['text', 'image', 'whiteout', 'forms']],
  ['comment', 'Comment', ['highlight', 'text-highlight', 'underline', 'strikeout', 'squiggly', 'note', 'callout', 'markup', 'draw', 'shapes']],
  ['sign', 'Stamp and sign', ['stamp', 'sign']],
];
const groupOf = (id) => GROUPS.find((g) => g[2].includes(id)) ?? GROUPS[1];

/** Icon button: btn('open', 'Open (Ctrl+O)', onClick, {id}) */
export function btn(iconName, label, onClick, props = {}) {
  return h('button.tb-btn', { type: 'button', title: label, 'aria-label': label, html: icon(iconName), onclick: onClick, ...props });
}

/** Build the toolbar. `groups` is an array of arrays of nodes; separators are added between them. */
export function buildToolbar(container, groups, optionsContainer) {
  container.setAttribute('role', 'toolbar');
  container.setAttribute('aria-label', 'Main toolbar');
  for (const [n, g] of groups.entries()) {
    if (n) container.append(h('span.tb-sep', { role: 'separator', 'aria-orientation': 'vertical' }));
    container.append(h('div.tb-group', {}, g));
  }
  toolsEl = h('div.tb-tools', { role: 'group', 'aria-label': 'Tools' });
  for (const [n, [key, label]] of GROUPS.entries()) {
    if (n) toolsEl.append(h('span.tb-sep', { role: 'separator', 'aria-orientation': 'vertical' }));
    toolsEl.append(h('div.tb-group.tb-tg', { role: 'group', 'aria-label': label, dataset: { group: key } }));
  }
  moreBtn = h('button.tb-btn.tb-more-btn', { type: 'button', title: 'More', 'aria-label': 'More tools', 'aria-haspopup': 'true', 'aria-expanded': 'false', html: '<span class="tb-more-glyph" aria-hidden="true">\u00bb</span>' });
  morePanel = h('div.tb-more-panel', { role: 'group', 'aria-label': 'More tools', hidden: true });
  moreWrap = h('div.tb-more', { hidden: true }, moreBtn, morePanel);
  moreBtn.onclick = () => showMore(morePanel.hidden);
  morePanel.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b?.classList.contains('tb-btn') && !b.hasAttribute('aria-haspopup')) showMore(false); });
  document.addEventListener('pointerdown', (e) => { if (!morePanel.hidden && !moreWrap.contains(e.target)) showMore(false); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !morePanel.hidden) { showMore(false); moreBtn.focus(); } });
  toolsEl.append(moreWrap);
  container.append(h('span.tb-sep', { role: 'separator' }), toolsEl);
  barEl = container;
  watchOverflow(container);
  optionsEl = optionsContainer;
  optionsEl.setAttribute('role', 'toolbar');
  optionsEl.setAttribute('aria-label', 'Tool options');
  // Roving arrow-key navigation inside the toolbar.
  container.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
    const items = [...container.querySelectorAll('button:not([disabled]), select')];
    const k = items.indexOf(document.activeElement);
    if (k < 0) return;
    e.preventDefault();
    items[(k + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length].focus();
  });
}

/**
 * registerTool({id, label, icon, shortcut, cursor, onActivate(tab), onDeactivate(tab),
 *               onPointerDown/Move/Up(e, ctx), options}) — enables the placeholder button
 * with the same data-tool (or appends a new one). `options` is ['color','strokeWidth','dash','fontSize']
 * (standard controls bound to state.toolStyle) and/or a factory (container, state) => void.
 * Pointer handlers receive ctx = {tab, hit: viewer.clientToPage(...)} via app.js dispatch.
 */
export function registerTool(def) {
  if (!def?.id) throw new TypeError('registerTool: id required');
  tools.set(def.id, def);
  let b = barEl?.querySelector(`[data-tool="${def.id}"]`);
  if (!b && toolsEl) {
    b = h('button.tb-btn.tool-btn', { type: 'button', dataset: { tool: def.id }, 'aria-pressed': String(state.tool === def.id) });
    addToolbarItem(def.id, b);
  }
  if (b) {
    b.disabled = false;
    const tip = def.shortcut ? `${def.label} (${def.shortcut})` : def.label;
    b.title = tip;
    b.setAttribute('aria-label', tip);
    if (def.icon) b.innerHTML = def.icon.trim().startsWith('<') ? def.icon : icon(def.icon);
    b.onclick = () => toggleTool(def.id);
  }
  return def;
}

export function getTool(id = state.tool) { return tools.get(id) ?? null; }
export function listTools() { return [...tools.values()]; }

/** Toolbar click / shortcut: a second activation of the active tool returns to Select (the default). */
export function toggleTool(id) {
  setTool(id !== 'select' && id === state.tool ? 'select' : id);
}

export function setTool(id) {
  const prev = tools.get(state.tool);
  const next = tools.get(id);
  if (!next || id === state.tool) { renderOptions(); return; }
  prev?.onDeactivate?.();
  state.tool = id;
  next.onActivate?.();
  for (const b of barEl?.querySelectorAll('[data-tool]') ?? []) b.setAttribute('aria-pressed', String(b.dataset.tool === id));
  renderOptions();
  syncMorePressed();
  bus.emit('tool:changed', { tool: id, previous: prev?.id ?? null });
}

const STD = {
  color: () => labelled('Colour', h('input.opt-color', { type: 'color', value: state.toolStyle.color, oninput: (e) => setStyle('color', e.target.value) })),
  strokeWidth: () => labelled('Width', h('input.opt-width', { type: 'range', min: '0.5', max: '12', step: '0.5', value: String(state.toolStyle.strokeWidth), oninput: (e) => setStyle('strokeWidth', Number(e.target.value)) })),
  dash: () => {
    const s = h('select.opt-dash', { onchange: (e) => setStyle('dash', e.target.value) },
      ['solid', 'dashed', 'dotted'].map((d) => h('option', { value: d, selected: state.toolStyle.dash === d }, d[0].toUpperCase() + d.slice(1))));
    return labelled('Line', s);
  },
  fontSize: () => labelled('Size', h('input.opt-font', { type: 'number', min: '4', max: '144', value: String(state.toolStyle.fontSize), onchange: (e) => setStyle('fontSize', Number(e.target.value) || 12) })),
};

function labelled(text, control) { return h('label.opt', {}, h('span', {}, text), control); }
function setStyle(key, value) {
  state.toolStyle[key] = value;
  bus.emit('state:changed', { key: 'toolStyle', value: state.toolStyle });
}

function renderOptions() {
  if (!optionsEl) return;
  optionsEl.replaceChildren();
  const def = tools.get(state.tool);
  const opts = def?.options;
  if (!opts) { optionsEl.hidden = true; return; }
  for (const o of [opts].flat()) {
    if (typeof o === 'function') o(optionsEl, state);
    else if (STD[o]) optionsEl.append(STD[o]());
  }
  optionsEl.hidden = !optionsEl.childElementCount;
}

// ---------------------------------------------------------------- groups, dropdowns, overflow

/** Put a toolbar item (button or wrapper) for `key` into its tool group, in the group's order. */
export function addToolbarItem(key, el) {
  const [gkey, , order] = groupOf(key);
  const group = toolsEl.querySelector(`[data-group="${gkey}"]`);
  el.dataset.tbItem = key;
  const rank = (k) => { const i = order.indexOf(k); return i < 0 ? order.length : i; };
  const after = [...group.children].find((c) => rank(c.dataset.tbItem) > rank(key));
  group.insertBefore(el, after ?? null);
  scheduleLayout();
  return el;
}

/**
 * Toolbar button with a dropdown menu. items() is called on each open and returns
 * [{id, label, action, enabled?: () => bool} | {separator: true}]. Returns {wrap, button, close}.
 */
export function dropdownButton({ id, icon: ic, label, title = label, items }) {
  const button = h('button.tb-btn.tb-dd-btn', { type: 'button', id, title, 'aria-label': title, 'aria-haspopup': 'menu', 'aria-expanded': 'false', html: icon(ic) });
  const menu = h('div.menu.tb-dd-menu', { role: 'menu', 'aria-label': label, hidden: true });
  const wrap = h('div.tb-dd', {}, button, menu);
  const close = (focus) => { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); if (focus) button.focus(); };
  const open = (focus) => {
    menu.replaceChildren(...items().map((it) => (it.separator ? h('div.menu-sep', { role: 'separator' })
      : h('button.menu-item', { type: 'button', role: 'menuitem', dataset: { id: it.id }, disabled: it.enabled ? !it.enabled() : false, onclick: () => { close(); showMore(false); it.action(); } },
        h('span', {}, it.label), h('kbd', {}, it.shortcut ?? '')))));
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    if (focus) menu.querySelector('button:not([disabled])')?.focus();
  };
  button.onclick = () => (menu.hidden ? open() : close());
  button.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); open(true); } });
  menu.addEventListener('keydown', (e) => {
    const list = [...menu.querySelectorAll('button:not([disabled])')];
    const k = list.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); list[(k + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus(); }
  });
  document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !wrap.contains(e.target)) close(); }, true);
  return { wrap, button, close };
}

function showMore(on) {
  if (!morePanel) return;
  morePanel.hidden = !on;
  moreBtn.setAttribute('aria-expanded', String(on));
}
function syncMorePressed() {
  moreBtn?.setAttribute('aria-pressed', String(!!morePanel?.querySelector('[aria-pressed="true"]')));
}

// When the items do not fit on one row, trailing items move (in order) into the More panel;
// each leaves a comment marker so it goes back to the same place when there is room again.
let layoutQueued = false;
function scheduleLayout() {
  if (layoutQueued || !barEl) return;
  layoutQueued = true;
  requestAnimationFrame(() => { layoutQueued = false; layout(); });
}
const items = () => [...barEl.querySelectorAll('.tb-group > *')].filter((el) => !el.classList.contains('tb-group') && !el.classList.contains('tb-sep') && !moreWrap.contains(el));
function fits() {
  const r = barEl.getBoundingClientRect();
  const right = r.right - parseFloat(getComputedStyle(barEl).paddingRight || 0) + 0.5;
  return [...barEl.children].every((c) => c.getBoundingClientRect().right <= right);
}
let observer = null;
function layout() {
  observer?.disconnect();
  for (const el of [...morePanel.children]) { const m = el.__tbMarker; if (m) { m.replaceWith(el); delete el.__tbMarker; } }
  moreWrap.hidden = true;
  if (!fits()) {
    moreWrap.hidden = false;
    const list = items();
    while (list.length && !fits()) {
      const el = list.pop();
      const marker = document.createComment('tb');
      el.replaceWith(marker);
      el.__tbMarker = marker;
      morePanel.prepend(el);
    }
  }
  if (moreWrap.hidden) showMore(false);
  syncMorePressed();
  observer?.observe(barEl, OBS);
  observer?.observe(document.body, { attributes: true, attributeFilter: ['class'] });
}
const OBS = { subtree: true, childList: true, attributes: true, attributeFilter: ['data-label', 'hidden', 'class'] };
function watchOverflow(container) {
  new ResizeObserver(scheduleLayout).observe(container);
  observer = new MutationObserver(scheduleLayout);
  observer.observe(container, OBS);
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
}
