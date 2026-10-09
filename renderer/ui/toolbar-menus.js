// Toolbar dropdowns for document-level commands: Pages (page operations from ui/pagetools.js and
// Reduce file size from ui/compress.js) and Split (ui/splitview.js). The same commands stay in the
// menus; these put them on the toolbar. Split is pressed while the view is split.
import { bus } from '../bus.js';
import { state, activeTab } from '../state.js';
import { addToolbarItem, dropdownButton } from './toolbar.js';
import { selectionOf } from './pagetools.js';
import { reduceDialog } from './compress.js';
import { splitView } from './splitview.js';

export function initToolbarMenus(app) {
  const P = app.pageTools;
  const editable = () => { const t = activeTab(); return !!t?.pdfDoc && !t.readOnly; };
  const on = (fn) => () => { const t = activeTab(); if (t) fn(t); };
  const pages = dropdownButton({
    id: 'btn-pages', icon: 'pages', label: 'Pages', title: 'Pages: rotate, delete, insert, split, merge, crop, resize',
    items: () => [
      { id: 'rotate-left', label: 'Rotate left', enabled: editable, action: on((t) => P.rotate(t, selectionOf(t), -90)) },
      { id: 'rotate-right', label: 'Rotate right', enabled: editable, action: on((t) => P.rotate(t, selectionOf(t), 90)) },
      { separator: true },
      { id: 'delete-pages', label: 'Delete pages…', enabled: editable, action: on((t) => P.deletePages(t, selectionOf(t))) },
      { id: 'insert-blank', label: 'Insert blank page', enabled: editable, action: on((t) => { const s = selectionOf(t); P.insertBlank(t, s[s.length - 1] + 1); }) },
      { id: 'insert-file', label: 'Insert from file…', enabled: editable, action: on(P.insertFromDialog) },
      { separator: true },
      { id: 'extract-split', label: 'Extract / Split…', enabled: editable, action: on(P.splitDialog) },
      { id: 'merge', label: 'Merge files…', enabled: editable, action: on(P.mergeDialog) },
      { separator: true },
      { id: 'crop', label: 'Crop…', enabled: editable, action: on(P.cropDialog) },
      { id: 'resize', label: 'Resize…', enabled: editable, action: on(P.resizeDialog) },
      { id: 'reduce', label: 'Reduce file size…', enabled: () => !!activeTab()?.pdfDoc, action: on(reduceDialog) },
    ],
  });
  addToolbarItem('pages', pages.wrap);

  const split = dropdownButton({
    id: 'btn-split', icon: 'split', label: 'Split', title: 'Split view',
    items: () => {
      const s = splitView.state;
      const any = () => state.tabs.length > 0;
      const others = state.tabs.filter((t) => t.id !== state.activeId);
      return [
        // Plain Split: one document splits itself; several pair the current and the previously active one.
        !s && { id: 'split-v', label: 'Split', enabled: any, action: () => splitView.split('v') },
        { id: 'split-same', label: 'Split this document', enabled: () => !!activeTab(), action: () => splitView.open([state.activeId, state.activeId]) },
        // "Side by side with": the other open documents, listed under a heading.
        { id: 'split-with', label: 'Side by side with \u25B8', enabled: () => false },
        ...others.map((t) => ({ id: `split-with-${t.id}`, label: `\u2003${t.name}`, action: () => splitView.open([state.activeId, t.id]) })),
        { id: 'split-choose', label: 'Choose documents\u2026', enabled: any, action: () => splitView.chooseDialog() },
        { separator: true },
        s ? { id: 'split-orient', label: s.dir === 'v' ? 'Switch to horizontal (top / bottom)' : 'Switch to vertical (side by side)', action: () => splitView.split(s.dir === 'v' ? 'h' : 'v') }
          : { id: 'split-h', label: 'Split horizontally', enabled: any, action: () => splitView.split('h') },
        { id: 'unsplit', label: 'Close split', enabled: () => !!splitView.state, action: () => splitView.unsplit() },
      ].filter(Boolean);
    },
  });
  split.button.setAttribute('aria-pressed', 'false');
  bus.on('split:changed', ({ split: on }) => split.button.setAttribute('aria-pressed', String(on)));
  addToolbarItem('split', split.wrap);
}
