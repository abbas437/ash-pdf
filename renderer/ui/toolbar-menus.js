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
    items: () => [
      { id: 'split-v', label: 'Split vertically', enabled: () => state.tabs.length > 0, action: () => splitView.split('v') },
      { id: 'split-h', label: 'Split horizontally', enabled: () => state.tabs.length > 0, action: () => splitView.split('h') },
      { id: 'unsplit', label: 'Unsplit', enabled: () => !!splitView.state, action: () => splitView.unsplit() },
    ],
  });
  split.button.setAttribute('aria-pressed', 'false');
  bus.on('split:changed', ({ split: on }) => split.button.setAttribute('aria-pressed', String(on)));
  addToolbarItem('split', split.wrap);
}
