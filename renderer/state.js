// The single observable application state.
//
// `state` is a Proxy: assigning a top-level key (state.tool = 'draw') emits
// bus 'state:changed' {key, value, previous}. Nested objects (tabs, toolStyle) are plain
// objects; modules that change them emit their own, more specific events.
import { bus } from './bus.js';

const raw = {
  tabs: [],              // Tab objects, in strip order (see createTab)
  activeId: null,        // id of the active tab or null
  tool: 'select',        // id of the active tool (registerTool in ui/toolbar.js)
  toolStyle: {           // shared style values edited in the tool options bar
    color: '#c0392b',
    strokeWidth: 2,
    dash: 'solid',       // 'solid' | 'dashed' | 'dotted'
    fontSize: 12,
    opacity: 1,
  },
  sidebarTab: 'thumbs',  // id of the visible sidebar tab
  sidebarOpen: true,
  theme: 'light',        // 'light' | 'dark'
  hooks: {
    // async (tab) => Uint8Array | undefined. Run in order by saveTab(); a returned
    // Uint8Array replaces tab.bytes for the bytes that are written.
    beforeSave: [],
  },
};

export const state = new Proxy(raw, {
  set(target, key, value) {
    const previous = target[key];
    target[key] = value;
    if (previous !== value) bus.emit('state:changed', { key, value, previous });
    return true;
  },
});

let seq = 0;

/** Create a tab record. The viewer fills pdfDoc/pages when it loads the bytes. */
export function createTab({ name, path = null, bytes, password = null }) {
  return {
    id: `tab-${++seq}`,
    name: name || 'document.pdf',
    path,                  // real path (Electron) / pseudo path (browser shim) or null
    bytes,                 // Uint8Array: the CURRENT PDF bytes (what Save writes)
    password,              // password used to open, when encrypted
    dirty: false,
    rev: 0,                // bumped by every markDirty(tab, true); saveTab clears dirty only if unchanged
    readOnly: false,       // true for encrypted PDFs
    encrypted: false,
    pdfDoc: null,          // pdf.js PDFDocumentProxy
    pages: [],             // pdf.js PDFPageProxy per page index
    numPages: 0,
    currentPage: 0,        // 0-based
    zoomMode: 'fit-width', // 'fit-width' | 'fit-page' | 'custom'
    zoom: 1,               // 1 = 100 % (1 pt = 96/72 CSS px)
    viewRotation: 0,       // 0/90/180/270, visual only
    scrollState: null,     // {pageIndex, fy, left} saved when the tab is hidden
    textCache: new Map(),  // pageIndex -> pdf.js TextContent
    data: {},              // free slot for later modules (annotations, form state, ...)
  };
}

export function activeTab() {
  return raw.tabs.find((t) => t.id === raw.activeId) ?? null;
}

export function getTab(id) {
  return raw.tabs.find((t) => t.id === id) ?? null;
}

/** Flag a tab as having unsaved changes (or clear it with dirty=false). */
export function markDirty(tab, dirty = true) {
  if (!tab) return;
  if (dirty) tab.rev = (tab.rev ?? 0) + 1;
  if (tab.dirty === dirty) return;
  tab.dirty = dirty;
  bus.emit('tab:dirtyChanged', { tab, dirty });
}
