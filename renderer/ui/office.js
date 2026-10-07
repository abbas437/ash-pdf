// Office conversions (File menu), through window.api.office* (electron/office.js):
//   Export to Word (.docx)…        the current document, annotations included, converted by Microsoft Word.
//   Create PDF from Office file…   Word / Excel / PowerPoint file -> PDF (saved where the user chooses), opened in a new tab.
// Both need Microsoft Office on Windows: elsewhere (and in the browser shim) the items are disabled with that reason.
import { state, activeTab } from '../state.js';
import { showDialog, showError, toast } from './dialogs.js';
import { h } from './dom.js';
import { idle as pageOpsIdle } from './pagetools.js';

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
    if (cancelled) { toast('Conversion cancelled'); return null; }
    throw err;
  } finally {
    done = true;
    off?.();
    dialogEl?.querySelector('.dialog-buttons button')?.click(); // closes the progress dialog
  }
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
  item({ id: 'export-docx', label: 'Export to Word document (.docx)…', action: () => exportDocx() }, true);
  item({ id: 'office-to-pdf', label: 'Create PDF from Office file…', action: () => officeToPdf(app) }, false);
}
