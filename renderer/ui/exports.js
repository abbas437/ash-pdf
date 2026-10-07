// File menu exports that run in the renderer (no Microsoft Office needed, unlike office.js):
//   Export to Excel workbook (.xlsx)…  pdf.js text of a page range, grouped into rows and columns by
//       table-extract.js, one worksheet "Page N" per page, plain numbers stored as numbers; written by
//       the vendored write-excel-file and saved with api.saveFile.
//   Export page as image (PNG/JPEG)…   one page at 72/150/300 dpi; with "Include annotations", unsaved
//       overlay objects are burnt in with the print path's flattenedCopy (viewextras.js). Saved with
//       api.saveFile.
import { activeTab } from '../state.js';
import { h } from './dom.js';
import { showDialog, showError, toast } from './dialogs.js';
import { viewer } from './viewer.js';
import { flattenedCopy } from './viewextras.js';
import { textItems, extractTable } from './table-extract.js';

const ops = () => import('../../src/core/pdfOps.js');
const baseName = (tab) => tab.name.replace(/\.pdf$/i, '');
const opt = (value, label, selected) => h('option', { value, selected: selected || null }, label);
const field = (label, ...ctl) => h('label.vx-field', {}, h('span', {}, label), ...ctl);
const savedName = (res) => res.path.split(/[\\/]/).pop();

/** Rows of cell values (table-extract.js) -> write-excel-file sheet data. */
function sheetData(rows) {
  if (!rows.length) return [[null]];
  return rows.map((r) => r.map((v) => (v === null ? null : { type: typeof v === 'number' ? Number : String, value: v })));
}

/** Pages (0-based) -> xlsx bytes, one worksheet "Page N" per page. */
export async function xlsxBytes(tab, indices) {
  const sheets = [];
  for (const i of indices) sheets.push({ data: sheetData(extractTable(textItems(await viewer.getTextContent(tab, i)))), sheet: `Page ${i + 1}` });
  const { default: writeExcelFile } = await import('write-excel-file');
  const blob = await writeExcelFile(sheets).toBlob();
  return new Uint8Array(await blob.arrayBuffer());
}

/** File > Export to Excel workbook: asks for the pages, then saves. Resolves the saved path or null. */
export async function excelDialog(tab = activeTab()) {
  if (!tab?.pdfDoc) return null;
  const pages = h('input.input#xp-xlsx-pages', { type: 'text', placeholder: `All pages (1-${tab.numPages})`, 'aria-label': 'Pages' });
  const error = h('p.vx-error', { role: 'alert' });
  let indices = null;
  const validate = async () => {
    try {
      indices = pages.value.trim() ? (await ops()).parseRanges(pages.value, tab.numPages) : [...Array(tab.numPages).keys()];
      return true;
    } catch (err) { error.textContent = `Pages: ${err.message}`; return false; }
  };
  const body = h('div', {}, h('div.vx-print-form', {}, field('Pages', pages), error),
    h('p.vx-note', {}, 'Works best for table-like pages. Each page becomes a worksheet; text is placed in rows and columns by its position.'));
  const res = await showDialog({
    title: 'Export to Excel', body, className: 'xp-dialog xp-xlsx-dialog', initialFocus: '#xp-xlsx-pages',
    buttons: [{ label: 'Cancel', value: 'cancel', cancel: true }, { label: 'Export…', value: 'export', primary: true, validate }],
  });
  if (res !== 'export' || !indices) return null;
  try {
    const bytes = await xlsxBytes(tab, indices);
    const saved = await window.api.saveFile({ bytes, defaultPath: `${baseName(tab)}.xlsx`, filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }] });
    if (saved) toast(`Saved ${savedName(saved)}`);
    return saved?.path ?? null;
  } catch (err) { showError('Could not export to Excel', err); return null; }
}

/** One page (0-based) -> image bytes. format 'png' | 'jpeg', dpi, quality 0..1 (JPEG). */
export async function pageImageBytes(tab, pageIndex, { format = 'png', dpi = 150, quality = 0.9, annotations = true } = {}) {
  let doc = tab.pdfDoc, tmp = null;
  try {
    if (annotations && tab.objects?.some((o) => o.page === pageIndex)) ({ doc, tmp } = await flattenedCopy(tab));
    const page = doc === tab.pdfDoc ? tab.pages[pageIndex] : await doc.getPage(pageIndex + 1);
    const vp = page.getViewport({ scale: dpi / 72 });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff'; // JPEG has no alpha; PNG gets the same paper white
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({
      canvas: c, viewport: vp, background: '#ffffff',
      annotationMode: annotations ? viewer.pdfjs.AnnotationMode.ENABLE : viewer.pdfjs.AnnotationMode.DISABLE,
    }).promise;
    const blob = await new Promise((r) => c.toBlob(r, format === 'jpeg' ? 'image/jpeg' : 'image/png', quality));
    c.width = 0; c.height = 0;
    if (!blob) throw new Error('The page is too large to render at this resolution');
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    tmp?.destroy();
  }
}

/** File > Export page as image: asks for page, format and resolution, then saves. Resolves the saved path or null. */
export async function imageDialog(tab = activeTab()) {
  if (!tab?.pdfDoc) return null;
  const pageNo = h('input.input#xp-img-page', { type: 'number', min: '1', max: String(tab.numPages), value: String(tab.currentPage + 1) });
  const format = h('select.input#xp-img-format', {}, opt('png', 'PNG', true), opt('jpeg', 'JPEG'));
  const dpi = h('select.input#xp-img-dpi', {}, opt('72', '72 dpi'), opt('150', '150 dpi', true), opt('300', '300 dpi'));
  const quality = h('input.input#xp-img-quality', { type: 'number', min: '10', max: '100', value: '90', disabled: true });
  const annots = h('select.input#xp-img-annots', {}, opt('yes', 'Yes', true), opt('no', 'No'));
  format.addEventListener('change', () => { quality.disabled = format.value !== 'jpeg'; });
  const error = h('p.vx-error', { role: 'alert' });
  let chosen = null;
  const validate = () => {
    const n = Number(pageNo.value), q = Number(quality.value);
    if (!Number.isInteger(n) || n < 1 || n > tab.numPages) { error.textContent = `Page must be a whole number from 1 to ${tab.numPages}`; return false; }
    if (!Number.isInteger(q) || q < 10 || q > 100) { error.textContent = 'JPEG quality must be a whole number from 10 to 100'; return false; }
    chosen = { pageIndex: n - 1, format: format.value, dpi: Number(dpi.value), quality: q / 100, annotations: annots.value === 'yes' };
    return true;
  };
  const body = h('div.vx-print-form', {}, field('Page', pageNo), field('Format', format), field('Resolution', dpi),
    field('JPEG quality (%)', quality), field('Include annotations', annots), error);
  const res = await showDialog({
    title: 'Export page as image', body, className: 'xp-dialog xp-img-dialog', initialFocus: '#xp-img-page',
    buttons: [{ label: 'Cancel', value: 'cancel', cancel: true }, { label: 'Export…', value: 'export', primary: true, validate }],
  });
  if (res !== 'export' || !chosen) return null;
  try {
    const bytes = await pageImageBytes(tab, chosen.pageIndex, chosen);
    const ext = chosen.format === 'jpeg' ? 'jpg' : 'png';
    const saved = await window.api.saveFile({ bytes, defaultPath: `${baseName(tab)}-page-${chosen.pageIndex + 1}.${ext}`,
      filters: [chosen.format === 'jpeg' ? { name: 'JPEG image', extensions: ['jpg', 'jpeg'] } : { name: 'PNG image', extensions: ['png'] }] });
    if (saved) toast(`Saved ${savedName(saved)}`);
    return saved?.path ?? null;
  } catch (err) { showError('Could not export the image', err); return null; }
}

export function initExports(app) {
  const enabled = () => !!activeTab()?.pdfDoc;
  app.registerMenuItem('File', { id: 'export-xlsx', label: 'Export to Excel…', action: () => excelDialog(), enabled });
  app.registerMenuItem('File', { id: 'export-image', label: 'Export to image…', action: () => imageDialog(), enabled });
}
