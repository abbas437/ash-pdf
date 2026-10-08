// Edit text tool (D): edits the document's ORIGINAL text line by line with PDFium (pdfium/textedit.js),
// not an overlay. Lines come from pdfium.textLines on the tab's bytes (cached per page per bytes
// revision, dropped on tab:bytesChanged); hover outlines the line under the pointer (a line that cannot
// be edited shows why in the tooltip); a click opens an inline editor over the line. Enter, Tab or a
// click outside applies, Esc cancels, unchanged text is a no-op.
//
// Applying is one page-operation undo step (runOp, identity map) on tab.bytes as they are: unsaved
// annotations are not written first. They are overlay objects, the identity map keeps them, and Save
// writes them as usual.
import { state, activeTab } from '../state.js';
import { bus } from '../bus.js';
import { h, isTyping } from './dom.js';
import { toast, dialogOpen } from './dialogs.js';
import { runOp } from './pagetools.js';
import { registerTool, toggleTool } from './toolbar.js';
import { viewer } from './viewer.js';
import { pdfium } from '../pdfium/client.js';
import { linePageBox, lineBox, editorPlacement, lineAt, charIndexAt, wordAt } from './textedit-lib.js';

const TOOL = 'textedit';
const NS = 'http://www.w3.org/2000/svg';
const ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7V5h10v2M9 5v12M7 17h4"/><path d="M17 9h4M17 19h4M19 9v10"/></svg>';

/** tab -> { bytes, pages: Map<pageIndex, Promise<{g, lines}>> } */
const cache = new WeakMap();
let editor = null; // { tab, pageIndex, line, input, done }
let swallow = null; // the pointerdown that closed an editor must not open another

/** {g, lines} of page i of the tab's current bytes. */
export function pageLines(tab, i) {
  let c = cache.get(tab);
  if (!c || c.bytes !== tab.bytes) { c = { bytes: tab.bytes, pages: new Map() }; cache.set(tab, c); }
  if (!c.pages.has(i)) {
    const bytes = tab.bytes;
    const p = (async () => {
      const page = await tab.pdfDoc.getPage(i + 1);
      const g = { view: page.view, rotate: page.rotate };
      const id = await pdfium.open(bytes);
      try { return { g, lines: await pdfium.textLines(id, i) }; } finally { await pdfium.close(id).catch(() => {}); }
    })();
    p.catch(() => c.pages.delete(i));
    c.pages.set(i, p);
  }
  return c.pages.get(i);
}

function prefetch(tab) {
  if (!tab?.pdfDoc || state.tool !== TOOL) return;
  for (const i of viewer.renderedPages(tab)) pageLines(tab, i).catch(() => {});
}

// ---------------------------------------------------------------- hover
let hoverEl = null, hoverPage = null;
function clearHover() {
  hoverEl?.remove(); hoverEl = null;
  if (hoverPage) { hoverPage.removeAttribute('title'); hoverPage = null; }
}
async function hover(e, { tab, hit }) {
  if (editor || !hit?.inside) { clearHover(); return; }
  const c = cache.get(tab)?.pages.get(hit.pageIndex);
  if (!c) { pageLines(tab, hit.pageIndex).catch(() => {}); return; }
  const { g, lines } = await c;
  const line = lineAt(g, lines, hit.x, hit.y);
  clearHover();
  if (!line || state.tool !== TOOL) return;
  const svg = viewer.getOverlaySvg(tab, hit.pageIndex);
  const b = linePageBox(g, lineBox(line));
  hoverEl = document.createElementNS(NS, 'rect');
  for (const [k, v] of Object.entries({ x: b.x - 1, y: b.y - 1, width: b.w + 2, height: b.h + 2, class: `te-hover${line.editable ? '' : ' te-locked'}`, fill: 'none', stroke: line.editable ? '#2a6fdb' : '#c0392b', 'stroke-width': 0.75, 'vector-effect': 'non-scaling-stroke', 'pointer-events': 'none' })) hoverEl.setAttribute(k, v);
  svg?.append(hoverEl);
  if (!line.editable) { hoverPage = viewer.getPageEl(tab, hit.pageIndex); hoverPage?.setAttribute('title', `This line cannot be edited: ${line.reason}`); }
}

// ---------------------------------------------------------------- editor
const family = (font = '') => (/courier|mono|cousine/i.test(font) ? 'monospace' : /times|serif|roman|tinos|cambria|caladea|georgia/i.test(font) && !/sans/i.test(font) ? 'serif' : 'sans-serif');
const css = (c) => (Array.isArray(c) ? `rgb(${c[0]}, ${c[1]}, ${c[2]})` : '#000');

async function openEditor(tab, pageIndex, hit) {
  const { g, lines } = await pageLines(tab, pageIndex);
  const line = lineAt(g, lines, hit.x, hit.y);
  if (!line) return;
  if (!line.editable) { toast(`This line cannot be edited: ${line.reason}`); return; }
  const pageEl = viewer.getPageEl(tab, pageIndex);
  if (!pageEl) return;
  clearHover();
  const scale = viewer.scale(tab);
  let p = editorPlacement(g, lineBox(line), line.size, scale);
  if (tab.viewRotation) { // the page element shows the page turned: place by client corners instead
    const b = linePageBox(g, lineBox(line)), r = pageEl.getBoundingClientRect();
    const pts = [[b.x, b.y], [b.x + b.w, b.y + b.h]].map(([x, y]) => viewer.pageToClient(tab, pageIndex, x, y));
    const xs = pts.map((q) => q.clientX - r.left), ys = pts.map((q) => q.clientY - r.top);
    p = { ...p, left: Math.min(...xs), top: Math.min(...ys), width: Math.abs(xs[1] - xs[0]), height: Math.abs(ys[1] - ys[0]) };
  }
  const input = h('input.te-editor', { type: 'text', spellcheck: false, 'aria-label': 'Edit text line' });
  input.value = line.text;
  Object.assign(input.style, {
    position: 'absolute', zIndex: 20, boxSizing: 'border-box', margin: 0, padding: '0 1px', border: '1px solid #2a6fdb', outline: 'none', background: '#fff',
    left: `${p.left - 2}px`, top: `${p.top + p.height / 2 - p.fontSize * 0.65}px`, width: `${Math.max(p.width + 24, 60)}px`, height: `${p.fontSize * 1.3}px`,
    fontSize: `${p.fontSize}px`, lineHeight: 1, fontFamily: family(line.font), color: css(line.color),
  });
  pageEl.append(input);
  editor = { tab, pageIndex, line, input };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); closeEditor(true); } else if (e.key === 'Escape') { e.preventDefault(); closeEditor(false); }
  });
  input.focus();
  const [s, en] = wordAt(line.text, charIndexAt(g, line, hit.x, hit.y));
  input.setSelectionRange(s, en);
}

/** Close the open editor; apply its text when `commit` and it changed. Resolves like applyLineEdit. */
export function closeEditor(commit) {
  if (!editor) return Promise.resolve(false);
  const { tab, pageIndex, line, input } = editor;
  editor = null;
  const text = input.value;
  input.remove();
  return commit && text !== line.text ? applyLineEdit(tab, pageIndex, line, text) : Promise.resolve(false);
}

/** Replace the text of `line` on page `pageIndex` with PDFium: one page undo step. Resolves true when applied. */
export async function applyLineEdit(tab, pageIndex, line, text) {
  let res = null;
  const ok = await runOp(tab, 'Edit text', async (bytes, n) => {
    const id = await pdfium.open(bytes);
    try { res = await pdfium.editLine(id, pageIndex, line.id, text, { incremental: false }); } finally { await pdfium.close(id).catch(() => {}); }
    if (!res?.ok) return null;
    return { bytes: res.bytes, map: new Map(Array.from({ length: n }, (_, i) => [i, i])) };
  });
  if (res && !res.ok) toast(`The text was not changed: ${res.reason}`);
  else if (ok && res.substituted) toast(`‘${line.font}’ was not fully embedded — used ${res.substituted.replace(/\.ttf$/i, '')} for this line`, { timeout: 5000 });
  return ok;
}

// ---------------------------------------------------------------- tool
export function initTextEdit() {
  registerTool({
    id: TOOL, label: 'Edit text (original document text, line by line)', icon: ICON, shortcut: 'D', cursor: 'text',
    onActivate: () => prefetch(activeTab()),
    onDeactivate: () => { clearHover(); closeEditor(true); },
    onPointerMove: hover,
    onPointerDown: (e, ctx) => {
      if (swallow === e) { swallow = null; return; }
      if (e.button !== 0 || !ctx.hit?.inside) return;
      if (ctx.tab.readOnly) { toast('Encrypted document: text editing is not supported'); return; }
      e.preventDefault();
      openEditor(ctx.tab, ctx.hit.pageIndex, ctx.hit).catch((err) => toast(`Edit text: ${err?.message ?? err}`));
    },
  });
  // A click anywhere outside the open editor applies it.
  document.addEventListener('pointerdown', (e) => {
    if (!editor || e.target === editor.input) return;
    swallow = e;
    closeEditor(true);
  }, true);
  bus.on('tab:bytesChanged', ({ tab }) => { cache.delete(tab); clearHover(); });
  bus.on('page:rendered', ({ tab, pageIndex }) => { if (state.tool === TOOL && tab?.pdfDoc) pageLines(tab, pageIndex).catch(() => {}); });
  bus.on('tool:changed', ({ tool }) => document.body.classList.toggle('textedit-tool', tool === TOOL));
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || dialogOpen() || isTyping(e.target) || !activeTab()) return;
    if (e.key.toLowerCase() === 'd') { e.preventDefault(); toggleTool(TOOL); }
  });
}
