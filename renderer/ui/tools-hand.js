// Hand tool: drag to move the page (pans the viewer's scroll container) with grab / grabbing
// cursors. Q selects it; holding Space is a temporary Hand that returns to the previous tool on
// release (not while typing in a field); a middle-button drag pans in any tool. A click without a
// drag still reaches page links (viewer.js); a drag that panned never clicks.
import { bus } from '../bus.js';
import { state, activeTab } from '../state.js';
import { isTyping } from './dom.js';
import { dialogOpen } from './dialogs.js';
import { addIcon } from './icons.js';
import { registerTool, setTool } from './toolbar.js';
import { viewer } from './viewer.js';

addIcon('hand', '<path d="M8 12.5V6.2a1.4 1.4 0 0 1 2.8 0V11"/><path d="M10.8 10.5V4.6a1.4 1.4 0 0 1 2.8 0v5.9"/><path d="M13.6 10.5V5.8a1.4 1.4 0 0 1 2.8 0v5.7"/><path d="M16.4 11.5V8.4a1.4 1.4 0 0 1 2.8 0v5.3A6.8 6.8 0 0 1 12.4 20.5h-.6a6.4 6.4 0 0 1-4.9-2.3L3.9 14.6a1.4 1.4 0 0 1 2.1-1.9L8 14.6"/>');

const DRAG_PX = 3; // movement before a press becomes a pan (a shorter press stays a click)
const NO_PAN = 'input, textarea, select, button, [contenteditable="true"], .form-ctl';
let pan = null; // {sc, id, x, y, left, top, moved}
let spaceFrom = null; // tool to return to when Space is released

function onPointerDown(e) {
  if (pan) return;
  const tab = activeTab();
  const sc = tab && viewer.getScrollEl(tab);
  if (!sc || !sc.contains(e.target)) return;
  const middle = e.button === 1;
  if (!middle && (e.button !== 0 || state.tool !== 'hand' || e.target.closest(NO_PAN))) return;
  if (middle) { e.preventDefault(); e.stopPropagation(); } // no autoscroll, no tool gesture
  pan = { sc, id: e.pointerId, x: e.clientX, y: e.clientY, left: sc.scrollLeft, top: sc.scrollTop, moved: false };
}

function onPointerMove(e) {
  if (!pan || e.pointerId !== pan.id) return;
  const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
  if (!pan.moved && Math.hypot(dx, dy) < DRAG_PX) return;
  if (!pan.moved) { pan.moved = true; document.body.classList.add('hand-panning'); window.getSelection?.()?.removeAllRanges(); }
  pan.sc.scrollLeft = pan.left - dx;
  pan.sc.scrollTop = pan.top - dy;
}

function onPointerUp(e) {
  if (!pan || e.pointerId !== pan.id) return;
  const moved = pan.moved;
  pan = null;
  document.body.classList.remove('hand-panning');
  if (!moved) return;
  // The click that follows this pointerup (same input event) must not follow a link.
  const swallow = (ev) => { ev.preventDefault(); ev.stopPropagation(); };
  window.addEventListener('click', swallow, true);
  window.addEventListener('auxclick', swallow, true);
  setTimeout(() => { window.removeEventListener('click', swallow, true); window.removeEventListener('auxclick', swallow, true); }, 0);
}

function endSpace() {
  if (spaceFrom == null) return;
  const back = spaceFrom;
  spaceFrom = null;
  if (state.tool === 'hand') setTool(back);
}

export function initHandTool() {
  registerTool({ id: 'hand', label: 'Hand: drag to move the page (hold Space)', icon: 'hand', shortcut: 'Q', cursor: 'grab' });
  bus.on('tool:changed', ({ tool }) => document.body.classList.toggle('hand-pan', tool === 'hand'));
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('pointerup', onPointerUp, true);
  window.addEventListener('pointercancel', onPointerUp, true);
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || dialogOpen() || isTyping(e.target) || !activeTab()) return;
    if (e.key === ' ') {
      e.preventDefault(); // no page-down scroll, no button activation
      if (spaceFrom == null && !e.repeat && state.tool !== 'hand') { spaceFrom = state.tool; setTool('hand'); }
      return;
    }
    if (e.key.toLowerCase() === 'q' && !e.repeat) { e.preventDefault(); spaceFrom = null; setTool('hand'); }
  });
  document.addEventListener('keyup', (e) => {
    if (e.key !== ' ' || spaceFrom == null) return;
    e.preventDefault();
    endSpace();
  });
  window.addEventListener('blur', endSpace);
}
