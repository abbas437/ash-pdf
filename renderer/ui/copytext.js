// Cut / Copy / Paste for the page (Ctrl+X / C / V and the page context menu) and for text fields.
// The renderer has no clipboard of its own: every permission is denied, which makes
// navigator.clipboard and document.execCommand('copy') fail, so the system clipboard is reached
// through api.copyText / api.readText (main: clipboard.writeText / readText).
//   Copy: a page text selection (pdf.js text layer) wins; otherwise the selected annotation objects
//     go to the app's object clipboard and their text summary to the system clipboard.
//   Cut: selected objects only (copy + delete, one undo step); original PDF text cannot be cut.
//   Paste (at the right-click point, or the view centre for Ctrl+V): the copied objects while the
//     system clipboard still holds their summary (clipboard-lib.js), else a text box with the
//     clipboard text in the current text style.
//   Text fields outside dialogs (inputs, textareas, the Edit text editor): Ctrl+X / C / V go through
//     the same IPC so they behave alike in Electron and the browser shim; the page menu leaves them alone.
import { h, isTyping } from './dom.js';
import { toast, dialogOpen } from './dialogs.js';
import { activeTab } from '../state.js';
import { viewer } from './viewer.js';
import { annotations, copyObjects, cutObjects, pasteObjects, objectClipboardSummary, objectAtPoint } from './annotations.js';
import { addTextBox } from './tools-text.js';
import { clipboardMatches } from './clipboard-lib.js';

const CUT_TEXT_TIP = 'Use Edit text (D) to change the document\'s text';

/** Text selected in a page text layer, or '' when there is none. */
export function selectedPageText() {
  const sel = window.getSelection?.();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return '';
  const node = sel.getRangeAt(0).commonAncestorContainer;
  const el = node.nodeType === 1 ? node : node.parentElement;
  if (!el?.closest?.('.textLayer, .page, .pages')) return '';
  return sel.toString();
}

async function writeText(text) {
  try { await window.api.copyText(text); return true; } catch (err) { toast(`Could not copy: ${err?.message ?? err}`); return false; }
}
/** Copy the page text selection; true when something was copied. */
export async function copySelection() {
  const text = selectedPageText();
  return text ? writeText(text) : false;
}

/** Copy: page text, else the selected objects. */
async function copy(tab) {
  if (selectedPageText()) return copySelection();
  const summary = tab ? copyObjects(tab) : '';
  return summary ? writeText(summary) : false;
}
async function cut(tab) {
  if (!tab || tab.readOnly || selectedPageText()) return false;
  const summary = cutObjects(tab);
  return summary ? writeText(summary) : false;
}
/** Paste at `target` {page, x, y} (page points). */
async function paste(tab, target) {
  if (!tab || tab.readOnly || !target) return false;
  let text = '';
  try { text = await window.api.readText(); } catch (err) { toast(`Could not paste: ${err?.message ?? err}`); return false; }
  if (clipboardMatches(objectClipboardSummary(), text)) return pasteObjects(tab, target);
  if (text) { addTextBox(tab, target.page, target.x, target.y, text); return true; }
  toast('The clipboard has nothing to paste');
  return false;
}
/** Paste point for the keyboard: the centre of the view, on the page there (else the current page's centre). */
function viewCentre(tab) {
  const r = document.querySelector('.viewer-scroll:not([hidden])')?.getBoundingClientRect();
  const hit = r && viewer.clientToPage(tab, r.left + r.width / 2, r.top + r.height / 2);
  if (hit) return { page: hit.pageIndex, x: hit.x, y: hit.y };
  const P = viewer.pageSize(tab, tab.currentPage);
  return { page: tab.currentPage, x: P.width / 2, y: P.height / 2 };
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

// ---------------------------------------------------------------- text fields
/** Ctrl+X / C / V in a text input, textarea or contenteditable through the clipboard IPC. */
function fieldClipboard(e, k) {
  const el = e.target;
  const field = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
  if (field && el.selectionStart == null) return; // input types without a text selection: native
  if (!field && !el.isContentEditable) return;
  e.preventDefault();
  e.stopPropagation();
  const selected = field ? el.value.slice(el.selectionStart, el.selectionEnd) : (window.getSelection()?.toString() ?? '');
  if (k === 'v') {
    if (el.readOnly) return;
    window.api.readText().then((text) => { if (text && document.activeElement === el) document.execCommand('insertText', false, text); },
      (err) => toast(`Could not paste: ${err?.message ?? err}`));
    return;
  }
  if (!selected) return;
  writeText(selected);
  if (k === 'x' && !el.readOnly) document.execCommand('delete');
}

// ---------------------------------------------------------------- context menu
let menu = null; // { el, origin }
function closeMenu(refocus = false) {
  if (!menu) return;
  const { el, origin } = menu;
  menu = null;
  el.remove();
  if (refocus && origin?.isConnected) origin.focus();
}
function onMenuKey(e) {
  if (!menu) return;
  const items = [...menu.el.querySelectorAll('button:not(:disabled)')];
  const k = items.indexOf(document.activeElement);
  if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault(); e.stopPropagation();
    items[(k + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  } else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); e.stopPropagation(); items[e.key === 'Home' ? 0 : items.length - 1]?.focus(); }
}
function openMenu(e, tab) {
  const hit = viewer.clientToPage(tab, e.clientX, e.clientY);
  const target = hit ? { page: hit.pageIndex, x: hit.x, y: hit.y } : viewCentre(tab);
  const textSel = selectedPageText();
  if (hit && !textSel) { // right-click on an object selects it (unless it is already selected)
    const o = objectAtPoint(tab, hit.pageIndex, hit.x, hit.y);
    if (o && !annotations.getSelection(tab).includes(o.id)) annotations.select(tab, [o.id]);
  }
  const sel = annotations.getSelection(tab), ro = !!tab.readOnly;
  const onPage = annotations.list(tab, target.page);
  const entries = [
    ['cut', 'Cut', 'Ctrl+X', () => cut(tab), ro || !!textSel || !sel.length, textSel ? CUT_TEXT_TIP : null],
    ['copy', 'Copy', 'Ctrl+C', () => copy(tab), !textSel && !sel.length],
    ['paste', 'Paste', 'Ctrl+V', () => paste(tab, target), ro],
    null,
    ['delete', 'Delete', 'Del', () => annotations.remove(tab, sel), ro || !!textSel || !sel.length],
    ['select-all', 'Select all', '', () => annotations.select(tab, onPage.map((o) => o.id)), !onPage.length],
  ];
  const el = h('div.menu.context-menu.page-context-menu', { role: 'menu', 'aria-label': 'Edit', style: { position: 'fixed' } });
  for (const it of entries) {
    if (!it) { el.append(h('div.menu-sep', { role: 'separator' })); continue; }
    const [id, text, key, action, disabled, title] = it;
    const b = h('button.menu-item', { type: 'button', role: 'menuitem', dataset: { action: id }, disabled, title }, h('span', {}, text), h('kbd', {}, key));
    b.addEventListener('click', () => { closeMenu(true); action(); });
    el.append(b);
  }
  document.body.append(el);
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(4, Math.min(e.clientX, innerWidth - r.width - 4))}px`;
  el.style.top = `${Math.max(4, Math.min(e.clientY, innerHeight - r.height - 4))}px`;
  menu = { el, origin: document.querySelector('.viewer-scroll:not([hidden])') };
  el.querySelector('button:not(:disabled)')?.focus();
}

export function initCopyText(app) {
  // Capture phase: runs before annotations.js and the tools' own key handlers.
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    const k = e.key.toLowerCase();
    // In dialogs text fields stay native: the signature dialogs take pasted images from the paste event.
    if (isTyping(e.target)) { if ((k === 'x' || k === 'c' || k === 'v') && !dialogOpen()) fieldClipboard(e, k); return; }
    if (k === 'a' && e.target.closest?.('.viewer-scroll')) { e.preventDefault(); e.stopPropagation(); selectPageText(app); return; }
    if (k !== 'x' && k !== 'c' && k !== 'v') return;
    const tab = activeTab();
    if (k === 'c' && selectedPageText()) { e.preventDefault(); e.stopPropagation(); copySelection(); return; }
    if (!tab || dialogOpen() || e.target.closest?.('.tabstrip, .menubar')) return;
    const sel = annotations.getSelection(tab);
    if (k === 'c' && sel.length) { e.preventDefault(); e.stopPropagation(); copy(tab); }
    else if (k === 'x' && sel.length && !tab.readOnly) { e.preventDefault(); e.stopPropagation(); cut(tab); }
    else if (k === 'v' && !tab.readOnly) { e.preventDefault(); e.stopPropagation(); paste(tab, viewCentre(tab)); }
  }, true);
  document.addEventListener('contextmenu', (e) => {
    closeMenu();
    const tab = activeTab();
    if (!tab || isTyping(e.target) || !e.target.closest?.('.viewer-host') || dialogOpen()) return; // text fields keep their own menu
    e.preventDefault();
    openMenu(e, tab);
  });
  document.addEventListener('mousedown', (e) => { if (menu && !menu.el.contains(e.target)) closeMenu(); }, true);
  document.addEventListener('keydown', onMenuKey, true);
  window.addEventListener('blur', () => closeMenu());
}
