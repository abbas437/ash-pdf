// Main toolbar, tool registry and the contextual tool-options bar.
import { bus } from '../bus.js';
import { state } from '../state.js';
import { h } from './dom.js';
import { icon } from './icons.js';

const tools = new Map(); // id -> tool definition
let toolsEl = null;
let optionsEl = null;

const PLACEHOLDERS = [
  ['select', 'Select', 'select'], ['text', 'Text', 'text'], ['highlight', 'Highlight', 'highlight'],
  ['draw', 'Draw', 'draw'], ['shapes', 'Shapes', 'shapes'], ['image', 'Image', 'image'],
  ['whiteout', 'Whiteout', 'whiteout'], ['stamp', 'Stamp', 'stamp'], ['callout', 'Callout', 'callout'],
  ['forms', 'Forms', 'forms'], ['pages', 'Pages', 'pages'],
];

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
  toolsEl = h('div.tb-group.tb-tools', { role: 'group', 'aria-label': 'Editing tools' });
  for (const [id, label, ic] of PLACEHOLDERS) {
    toolsEl.append(h('button.tb-btn.tool-btn', { type: 'button', disabled: true, dataset: { tool: id }, title: `${label}: added in next build`, 'aria-label': `${label} (added in next build)`, 'aria-pressed': 'false', html: icon(ic) }));
  }
  container.append(h('span.tb-sep', { role: 'separator' }), toolsEl);
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
  let b = toolsEl?.querySelector(`[data-tool="${def.id}"]`);
  if (!b && toolsEl) {
    b = h('button.tb-btn.tool-btn', { type: 'button', dataset: { tool: def.id } });
    toolsEl.append(b);
  }
  if (b) {
    b.disabled = false;
    const tip = def.shortcut ? `${def.label} (${def.shortcut})` : def.label;
    b.title = tip;
    b.setAttribute('aria-label', tip);
    if (def.icon) b.innerHTML = def.icon.trim().startsWith('<') ? def.icon : icon(def.icon);
    b.onclick = () => setTool(def.id);
  }
  return def;
}

export function getTool(id = state.tool) { return tools.get(id) ?? null; }
export function listTools() { return [...tools.values()]; }

export function setTool(id) {
  const prev = tools.get(state.tool);
  const next = tools.get(id);
  if (!next || id === state.tool) { renderOptions(); return; }
  prev?.onDeactivate?.();
  state.tool = id;
  next.onActivate?.();
  for (const b of toolsEl?.querySelectorAll('[data-tool]') ?? []) b.setAttribute('aria-pressed', String(b.dataset.tool === id));
  renderOptions();
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
