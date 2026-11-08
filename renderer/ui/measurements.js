// "Measurements" sidebar tab: every distance / perimeter / area measurement of the active document,
// grouped by page, with totals per kind and unit and a CSV export. Clicking a row goes to its page
// and selects the object. Pure helpers live in measurements-lib.js.
//   initMeasurements() registers the tab ('measurements').
import { bus } from '../bus.js';
import { activeTab } from '../state.js';
import { h } from './dom.js';
import { addIcon } from './icons.js';
import { viewer } from './viewer.js';
import { showError } from './dialogs.js';
import { registerSidebarTab, refreshSidebarTab, showSidebarTab } from './sidebar.js';
import { annotations } from './annotations.js';
import { KIND_LABELS, measurementRows, measurementTotals, measurementsCsv } from './measurements-lib.js';

const TAB = 'measurements';
const EMPTY = 'No measurements yet. Use Measure in the toolbar.';

export function initMeasurements() {
  addIcon('ruler', '<path d="M3 12h18M3 8.25v7.5M21 8.25v7.5M6 12l2.25-1.8M6 12l2.25 1.8M18 12l-2.25-1.8M18 12l-2.25 1.8"/>');
  registerSidebarTab({ id: TAB, label: 'Measurements', icon: 'ruler', render });
  const refresh = ({ tab }) => { if (tab === activeTab()) refreshSidebarTab(TAB); };
  bus.on('annotations:changed', refresh);
  bus.on('annotations:selection', refresh);
}

function render(container, tab) {
  if (!tab?.pdfDoc) { container.replaceChildren(h('p.sb-empty', {}, tab ? 'Loading…' : 'No document open')); return; }
  const rows = measurementRows(tab.objects ?? []);
  const scroll = container.querySelector('.cm-list')?.scrollTop ?? 0;
  const bar = h('div.cm-toolbar', {},
    h('button.btn.cm-export.ms-export', { type: 'button', disabled: !rows.length, onclick: () => exportCsv(tab, rows) }, 'Export CSV…'));
  const sel = new Set(annotations.getSelection(tab));
  const list = h('div.cm-list', { role: 'list', 'aria-label': 'Measurements' });
  if (!rows.length) list.append(h('p.sb-empty', {}, EMPTY));
  let page = 0;
  for (const r of rows) {
    if (r.page !== page) {
      page = r.page;
      list.append(h('h3.cm-page', {}, `Page ${page}`, h('span.cm-count', {}, String(rows.filter((x) => x.page === page).length))));
    }
    list.append(item(tab, r, sel.has(r.id)));
  }
  const totals = rows.length ? h('div.ms-totals', { 'aria-label': 'Totals' },
    measurementTotals(rows).map((t) => h('div.ms-total', { dataset: { kind: t.kind } }, h('span', {}, `${KIND_LABELS[t.kind]} total`), h('span.ms-total-value', {}, t.text)))) : null;
  container.replaceChildren(...[bar, list, totals].filter(Boolean));
  list.scrollTop = scroll;
}

function item(tab, r, selected) {
  const go = () => focusObject(tab, r.id);
  const el = h(`div.cm-item.ms-item${selected ? '.selected' : ''}`, { role: 'listitem', tabindex: '0', dataset: { id: r.id }, 'aria-current': selected ? 'true' : null,
    onclick: go, onkeydown: (ev) => { if (ev.key === 'Enter' && ev.target === el) { ev.preventDefault(); go(); } } },
    h('div.cm-head', {}, h('span.ms-kind', {}, KIND_LABELS[r.kind]), h('span.ms-value', {}, r.text)),
    r.scaleLabel ? h('div.cm-type.ms-scale', {}, `Scale ${r.scaleLabel}`) : null,
    r.label ? h('div.cm-text.ms-label', {}, r.label) : null);
  return el;
}

function focusObject(tab, id) {
  const o = annotations.getObject(tab, id);
  if (!o) return;
  viewer.scrollToPage(tab, o.page);
  annotations.select(tab, [id]);
}

async function exportCsv(tab, rows) {
  try {
    const base = (tab.name || 'document').replace(/\.pdf$/i, '');
    await window.api.saveFile({ defaultPath: `${base}-measurements.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }], bytes: new TextEncoder().encode(measurementsCsv(rows)) });
  } catch (err) { showError('Export measurements', err); }
}

export const measurements = { show: () => showSidebarTab(TAB) };
