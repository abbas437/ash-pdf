// Last session and recent files (Electron only). Main owns both lists: this module reports the open
// tabs that have a granted path (and the split view, by path), offers the saved session on the start
// screen and lists recent files.
import { h } from './dom.js';
import { showDialog, showError, toast } from './dialogs.js';
import { splitView } from './splitview.js';

const fileLabel = (path) => {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return { name: path.slice(i + 1), folder: path.slice(0, Math.max(i, 0)) };
};

export function initSession({ state, bus, viewer, activate, welcomeCard, openFile }) {
  const api = window.api;
  const electron = !!api.isElectron;

  // Opens described files ({name, path, bytes, page?, active?, split?}) as tabs: the page, the active
  // tab and the split view ({dir, ratio, files: [pathA, pathB], focus}) come from a restored session.
  // The split reopens only if both its files opened.
  async function openFiles(files) {
    let toActivate = null;
    let split = null;
    const opened = new Map(); // path -> tab
    for (const f of files ?? []) {
      const tab = await openFile(f);
      if (!tab) continue;
      if (f.path) opened.set(f.path, tab);
      if (f.split) split = f.split;
      if (Number.isInteger(f.page) && f.page > 1) viewer.scrollToPage(tab, Math.min(f.page, tab.numPages) - 1);
      if (f.active) toActivate = tab;
    }
    if (toActivate) activate(toActivate.id);
    const ids = split?.files.map((p) => opened.get(p)?.id);
    if (ids?.every(Boolean)) splitView.open(ids, split.dir, { ratio: split.ratio, focus: split.focus });
  }

  let timer = 0;
  function send() {
    clearTimeout(timer);
    const files = state.tabs.filter((t) => t.path).map((t) => ({ path: t.path, page: (t.currentPage ?? 0) + 1 }));
    const active = state.tabs.find((t) => t.id === state.activeId)?.path ?? null;
    const sv = splitView.state;
    const splitFiles = sv?.ids.map((id) => state.tabs.find((t) => t.id === id)?.path);
    const split = splitFiles?.every(Boolean) ? { dir: sv.dir, ratio: sv.ratio, files: splitFiles, focus: sv.focus } : null;
    api.sessionUpdate(split ? { files, active, split } : { files, active }).catch(() => {});
  }
  if (electron) {
    for (const ev of ['tab:opened', 'tab:closed', 'tab:activated', 'tab:reordered', 'tab:dirtyChanged', 'split:changed']) bus.on(ev, send);
    bus.on('page:changed', () => { clearTimeout(timer); timer = setTimeout(send, 400); });
  }

  const missingList = (paths) => h('div.session-missing', {},
    h('p', {}, 'These files are no longer available:'),
    h('ul.file-list', {}, paths.map((p) => {
      const { name, folder } = fileLabel(p);
      return h('li', {}, h('span.file-name', {}, name), h('span.file-folder', {}, folder));
    })),
    h('p.file-note', {}, 'They may have been deleted or moved, or they were temporary copies of e-mail attachments.'));

  async function restore() {
    let r;
    try { r = await api.sessionRestore(); } catch (err) { showError('Could not reopen the last session', err); return; }
    if (!r) return;
    await openFiles(r.files);
    if (r.missing?.length) await showDialog({ title: 'Some files are not available', body: missingList(r.missing), className: 'session-missing-dialog' });
  }

  // First window only: offer (or, with startup.mode 'restore', reopen) the previous session.
  async function start() {
    if (!electron) return;
    let info;
    try { info = await api.sessionInfo(); } catch { return; }
    const offer = info?.offer;
    if (!offer) return;
    if (offer.auto) { await restore(); return; }
    const always = h('input', { type: 'checkbox' });
    const choose = async (mode) => {
      panel.remove();
      if (always.checked) await api.settingsSet('startup.mode', mode).catch(() => {});
      if (mode === 'restore') await restore();
      else await api.sessionDismiss().catch(() => {});
    };
    const n = offer.count;
    const panel = h('div.session-offer', { role: 'group', 'aria-label': 'Last session' },
      h('div.session-offer-buttons', {},
        h('button.btn.primary', { type: 'button', dataset: { session: 'reopen' }, onclick: () => choose('restore') }, `Reopen last session (${n} file${n === 1 ? '' : 's'})`),
        h('button.btn', { type: 'button', dataset: { session: 'new' }, onclick: () => choose('new') }, 'Start new')),
      h('label.session-always', {}, always, ' Always do this'));
    welcomeCard.append(panel);
  }

  async function showRecent() {
    const list = await api.recentList();
    let chosen = null;
    const body = (dialog) => {
      if (!list.length) return h('p.file-note', {}, 'No recent files.');
      return h('ul.file-list.recent-files', {}, list.map((e) => h('li', {},
        h('button.recent-item', {
          type: 'button', disabled: !e.exists, title: e.path,
          onclick: () => { chosen = e.path; dialog.querySelector('.dialog-buttons [data-value="close"]').click(); },
        },
        h('span.file-name', {}, e.name), h('span.file-folder', {}, e.folder),
        !e.exists && h('span.file-missing', {}, 'Not found')))));
    };
    const r = await showDialog({
      title: 'Recent files', body, className: 'recent-dialog',
      buttons: [{ label: 'Clear list', value: 'clear' }, { label: 'Close', value: 'close', primary: true, cancel: true }],
    });
    if (r === 'clear') { await api.recentClear(); toast('Recent files list cleared'); return; }
    if (!chosen) return;
    const file = await api.recentOpen(chosen);
    if (file) await openFile(file);
    else await showDialog({ title: 'File not available', body: missingList([chosen]) });
  }

  return { openFiles, start, showRecent };
}
