// Context menu of the in-place text editor (Text tool boxes and callout comments): Cut / Copy / Paste
// (plain text) / Select all, Bold / Italic / Underline / Strikethrough, and Font / Size / Colour
// submenus. Formatting goes through the editor handle (applyStyle) and acts on the selection, or on the
// whole box when the selection is collapsed. Right-click on a word with no selection selects it first.
// The keyboard focus stays in the editor while the menu is open (items are highlighted, not focused),
// so opening or using the menu never commits the editor or loses its selection; the selection is
// restored before every action. The only focusable controls are the Size "Custom…" field and the
// native colour input; tools-text spares `.menu` in its blur / pointerdown rules for them.
// preventDefault on the DOM contextmenu event also stops Electron's native editable-field menu.
//
// Exports: initTextMenu().
import { h } from './dom.js';
import { toast } from './dialogs.js';
import { activeTextEditor } from './tools-text.js';
import { COLORS } from './tools-callout.js';

const FONTS = ['Helvetica', 'Times', 'Courier'];
const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36];
const SWATCHES = [['#000000', 'Black'], ...COLORS, ['#7c3aed', 'Purple'], ['#6b7280', 'Grey'], ['#ffffff', 'White']];
const WORD = /[\p{L}\p{N}_'’-]/u;

let menu = null; // { ed, sel, off, levels: [{ el, items, k }] }

/** Model offset under client point (x, y) in the editor, or null. */
function offsetAt(ed, x, y) {
  const r = document.caretRangeFromPoint?.(x, y);
  if (!r || !ed.el.contains(r.startContainer)) return null;
  const s = window.getSelection();
  const keep = s.rangeCount ? s.getRangeAt(0).cloneRange() : null;
  s.collapse(r.startContainer, r.startOffset);
  const at = ed.getSelection().start;
  s.removeAllRanges();
  if (keep) s.addRange(keep);
  return at;
}
/** Word [start, end) around offset `at` in `text`, or null on whitespace / punctuation. */
function wordAt(text, at) {
  let a = at, b = at;
  while (a > 0 && WORD.test(text[a - 1])) a--;
  while (b < text.length && WORD.test(text[b])) b++;
  return b > a ? { start: a, end: b } : null;
}

/** Close the menu; `restore` puts the editor's focus and selection back (Esc, Tab, actions). */
function close(restore = true) {
  if (!menu) return;
  const { ed, sel, off } = menu;
  off();
  menu.levels[0].el.remove();
  ed.el.removeAttribute('aria-activedescendant');
  menu = null;
  if (restore && ed.el.isConnected) ed.setSelection(sel.start, sel.end);
}
/** Put the editor's focus and selection back, run `fn`, keep the (possibly moved) selection. */
function run(fn) {
  const { ed, sel } = menu;
  close();
  fn(ed, sel);
}

let uid = 0;
function item(label, { check, sub, action, disabled, kbd } = {}) {
  const b = h('button.menu-item', { type: 'button', role: 'menuitem', tabindex: '-1', id: `tm-${++uid}`, disabled: !!disabled },
    h('span', {}, label), h('kbd', {}, sub ? '▸' : kbd ?? ''));
  if (check != null) { b.setAttribute('role', 'menuitemcheckbox'); b.setAttribute('aria-checked', String(!!check)); }
  if (sub) { b.setAttribute('aria-haspopup', 'menu'); b._sub = sub; }
  b._action = action;
  return b;
}

/** Menu entries for the current editor state. */
function entries(ed, sel) {
  const st = ed.styleAtSelection();
  const has = sel.end > sel.start;
  const text = has ? ed.getText().slice(sel.start, sel.end) : '';
  const style = (patch) => () => run((e) => e.applyStyle(patch));
  const toggle = (k) => style({ [k]: !st[k] });
  const sizeSub = () => {
    const custom = h('input.tm-size', { type: 'number', min: '4', max: '144', step: '0.5', value: String(st.fontSize), 'aria-label': 'Custom size (pt)' });
    custom.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== 'Escape') return;
      e.preventDefault(); e.stopPropagation();
      const v = Number(custom.value);
      if (e.key === 'Enter' && v >= 4 && v <= 144) run((ed2) => ed2.applyStyle({ fontSize: v })); else close();
    });
    const customItem = item('Custom…', { action: () => { customRow.hidden = false; custom.focus(); custom.select(); } });
    const customRow = h('div.tm-custom', { hidden: true }, custom, h('span', {}, 'pt'));
    return [...SIZES.map((n) => item(String(n), { check: st.fontSize === n, action: style({ fontSize: n }) })), null, customItem, customRow];
  };
  const colourSub = () => {
    const grid = h('div.tm-swatches', { role: 'group', 'aria-label': 'Colours' });
    for (const [hex, label] of SWATCHES) {
      const b = item('', { check: String(st.color).toLowerCase() === hex, action: style({ color: hex }) });
      b.classList.add('tm-swatch');
      b.dataset.color = hex;
      b.title = label;
      b.setAttribute('aria-label', label);
      b.style.setProperty('--chip', hex);
      grid.append(b);
    }
    const input = h('input.tm-color', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(st.color) ? st.color : '#000000', 'aria-label': 'Custom colour', tabindex: '-1' });
    input.addEventListener('change', () => run((e) => e.applyStyle({ color: input.value })));
    const customItem = item('Custom…', { action: () => { menu.picking = true; input.click(); } });
    return [grid, null, customItem, input];
  };
  return [
    item('Cut', { kbd: 'Ctrl+X', disabled: !has, action: () => run(async () => {
      try { await window.api.copyText(text); } catch (err) { toast(`Could not copy: ${err?.message ?? err}`); return; }
      document.execCommand('delete');
    }) }),
    item('Copy', { kbd: 'Ctrl+C', disabled: !has, action: () => run(() => window.api.copyText(text).catch((err) => toast(`Could not copy: ${err?.message ?? err}`))) }),
    item('Paste', { kbd: 'Ctrl+V', action: () => run(async (e) => {
      let str = '';
      try { str = await window.api.readText(); } catch (err) { toast(`Could not paste: ${err?.message ?? err}`); return; }
      if (str && document.activeElement === e.el) document.execCommand('insertText', false, str.replace(/\r\n?/g, '\n'));
    }) }),
    item('Select all', { kbd: 'Ctrl+A', action: () => run((e) => e.setSelection(0, e.getText().length)) }),
    null,
    item('Bold', { kbd: 'Ctrl+B', check: st.bold, action: toggle('bold') }),
    item('Italic', { kbd: 'Ctrl+I', check: st.italic, action: toggle('italic') }),
    item('Underline', { kbd: 'Ctrl+U', check: st.underline, action: toggle('underline') }),
    item('Strikethrough', { check: st.strike, action: toggle('strike') }),
    null,
    item('Font', { sub: () => FONTS.map((f) => item(f, { check: st.font === f, action: style({ font: f }) })) }),
    item('Size', { sub: sizeSub }),
    item('Colour', { sub: colourSub }),
  ];
}

function buildLevel(list, cls) {
  const el = h(`div.menu.context-menu.text-context-menu${cls}`, { role: 'menu', 'aria-label': 'Text', style: { position: 'fixed' } });
  for (const it of list) el.append(it ?? h('div.menu-sep', { role: 'separator' }));
  return { el, items: [...el.querySelectorAll('button.menu-item')], k: -1 };
}
function place(el, x, y, alt) {
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(4, x + r.width > innerWidth - 4 && alt != null ? alt - r.width : Math.min(x, innerWidth - r.width - 4))}px`;
  el.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
}
/** Highlight item k of level `li` (closing deeper levels); open: 'hover' opens its submenu, 'enter' also highlights the submenu's first item. */
function highlight(li, k, open) {
  while (menu.levels.length > li + 1) menu.levels.pop().el.remove();
  const L = menu.levels[li];
  for (const b of L.items) b.classList.remove('active');
  L.k = k;
  const b = L.items[k];
  if (!b) return;
  b.classList.add('active');
  menu.ed.el.setAttribute('aria-activedescendant', b.id);
  if (open && b._sub && !b.disabled) {
    const S = buildLevel(b._sub(), '.text-submenu');
    S.parent = b;
    menu.levels.push(S);
    menu.levels[0].el.append(S.el);
    const r = b.getBoundingClientRect();
    place(S.el, r.right + 2, r.top - 4, r.left - 2);
    if (open === 'enter') highlight(li + 1, 0);
  }
}
function activate(b) {
  if (!b || b.disabled) return;
  const li = menu.levels.findIndex((L) => L.items.includes(b));
  if (b._sub) highlight(li, menu.levels[li].items.indexOf(b), 'enter');
  else b._action?.();
}

function onKey(e) {
  if (!menu) return;
  if (e.target.closest?.('.tm-custom')) return; // the Custom size field handles its own keys
  const li = menu.levels.length - 1, L = menu.levels[li];
  const stop = () => { e.preventDefault(); e.stopPropagation(); };
  const n = L.items.length, enabled = (k, d) => { for (let i = 0; i < n; i++) { k = (k + d + n) % n; if (!L.items[k].disabled) return k; } return -1; };
  if (e.key === 'Escape' || e.key === 'ArrowLeft') {
    stop();
    if (li > 0) { const p = menu.levels[li - 1]; highlight(li - 1, p.k); } else if (e.key === 'Escape') close();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { stop(); const k = enabled(L.k < 0 && e.key === 'ArrowUp' ? 0 : L.k, e.key === 'ArrowDown' ? 1 : -1); highlight(li, k); } else if (e.key === 'Home' || e.key === 'End') { stop(); highlight(li, e.key === 'Home' ? enabled(n - 1, 1) : enabled(0, -1)); } else if (e.key === 'ArrowRight') { stop(); if (L.items[L.k]?._sub) highlight(li, L.k, 'enter'); } else if (e.key === 'Enter' || e.key === ' ') { stop(); activate(L.items[L.k]); } else if (e.key === 'Tab') { stop(); close(); } else if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) close();
}

function open(e, ed) {
  e.preventDefault();
  e.stopPropagation();
  let sel = ed.getSelection();
  const at = offsetAt(ed, e.clientX, e.clientY);
  if (at != null && !(sel.end > sel.start && at >= sel.start && at <= sel.end)) sel = wordAt(ed.getText(), at) ?? { start: at, end: at };
  ed.setSelection(sel.start, sel.end);
  menu = { ed, sel, levels: [], off: ed.onClose(() => close(false)) }; // the menu never outlives its editor
  const L = buildLevel(entries(ed, sel), '');
  menu.levels.push(L);
  document.body.append(L.el);
  place(L.el, e.clientX, e.clientY);
  // Pointer: hover highlights (and opens submenus), click acts; mousedown never takes the focus.
  L.el.addEventListener('mousedown', (ev) => { if (!ev.target.closest('input')) ev.preventDefault(); });
  L.el.addEventListener('mouseover', (ev) => {
    const b = ev.target.closest('button.menu-item');
    if (!b || !menu) return;
    const li = menu.levels.findIndex((M) => M.items.includes(b));
    if (li >= 0 && menu.levels[li].k !== menu.levels[li].items.indexOf(b)) highlight(li, menu.levels[li].items.indexOf(b), 'hover');
  });
  L.el.addEventListener('click', (ev) => { const b = ev.target.closest('button.menu-item'); if (b) activate(b); });
}

export function initTextMenu() {
  document.addEventListener('contextmenu', (e) => {
    if (menu) close(false);
    const ed = activeTextEditor();
    if (!ed || !ed.el.contains(e.target)) return;
    open(e, ed);
  }, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', (e) => { if (menu && !menu.levels[0].el.contains(e.target)) close(false); }, true);
  // Switching apps closes the menu, but not while the native colour picker (or the Custom size field) is up.
  window.addEventListener('blur', () => { if (menu && !menu.picking && !menu.levels[0].el.contains(document.activeElement)) close(false); });
}

export const textMenu = { isOpen: () => !!menu };
