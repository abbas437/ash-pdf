// Reading mode (View > Reading mode, Ctrl+H) and window full screen (View > Full screen, F11).
// Reading mode hides all chrome via body.reading-mode (styles.css), fits the page width and shows a
// floating control strip while the mouse moves. Nothing is persisted between sessions.
import { bus } from '../bus.js';
import { h } from './dom.js';
import { icon } from './icons.js';
import { state, activeTab } from '../state.js';
import { viewer } from './viewer.js';

const STRIP_MS = 2000;
const LINE = 60; // px per arrow-key scroll step

export function initReadMode({ registerMenuItem, api }) {
  let saved = null;      // {tab, zoom, zoomMode} taken on entry
  let fullScreen = false;
  let hideTimer = 0;

  const label = h('span.rm-page', { 'aria-live': 'polite' });
  const b = (ic, title, fn, id) => h('button.rm-btn', { type: 'button', title, 'aria-label': title, id, html: icon(ic), onclick: fn });
  const withTab = (fn) => () => { const t = activeTab(); if (t?.view) fn(t); };
  const strip = h('div.rm-strip', { role: 'toolbar', 'aria-label': 'Reading controls', hidden: true },
    b('prev', 'Previous page', withTab((t) => viewer.prevPage(t)), 'rm-prev'), label,
    b('next', 'Next page', withTab((t) => viewer.nextPage(t)), 'rm-next'),
    b('zoomOut', 'Zoom out', withTab((t) => viewer.zoomOut(t)), 'rm-zoomout'),
    b('zoomIn', 'Zoom in', withTab((t) => viewer.zoomIn(t)), 'rm-zoomin'),
    b('fitWidth', 'Fit width', withTab((t) => viewer.setZoom(t, 'fit-width')), 'rm-fitwidth'),
    b('fitPage', 'Fit page', withTab((t) => viewer.setZoom(t, 'fit-page')), 'rm-fitpage'),
    b('close', 'Exit reading mode (Esc)', () => setReading(false), 'rm-exit'));
  document.body.append(strip);

  const refreshLabel = () => {
    const t = activeTab();
    label.textContent = t ? `${t.currentPage + 1} / ${t.numPages}` : '';
  };
  const showStrip = () => {
    refreshLabel();
    strip.hidden = false;
    strip.classList.add('on');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { strip.classList.remove('on'); }, STRIP_MS);
  };
  const onMove = (e) => {
    // Hold the strip open while the pointer is over it.
    if (strip.contains(e.target)) { clearTimeout(hideTimer); strip.classList.add('on'); return; }
    showStrip();
  };

  const inReading = () => document.body.classList.contains('reading-mode');
  function setReading(on) {
    if (on === inReading()) return;
    if (on) {
      const tab = activeTab();
      if (!tab?.view) return;
      saved = { tab, zoom: tab.zoom, zoomMode: tab.zoomMode };
      document.body.classList.add('reading-mode');
      viewer.setZoom(tab, 'fit-width');
      document.addEventListener('mousemove', onMove);
      showStrip();
    } else {
      document.body.classList.remove('reading-mode');
      document.removeEventListener('mousemove', onMove);
      clearTimeout(hideTimer);
      strip.classList.remove('on');
      strip.hidden = true;
      const s = saved; saved = null;
      if (s && state.tabs.includes(s.tab) && s.tab.view) viewer.setZoom(s.tab, s.zoomMode === 'custom' ? s.zoom : s.zoomMode);
    }
  }

  async function setFullScreen(on) {
    fullScreen = on;
    await api.setFullScreen(on);
  }
  // The browser build can also leave full screen on its own (Esc handled by the browser).
  document.addEventListener('fullscreenchange', () => { if (!api.isElectron) fullScreen = !!document.fullscreenElement; });

  bus.on('page:changed', () => { if (inReading()) refreshLabel(); });

  registerMenuItem('View', { separator: true });
  registerMenuItem('View', { id: 'readmode', label: 'Reading mode', shortcut: 'Ctrl+H', action: () => setReading(!inReading()), enabled: () => !!activeTab()?.view || inReading() });
  registerMenuItem('View', { id: 'fullscreen', label: 'Full screen', shortcut: 'F11', action: () => setFullScreen(!fullScreen) });

  /** Keyboard hook; returns true when the event was handled. */
  function onKey(e, typing) {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'h') { setReading(!inReading()); return true; }
    if (e.key === 'F11') { setFullScreen(!fullScreen); return true; }
    if (e.key === 'Escape' && !typing) {
      // Esc first clears an annotation selection or tool (annotations.js marks the event handled);
      // only an unclaimed Esc leaves reading mode / full screen. Decided after dispatch, so listener order does not matter.
      if (inReading() || fullScreen) setTimeout(() => {
        if (e.defaultPrevented) return;
        if (inReading()) setReading(false); else if (fullScreen) setFullScreen(false);
      }, 0);
      return false;
    }
    if (!inReading() || ctrl || e.altKey || typing) return false;
    const tab = activeTab();
    if (!tab?.view) return false;
    const sc = tab.view.scrollEl;
    switch (e.key) {
      case 'ArrowDown': sc.scrollTop += LINE; return true;
      case 'ArrowUp': sc.scrollTop -= LINE; return true;
      case 'ArrowRight': case ' ':
        if (e.key === ' ' && e.shiftKey) viewer.prevPage(tab); else viewer.nextPage(tab);
        return true;
      case 'ArrowLeft': viewer.prevPage(tab); return true;
      default: return false; // PageUp / PageDown / Home / End: the global handler
    }
  }
  return { onKey, setReading, inReading };
}
