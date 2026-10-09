// Main toolbar, tool registry and the contextual tool-options bar.
import { bus } from '../bus.js';
import { state } from '../state.js';
import { h, fitPopover } from './dom.js';
import { icon } from './icons.js';

const tools = new Map(); // id -> tool definition
let toolsEl = null;
let optionsEl = null;

let barEl = null;
let moreWrap = null, morePanel = null, moreBtn = null;

// Tool groups, left to right; ids not listed here go to Edit. Items keep this order in every group.
// Pages and View (Split) come early so they are the last to overflow into More.
const GROUPS = [
  ['navigate', 'Navigate', ['select', 'hand']],
  ['pages', 'Pages', ['pages']],
  ['view', 'View', ['split']],
  ['edit', 'Edit', ['text', 'textedit', 'image', 'image-edit', 'whiteout', 'redact', 'forms']],
  ['comment', 'Comment', ['highlight', 'text-highlight', 'underline', 'strikeout', 'squiggly', 'note', 'callout', 'markup', 'draw', 'shapes']],
  ['sign', 'Stamp and sign', ['stamp', 'sign']],
];
const groupOf = (id) => GROUPS.find((g) => g[2].includes(id)) ?? GROUPS.find((g) => g[0] === 'edit');

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
    toolsEl.append(h('div.tb-group.tb-tg', { role: 'group', 'aria-label': label, dataset: { group: key, grp: key } }));
  }
  moreBtn = h('button.tb-btn.tb-more-btn', { type: 'button', title: 'More', 'aria-label': 'More tools', 'aria-haspopup': 'true', 'aria-expanded': 'false', html: '<span class="tb-more-glyph" aria-hidden="true">\u00bb</span>' });
  morePanel = h('div.tb-more-panel', { role: 'group', 'aria-label': 'More tools', hidden: true });
  moreWrap = h('div.tb-more', { hidden: true }, moreBtn, morePanel);
  moreBtn.onclick = () => showMore(morePanel.hidden);
  morePanel.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b?.classList.contains('tb-btn') && !b.hasAttribute('aria-haspopup')) showMore(false); });
  document.addEventListener('pointerdown', (e) => { if (!morePanel.hidden && !moreWrap.contains(e.target)) showMore(false); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !morePanel.hidden) { showMore(false); moreBtn.focus(); } });
  window.addEventListener('resize', () => { if (!morePanel.hidden) showMore(false); });
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
    // Only what is shown: not the closed More panel nor a closed menu.
    const items = [...container.querySelectorAll('button:not([disabled]), select')].filter((el) => el.getClientRects().length);
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
  const leaving = id !== 'select' && id === state.tool;
  if (leaving) bus.emit('annotations:clearSelection'); // the object just drawn must not keep Select's options row open
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
  optionsEl.hidden = !optionsEl.childElementCount || (def.optionsWhen && !def.optionsWhen());
}

// ---------------------------------------------------------------- groups, dropdowns, overflow

/** Put a toolbar item (button or wrapper) for `key` into its tool group, in the group's order. */
export function addToolbarItem(key, el) {
  const [gkey, , order] = groupOf(key);
  const group = toolsEl.querySelector(`[data-group="${gkey}"]`);
  el.dataset.tbItem = key;
  el.dataset.grp = gkey; // keeps the group colour when the item moves into More
  const rank = (k) => { const i = order.indexOf(k); return i < 0 ? order.length : i; };
  const after = [...group.children].find((c) => rank(c.dataset.tbItem) > rank(key));
  group.insertBefore(el, after ?? null);
  scheduleLayout();
  return el;
}

const CARET = '<svg class="icon tb-dd-caret" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true" focusable="false"><path d="M2 3.5l3 3 3-3"/></svg>';

/**
 * Toolbar button (icon, visible label, caret) with a dropdown menu. items() is called on each open
 * and returns [{id, label, action, enabled?: () => bool} | {separator: true}]. Keyboard: Enter, Space
 * or ArrowDown opens it on the first item; ArrowUp/ArrowDown/Home/End move; Esc closes back to the
 * button; Tab away closes. Returns {wrap, button, close}.
 */
export function dropdownButton({ id, icon: ic, label, title = label, items }) {
  const button = h('button.tb-btn.tb-dd-btn', { type: 'button', id, title, 'aria-label': title, 'aria-haspopup': 'menu', 'aria-expanded': 'false',
    html: `${icon(ic)}<span class="tb-dd-label">${label}</span>${CARET}` });
  const menu = h('div.menu.tb-dd-menu', { role: 'menu', 'aria-label': label, hidden: true });
  const wrap = h('div.tb-dd', {}, button, menu);
  const close = (focus) => {
    if (menu.hidden) return;
    menu.hidden = true;
    menu.replaceChildren(); // hidden items must not join the toolbar's arrow-key roving
    button.setAttribute('aria-expanded', 'false');
    if (focus) button.focus();
  };
  const open = (focus) => {
    menu.replaceChildren(...items().map((it) => (it.separator ? h('div.menu-sep', { role: 'separator' })
      : h('button.menu-item', { type: 'button', role: 'menuitem', tabindex: '-1', dataset: { id: it.id }, disabled: it.enabled ? !it.enabled() : false, onclick: () => { close(); showMore(false); it.action(); } },
        h('span', {}, it.label), h('kbd', {}, it.shortcut ?? '')))));
    menu.hidden = false;
    fitPopover(menu, button);
    button.setAttribute('aria-expanded', 'true');
    if (focus) menu.querySelector('button:not([disabled])')?.focus();
  };
  button.onclick = () => (menu.hidden ? open() : close());
  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); open(true); }
    else if (e.key === 'Escape' && !menu.hidden) { e.preventDefault(); e.stopPropagation(); close(true); }
  });
  menu.addEventListener('keydown', (e) => {
    const list = [...menu.querySelectorAll('button:not([disabled])')];
    const k = list.indexOf(document.activeElement);
    const go = (i) => list[(i + list.length) % list.length]?.focus();
    if (e.key === 'Escape') close(true);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') go(k + (e.key === 'ArrowDown' ? 1 : -1));
    else if (e.key === 'Home' || e.key === 'End') go(e.key === 'Home' ? 0 : -1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { /* stay in the menu */ }
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  window.addEventListener('resize', () => close());
  wrap.addEventListener('focusout', (e) => { if (!wrap.contains(e.relatedTarget)) close(); });
  document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !wrap.contains(e.target)) close(); }, true);
  return { wrap, button, close };
}

function showMore(on) {
  if (!morePanel) return;
  morePanel.hidden = !on;
  if (on) fitPopover(morePanel, moreBtn);
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
  // Opening or filling a dropdown menu (Pages, Split, Sign) changes no widths; relaying out then
  // would move a menu that sits in the More panel and drop its focus.
  // Showing or hiding the More panel itself changes no widths either.
  const idle = (r) => r.target.closest?.('[role="menu"]') || (r.target === morePanel && r.attributeName === 'hidden');
  observer = new MutationObserver((recs) => { if (recs.some((r) => !idle(r))) scheduleLayout(); });
  observer.observe(container, OBS);
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
}
