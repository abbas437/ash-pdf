// Office conversions (File menu):
//   Export to Word (.docx)…        asks for the engine: "ASH (built-in)" (default, docx-export.js in this renderer, no
//                                  Office needed) or "Microsoft Word (better layout, needs Word)", offered only when
//                                  Office is available: the current document, annotations included, converted by Word
//                                  through window.api.officeExportDocx (electron/office.js).
//   Create PDF from Office file…   Word / Excel / PowerPoint file -> PDF (saved where the user chooses), opened in a new tab.
//                                  Needs Microsoft Office on Windows: elsewhere (and in the browser shim) the item is
//                                  disabled with that reason.
import { state, activeTab } from '../state.js';
import { showDialog, showError, toast } from './dialogs.js';
import { h } from './dom.js';
import { idle as pageOpsIdle } from './pagetools.js';
import { viewer } from './viewer.js';
import { flattenedCopy } from './viewextras.js';
import { encodeImage } from './exports.js';
import { pdfToDocx } from './docx-export.js';

const UNAVAILABLE = 'Requires Microsoft Office on Windows';
let status = { available: false, reason: UNAVAILABLE };

/** The tab's bytes as Save would write them (annotation and form hooks applied), without changing the tab. */
export async function currentBytes(tab) {
  await pageOpsIdle();
  let bytes = tab.bytes;
  for (const hook of state.hooks.beforeSave) {
    const out = await hook(tab, bytes);
    if (out instanceof Uint8Array) bytes = out;
  }
  return bytes;
}

/** The message alone, without Electron's "Error invoking remote method 'office:…': Error: " prefix. */
export function officeMessage(err) {
  const msg = err?.message ?? String(err ?? 'Unknown error');
  return msg.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '');
}

let jobSeq = 0;
/**
 * Run call(jobId). When main reports that Office is converting (office:progress), show a dialog
 * whose Cancel ends the conversion (office:cancel). -> the call's result, or null when cancelled.
 */
async function withProgress(call) {
  const api = window.api;
  const jobId = `office-${Date.now()}-${++jobSeq}`;
  let done = false, cancelled = false, dialogEl = null;
  const off = api.onOfficeProgress?.((p) => {
    if (p?.jobId !== jobId || done || dialogEl) return;
    showDialog({
      title: 'Converting',
      body: (el) => {
        dialogEl = el;
        return h('div', {}, h('p', {}, `Converting with ${p.app ?? 'Microsoft Office'}… This can take a few minutes for long documents.`));
      },
      buttons: [{ label: 'Cancel', value: 'cancel', cancel: true }],
      className: 'office-progress',
    }).then(() => {
      if (done) return;
      cancelled = true;
      api.officeCancel?.(jobId);
    });
  });
  try {
    return await call(jobId);
  } catch (err) {
    if (cancelled) { toast(officeMessage(err)); return null; } // "Conversion cancelled", maybe "... PowerPoint may still be running."
    throw err;
  } finally {
    done = true;
    off?.();
    dialogEl?.querySelector('.dialog-buttons button')?.click(); // closes the progress dialog
  }
}

export const ENGINES = { ash: 'ASH (built-in)', word: 'Microsoft Word (better layout, needs Word)' };

/** Asks for the conversion engine -> 'ash' | 'word' | null (cancelled). Word is offered only when Office is available. */
async function chooseEngine(title, verb) {
  const select = h('select.input#office-engine', { 'aria-label': 'Engine' },
    h('option', { value: 'ash', selected: true }, ENGINES.ash),
    ...(status.available ? [h('option', { value: 'word' }, ENGINES.word)] : []));
  const body = h('div', {}, h('div.vx-print-form', {}, h('label.vx-field', {}, h('span', {}, 'Engine'), select)),
    h('p.vx-note', {}, 'The built-in engine rebuilds paragraphs, tables and images from the PDF without Microsoft Office.'));
  const res = await showDialog({ title, body, className: 'xp-dialog office-engine-dialog', initialFocus: '#office-engine',
    buttons: [{ label: 'Cancel', value: 'cancel', cancel: true }, { label: verb, value: 'ok', primary: true }] });
  return res === 'ok' ? select.value : null;
}

// pdf.js image -> {data, type} for docx-export.js (PNG when it has transparency, else JPEG).
async function docxImage(img) {
  const enc = await encodeImage(img);
  return enc ? { data: new Uint8Array(await enc.content.arrayBuffer()), type: enc.contentType === 'image/png' ? 'png' : 'jpg' } : null;
}

/** The tab (annotations burnt in, as the Word engine sees them) -> .docx bytes, built here. */
export async function nativeDocxBytes(tab) {
  await pageOpsIdle();
  const flat = tab.objects?.length ? await flattenedCopy(tab) : null;
  try {
    return await pdfToDocx(flat?.doc ?? tab.pdfDoc, { OPS: viewer.pdfjs.OPS, encode: docxImage,
      textContent: flat ? undefined : (i) => viewer.getTextContent(tab, i) });
  } finally { flat?.tmp?.destroy(); }
}

/** File > Export to Word: engine choice, then the built-in conversion or Word's. */
export async function exportDocxDialog(tab = activeTab()) {
  if (!tab?.pdfDoc) return null;
  const engine = await chooseEngine('Export to Word', 'Export…');
  if (engine === 'word') return exportDocx(tab);
  if (engine !== 'ash') return null;
  try {
    const bytes = await nativeDocxBytes(tab);
    const saved = await window.api.saveFile({ bytes, defaultPath: tab.name.replace(/\.pdf$/i, '') + '.docx', filters: [{ name: 'Word document', extensions: ['docx'] }] });
    if (saved) toast(`Saved ${saved.path.split(/[\\/]/).pop()}`);
    return saved ?? null;
  } catch (err) { showError('Could not export to Word', err); return null; }
}

export async function exportDocx(tab = activeTab()) {
  if (!tab) return null;
  try {
    const bytes = await currentBytes(tab);
    const res = await withProgress((jobId) => window.api.officeExportDocx({ bytes, defaultPath: tab.name.replace(/\.pdf$/i, '') + '.docx', jobId }));
    if (res) toast(`Saved ${res.path.split(/[\\/]/).pop()}`);
    return res;
  } catch (err) { showError('Could not export to Word', { message: officeMessage(err) }); return null; }
}

export async function officeToPdf(app) {
  try {
    const file = await withProgress((jobId) => window.api.officeToPdf({ jobId }));
    return file ? await app.openBytes(file) : null;
  } catch (err) { showError('Could not create the PDF', { message: officeMessage(err) }); return null; }
}

export function initOffice(app) {
  const api = window.api;
  if (api.officeStatus) api.officeStatus().then((s) => { status = s; }, () => {});
  const item = (def, needsDoc) => {
    const it = { ...def };
    it.enabled = () => {
      if (it.el) it.el.title = status.available ? '' : (status.reason ?? UNAVAILABLE);
      return status.available && (!needsDoc || !!activeTab());
    };
    app.registerMenuItem('File', it);
  };
  app.registerMenuItem('File', { separator: true });
  app.registerMenuItem('File', { id: 'export-docx', label: 'Export to Word…', action: () => exportDocxDialog(), enabled: () => !!activeTab()?.pdfDoc });
  item({ id: 'office-to-pdf', label: 'Create PDF from Office…', action: () => officeToPdf(app) }, false);
}
