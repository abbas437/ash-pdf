// File menu exports that run in the renderer (no Microsoft Office needed, unlike office.js):
//   Export to Excel workbook (.xlsx)…  pdf.js text of a page range, grouped into rows and columns by
//       table-extract.js (helped by the page's ruling lines from pdf.js getOperatorList), one worksheet
//       "Page N" per page, plain numbers stored as numbers; written by the vendored write-excel-file and saved with api.saveFile.
//       With "Include images" (default on), the page's images (pdf.js paintImageXObject / paintInlineImageXObject, pixels
//       from page.objs) float over the sheet near the text rows they sit between (table-extract.js placeImages);
//       PNG when an image has transparency, else JPEG.
//   Export to image (PNG/JPEG)…   pages ("All" or a range like 1-3,7; default the current page) at 72/150/300
//       dpi; with "Include annotations", unsaved overlay objects are burnt in with the print path's
//       flattenedCopy (viewextras.js). One page is saved with api.saveFile; several pages go one at a time into a
//       folder the user picks in main (api.imageExportBegin/Write/End, rules in src/core/imgexport.js).
import { activeTab } from '../state.js';
import { h } from './dom.js';
import { showDialog, showError, toast } from './dialogs.js';
import { viewer } from './viewer.js';
import { flattenedCopy } from './viewextras.js';
import { textItems, extractLayout, rulesFromOps, pageBox, imagesFromOps, placeImages, rgbaPixels, COL_PX } from './table-extract.js';
import { MAX_FILES } from '../../src/core/imgexport.js';

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

const MAX_BITMAP = 2048; // px: a larger image is scaled down to this on its longer side before encoding

// pdf.js image object (decoded in the worker) -> canvas.
function imageCanvas(img) {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d');
  if (img.bitmap) ctx.drawImage(img.bitmap, 0, 0);
  else ctx.putImageData(new ImageData(new Uint8ClampedArray(rgbaPixels(img)), img.width, img.height), 0, 0);
  return c;
}

// One image object -> {content: Blob, contentType}: PNG when any pixel is not opaque, else JPEG; capped at MAX_BITMAP.
async function encodeImage(img) {
  let c = imageCanvas(img);
  const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let alpha = false;
  for (let k = 3; k < px.length && !alpha; k += 4) alpha = px[k] < 255;
  const s = Math.min(1, MAX_BITMAP / Math.max(c.width, c.height));
  if (s < 1) {
    const d = document.createElement('canvas');
    d.width = Math.max(1, Math.round(c.width * s)); d.height = Math.max(1, Math.round(c.height * s));
    d.getContext('2d').drawImage(c, 0, 0, d.width, d.height);
    c.width = 0; c = d;
  }
  const contentType = alpha ? 'image/png' : 'image/jpeg';
  const content = await new Promise((r) => c.toBlob(r, contentType, 0.9));
  c.width = 0;
  return content ? { content, contentType } : null;
}

// An image XObject's pixels: page.objs (commonObjs for "g_" ids) once resolved; null after 5 s.
function imageObject(page, id) {
  const objs = id.startsWith('g_') ? page.commonObjs : page.objs;
  if (objs.has(id)) return Promise.resolve(objs.get(id));
  return Promise.race([new Promise((r) => objs.get(id, r)), new Promise((r) => setTimeout(() => r(null), 5000))]);
}

// One page's images -> write-excel-file images, placed against the sheet rows' positions (layout.at).
async function sheetImages(page, opList, layout, usedCols) {
  const box = pageBox(page.view, page.rotate);
  const found = imagesFromOps(opList, viewer.pdfjs.OPS, box);
  if (!found.length) return [];
  const rowTops = layout.at.map((p) => (p ? (box.m[1] * p.x + box.m[3] * p.y + box.m[5]) : null));
  const spots = placeImages(found.map((f) => f.box), rowTops, box.width, usedCols);
  const out = [];
  for (const [k, f] of found.entries()) {
    try {
      const img = f.data ?? await imageObject(page, f.id);
      if (!img?.width || !img?.height) continue;
      const enc = await encodeImage(img);
      if (!enc) continue;
      const { row, col, width, height } = spots[k];
      out.push({ ...enc, width, height, dpi: 96, anchor: { row: row + 1, column: Math.floor(col) + 1 },
        offsetX: Math.round((col - Math.floor(col)) * COL_PX), title: `Image ${out.length + 1}` });
    } catch { /* an image pdf.js cannot hand over is left out */ }
  }
  return out;
}
/** Pages (0-based) -> xlsx bytes, one worksheet "Page N" per page; `images` adds each page's images. */
export async function xlsxBytes(tab, indices, { images = true } = {}) {
  const sheets = [];
  for (const i of indices) {
    const page = tab.pages[i];
    let opList = null, rules = null; // ruling lines give a table's columns; text alone still works without them
    try { opList = await page.getOperatorList(); rules = rulesFromOps(opList, viewer.pdfjs.OPS); } catch { /* damaged page */ }
    const layout = extractLayout(textItems(await viewer.getTextContent(tab, i)), rules);
    const data = sheetData(layout.rows);
    const sheet = { data, sheet: `Page ${i + 1}` };
    if (images && opList) {
      const imgs = await sheetImages(page, opList, layout, data[0].length);
      if (imgs.length) sheet.images = imgs;
    }
    sheets.push(sheet);
  }
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
  const withImages = h('input#xp-xlsx-images', { type: 'checkbox', checked: true });
  const body = h('div', {}, h('div.vx-print-form', {}, field('Pages', pages), field('Include images', withImages), error),
    h('p.vx-note', {}, 'Works best for table-like pages. Each page becomes a worksheet; text is placed in rows and columns by its position.'));
  const res = await showDialog({
    title: 'Export to Excel', body, className: 'xp-dialog xp-xlsx-dialog', initialFocus: '#xp-xlsx-pages',
    buttons: [{ label: 'Cancel', value: 'cancel', cancel: true }, { label: 'Export…', value: 'export', primary: true, validate }],
  });
  if (res !== 'export' || !indices) return null;
  try {
    const bytes = await xlsxBytes(tab, indices, { images: withImages.checked });
    const saved = await window.api.saveFile({ bytes, defaultPath: `${baseName(tab)}.xlsx`, filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }] });
    if (saved) toast(`Saved ${savedName(saved)}`);
    return saved?.path ?? null;
  } catch (err) { showError('Could not export to Excel', err); return null; }
}

/** One page (0-based) -> image bytes. format 'png' | 'jpeg', dpi, quality 0..1 (JPEG). */
/** `flat`: an already flattened copy (several pages share one) instead of making one for this page. */
export async function pageImageBytes(tab, pageIndex, { format = 'png', dpi = 150, quality = 0.9, annotations = true } = {}, flat = null) {
  let doc = tab.pdfDoc, tmp = null;
  try {
    if (annotations && tab.objects?.some((o) => o.page === pageIndex)) {
      if (flat) doc = flat; else ({ doc, tmp } = await flattenedCopy(tab));
    }
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

/** File > Export to image: asks for pages, format and resolution, then saves one file or a folder of files.
 *  Resolves the saved path (one page), the folder (several pages) or null. */
export async function imageDialog(tab = activeTab()) {
  if (!tab?.pdfDoc) return null;
  const pageNo = h('input.input#xp-img-page', { type: 'text', value: String(tab.currentPage + 1), placeholder: `All, or e.g. 1-3,7 (1-${tab.numPages})`, 'aria-label': 'Pages' });
  const format = h('select.input#xp-img-format', {}, opt('png', 'PNG', true), opt('jpeg', 'JPEG'));
  const dpi = h('select.input#xp-img-dpi', {}, opt('72', '72 dpi'), opt('150', '150 dpi', true), opt('300', '300 dpi'));
  const quality = h('input.input#xp-img-quality', { type: 'number', min: '10', max: '100', value: '90', disabled: true });
  const annots = h('select.input#xp-img-annots', {}, opt('yes', 'Yes', true), opt('no', 'No'));
  format.addEventListener('change', () => { quality.disabled = format.value !== 'jpeg'; });
  const error = h('p.vx-error', { role: 'alert' });
  let chosen = null;
  const validate = async () => {
    const q = Number(quality.value), spec = pageNo.value.trim();
    let indices;
    try {
      indices = !spec || /^all$/i.test(spec) ? [...Array(tab.numPages).keys()] : (await ops()).parseRanges(spec, tab.numPages);
    } catch (err) { error.textContent = `Pages: ${err.message}`; return false; }
    if (indices.length > MAX_FILES) { error.textContent = `Pages: at most ${MAX_FILES} pages can be exported at once`; return false; }
    if (!Number.isInteger(q) || q < 10 || q > 100) { error.textContent = 'JPEG quality must be a whole number from 10 to 100'; return false; }
    chosen = { indices, format: format.value, dpi: Number(dpi.value), quality: q / 100, annotations: annots.value === 'yes' };
    return true;
  };
  const body = h('div.vx-print-form', {}, field('Pages', pageNo), field('Format', format), field('Resolution', dpi),
    field('JPEG quality (%)', quality), field('Include annotations', annots), error);
  const res = await showDialog({
    title: 'Export to image', body, className: 'xp-dialog xp-img-dialog', initialFocus: '#xp-img-page',
    buttons: [{ label: 'Cancel', value: 'cancel', cancel: true }, { label: 'Export…', value: 'export', primary: true, validate }],
  });
  if (res !== 'export' || !chosen) return null;
  if (chosen.indices.length > 1) return exportImagePages(tab, chosen);
  try {
    const pageIndex = chosen.indices[0];
    const bytes = await pageImageBytes(tab, pageIndex, chosen);
    const ext = chosen.format === 'jpeg' ? 'jpg' : 'png';
    const saved = await window.api.saveFile({ bytes, defaultPath: `${baseName(tab)}-page-${pageIndex + 1}.${ext}`,
      filters: [chosen.format === 'jpeg' ? { name: 'JPEG image', extensions: ['jpg', 'jpeg'] } : { name: 'PNG image', extensions: ['png'] }] });
    if (saved) toast(`Saved ${savedName(saved)}`);
    return saved?.path ?? null;
  } catch (err) { showError('Could not export the image', err); return null; }
}

/** Several pages -> one image file each in a folder chosen in main; rendered and written one at a time, with Cancel. */
async function exportImagePages(tab, chosen) {
  const api = window.api;
  let job;
  try {
    job = await api.imageExportBegin({ baseName: baseName(tab), pageCount: tab.numPages, pages: chosen.indices.map((i) => i + 1), format: chosen.format });
  } catch (err) { showError('Could not export the images', err); return null; }
  if (!job) return null;
  const n = chosen.indices.length;
  const status = h('p#xp-img-progress', {}, `Exporting page 1 of ${n}`);
  let done = false, cancelled = false, dialogEl = null;
  showDialog({
    title: 'Export to image', body: (el) => { dialogEl = el; return status; },
    buttons: [{ label: 'Cancel', value: 'cancel', cancel: true }], className: 'xp-dialog xp-img-progress',
  }).then(() => { if (!done) cancelled = true; });
  let flat = null, written = 0;
  try {
    if (chosen.annotations && tab.objects?.some((o) => chosen.indices.includes(o.page))) flat = await flattenedCopy(tab);
    for (const [k, pageIndex] of chosen.indices.entries()) {
      if (cancelled) break;
      status.textContent = `Exporting page ${k + 1} of ${n}`;
      const bytes = await pageImageBytes(tab, pageIndex, chosen, flat?.doc);
      if (cancelled) break;
      await api.imageExportWrite(job.jobId, k, bytes);
      written++;
    }
    toast(cancelled ? `Export cancelled after ${written} of ${n} images` : `Exported ${n} images to ${savedName({ path: job.folder })}`);
    return cancelled ? null : job.folder;
  } catch (err) { showError('Could not export the images', err); return null; } finally {
    done = true;
    flat?.tmp?.destroy();
    await api.imageExportEnd(job.jobId).catch(() => {});
    dialogEl?.querySelector('.dialog-buttons button')?.click(); // closes the progress dialog
  }
}

export function initExports(app) {
  const enabled = () => !!activeTab()?.pdfDoc;
  app.registerMenuItem('File', { id: 'export-xlsx', label: 'Export to Excel…', action: () => excelDialog(), enabled });
  app.registerMenuItem('File', { id: 'export-image', label: 'Export to image…', action: () => imageDialog(), enabled });
}
