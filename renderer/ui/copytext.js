// Copy of selected page text. The renderer has no clipboard of its own: every permission is
// denied, which makes document.execCommand('copy') fail, so text goes through api.copyText
// (main: clipboard.writeText). Ctrl+C / Edit > Copy / the page context menu copy the text
// selection when it is non-empty and inside a pdf.js text layer; otherwise Ctrl+C falls
// through to the annotation object copy (annotations.js).
import { h, isTyping } from './dom.js';
import { toast } from './dialogs.js';

/** Text selected in a page text layer, or '' when there is none. */
export function selectedPageText() {
  const sel = window.getSelection?.();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return '';
  const node = sel.getRangeAt(0).commonAncestorContainer;
  const el = node.nodeType === 1 ? node : node.parentElement;
  if (!el?.closest?.('.textLayer, .page, .pages')) return '';
  return sel.toString();
}

/** Copy the page text selection; true when something was copied. */
export async function copySelection() {
  const text = selectedPageText();
  if (!text) return false;
  try { await window.api.copyText(text); return true; } catch (err) { toast(`Could not copy: ${err?.message ?? err}`); return false; }
}

/** Select every text span of the page currently shown (Ctrl+A in the viewer). */
function selectPageText(app) {
  const tab = app.state.tabs.find((t) => t.id === app.state.activeId);
  const div = tab && app.viewer.getPageState(tab, tab.currentPage)?.textLayerDiv;
  if (!div) return;
  const range = document.createRange();
  range.selectNodeContents(div);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

let menu = null;
function closeMenu() { menu?.remove(); menu = null; }

export function initCopyText(app) {
  // Capture phase: runs before annotations.js, so a text selection wins over selected objects.
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || isTyping(e.target)) return;
    const k = e.key.toLowerCase();
    if (k === 'c' && selectedPageText()) { e.preventDefault(); e.stopPropagation(); copySelection(); }
    else if (k === 'a' && e.target.closest?.('.viewer-scroll')) { e.preventDefault(); e.stopPropagation(); selectPageText(app); }
  }, true);
  document.addEventListener('contextmenu', (e) => {
    closeMenu();
    if (!e.target.closest?.('.viewer-host') || !selectedPageText()) return;
    e.preventDefault();
    const item = h('button.menu-item', { type: 'button', role: 'menuitem' }, h('span', {}, 'Copy'), h('kbd', {}, 'Ctrl+C'));
    item.addEventListener('click', () => { closeMenu(); copySelection(); });
    menu = h('div.menu.context-menu', { role: 'menu', 'aria-label': 'Page text', style: { position: 'fixed', left: `${e.clientX}px`, top: `${e.clientY}px` } }, item);
    document.body.append(menu);
    item.focus();
  });
  document.addEventListener('mousedown', (e) => { if (menu && !menu.contains(e.target)) closeMenu(); });
  document.addEventListener('keydown', (e) => { if (menu && e.key === 'Escape') closeMenu(); });
}
