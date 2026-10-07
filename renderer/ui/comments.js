// "Comments" sidebar tab: every annotation of the active document grouped by page, with its
// author, date, comment, replies and review status. Edits (comment, reply, status, delete) go
// through the annotations API, one undo step each; src/core/annots.js writes them to the file
// (/Contents, /IRT replies, review state). Pure helpers live in comments-lib.js.
//   initComments(app) registers the tab ('comments') and its menu-less toolbar (filters, Export…).
import { bus } from '../bus.js';
import { activeTab } from '../state.js';
import { h } from './dom.js';
import { icon, addIcon } from './icons.js';
import { viewer } from './viewer.js';
import { showDialog, showError } from './dialogs.js';
import { registerSidebarTab, refreshSidebarTab, showSidebarTab } from './sidebar.js';
import { annotations, getAuthor } from './annotations.js';
import { markupTools } from './tools-markup.js';
import { STATUSES, STATUS_LABELS, typeLabel, toEntries, filterEntries, groupByPage, distinct, toCsv } from './comments-lib.js';

const TAB = 'comments';
const TYPE_ICON = {
  rect: 'shapes', ellipse: 'shapes', line: 'shapes', arrow: 'shapes', ink: 'draw', highlight: 'highlight', textHighlight: 'highlight',
  text: 'text', underline: 'text', strikeout: 'text', squiggly: 'text', callout: 'callout', stamp: 'stamp', image: 'image', whiteout: 'whiteout', note: 'comment',
};
const filters = { type: '', author: '', status: '' };
let gen = 0;

export function initComments() {
  addIcon('comment', '<path d="M4.5 5h15v10.5h-8.5L6.5 19.5v-4h-2z"/>');
  registerSidebarTab({ id: TAB, label: 'Comments', icon: 'comment', render });
  const refresh = ({ tab }) => { if (tab === activeTab()) refreshSidebarTab(TAB); };
  bus.on('annotations:changed', refresh);
  bus.on('annotations:selection', refresh);
}

async function entriesOf(tab) { return toEntries(tab.objects ?? [], await getAuthor()); }

async function render(container, tab) {
  const my = ++gen;
  if (!tab?.pdfDoc) { container.replaceChildren(h('p.sb-empty', {}, tab ? 'Loading…' : 'No document open')); return; }
  const all = await entriesOf(tab);
  if (my !== gen) return;
  const scroll = container.querySelector('.cm-list')?.scrollTop ?? 0;
  const shown = filterEntries(all, filters);
  const select = (key, label, values, name = (v) => v) => h('select.cm-filter', { 'aria-label': `Filter by ${label}`, dataset: { filter: key }, onchange: (e) => { filters[key] = e.target.value; refreshSidebarTab(TAB); } },
    h('option', { value: '' }, label === 'status' ? 'All statuses' : `All ${label}s`), values.map((v) => h('option', { value: v, selected: v === filters[key] }, name(v))));
  const bar = h('div.cm-toolbar', {},
    select('type', 'type', distinct(all, 'type'), typeLabel),
    select('author', 'author', distinct(all, 'author')),
    select('status', 'status', STATUSES, (s) => STATUS_LABELS[s]),
    h('button.btn.cm-export', { type: 'button', disabled: !shown.length, onclick: () => exportCsv(tab, groupByPage(shown).flatMap((g) => g.items)) }, 'Export…'));
  const sel = new Set(annotations.getSelection(tab));
  const list = h('div.cm-list', { role: 'list', 'aria-label': 'Comments' });
  if (!all.length) list.append(h('p.sb-empty', {}, 'No comments or markups'));
  else if (!shown.length) list.append(h('p.sb-empty', {}, 'No comments match the filters'));
  for (const g of groupByPage(shown)) {
    list.append(h('h3.cm-page', {}, `Page ${g.page + 1}`, h('span.cm-count', {}, String(g.items.length))));
    for (const e of g.items) list.append(item(tab, e, sel.has(e.id)));
  }
  container.replaceChildren(bar, list);
  list.scrollTop = scroll;
}

function item(tab, e, selected) {
  const ro = !!tab.readOnly;
  const act = (label, fn, cls = '') => h(`button.cm-act${cls}`, { type: 'button', disabled: ro, dataset: { act: label.toLowerCase() }, onclick: (ev) => { ev.stopPropagation(); fn(); } }, label);
  const status = h('select.cm-status', { 'aria-label': 'Status', disabled: ro, onclick: (ev) => ev.stopPropagation(), onchange: async (ev) => {
    annotations.update(tab, e.id, { status: ev.target.value, statusAuthor: await getAuthor() });
  } }, STATUSES.map((s) => h('option', { value: s, selected: s === e.status }, STATUS_LABELS[s])));
  const el = h(`div.cm-item${selected ? '.selected' : ''}`, { role: 'listitem', tabindex: '0', dataset: { id: e.id }, 'aria-current': selected ? 'true' : null,
    onclick: () => focusObject(tab, e.id),
    onkeydown: (ev) => { if (ev.key === 'Enter' && ev.target === el) { ev.preventDefault(); focusObject(tab, e.id); } } },
    h('div.cm-head', {},
      h('span.cm-icon', { title: typeLabel(e.type), html: icon(TYPE_ICON[e.type] ?? 'info', 16) }),
      h('span.cm-author', { title: e.author || 'Unknown' }, e.author || 'Unknown'),
      e.status !== 'none' ? h(`span.cm-badge.cm-${e.status}`, {}, STATUS_LABELS[e.status]) : null),
    h('div.cm-type', {}, `${typeLabel(e.type)} · `, h('span.cm-date', {}, e.date ? new Date(e.date).toLocaleString() : 'Not saved')),
    e.text ? h('div.cm-text', {}, e.text) : h('div.cm-text.cm-none', {}, 'No comment'),
    e.replies.length ? h('ul.cm-replies', { 'aria-label': `${e.replies.length} repl${e.replies.length === 1 ? 'y' : 'ies'}` },
      e.replies.map((r) => h('li.cm-reply', {}, h('div.cm-author', {}, r.author || 'Unknown'), r.date ? h('div.cm-date', {}, new Date(r.date).toLocaleString()) : null, h('div.cm-text', {}, r.text)))) : null,
    h('div.cm-actions', {},
      e.replies.length ? h('span.cm-reply-count', {}, `${e.replies.length} repl${e.replies.length === 1 ? 'y' : 'ies'}`) : null,
      act('Edit', () => { focusObject(tab, e.id); markupTools.openComment(tab, e.id); }),
      act('Reply', () => reply(tab, e.id)),
      status,
      act('Delete', () => del(tab, e), '.danger')));
  return el;
}

function focusObject(tab, id) {
  const o = annotations.getObject(tab, id);
  if (!o) return;
  viewer.scrollToPage(tab, o.page);
  annotations.select(tab, [id]);
}

async function reply(tab, id) {
  const ta = h('textarea.input.cm-reply-text', { rows: 4, 'aria-label': 'Reply' });
  const ok = await showDialog({ title: 'Reply', body: ta, initialFocus: '.cm-reply-text', buttons: [{ label: 'Cancel', value: false, cancel: true }, { label: 'Reply', value: true, primary: true }] });
  const text = ta.value.trim();
  const o = annotations.getObject(tab, id);
  if (!ok || !text || !o) return;
  const r = { id: annotations.newId(), author: await getAuthor(), date: new Date().toISOString(), text };
  annotations.update(tab, id, { replies: [...(o.replies ?? []), r] });
}

async function del(tab, e) {
  const ok = await showDialog({ title: 'Delete annotation', body: `Delete this ${typeLabel(e.type).toLowerCase()} on page ${e.page + 1} with its comment and replies?`,
    buttons: [{ label: 'Cancel', value: false, cancel: true }, { label: 'Delete', value: true, danger: true }] });
  if (ok) annotations.remove(tab, [e.id]);
}

async function exportCsv(tab, entries) {
  try {
    const base = (tab.name || 'document').replace(/\.pdf$/i, '');
    await window.api.saveFile({ defaultPath: `${base}-comments.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }], bytes: new TextEncoder().encode(toCsv(entries)) });
  } catch (err) { showError('Export comments', err); }
}

export const comments = { show: () => showSidebarTab(TAB), filters };
