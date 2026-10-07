// Office conversions (File menu), through window.api.office* (electron/office.js):
//   Export to Word (.docx)…        the current document, annotations included, converted by Microsoft Word.
//   Create PDF from Office file…   Word / Excel / PowerPoint file -> PDF (saved where the user chooses), opened in a new tab.
// Both need Microsoft Office on Windows: elsewhere (and in the browser shim) the items are disabled with that reason.
import { state, activeTab } from '../state.js';
import { showError, toast } from './dialogs.js';
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

export async function exportDocx(tab = activeTab()) {
  if (!tab) return null;
  try {
    const bytes = await currentBytes(tab);
    toast('Converting with Microsoft Word…');
    const res = await window.api.officeExportDocx({ bytes, defaultPath: tab.name.replace(/\.pdf$/i, '') + '.docx' });
    if (res) toast(`Saved ${res.path.split(/[\\/]/).pop()}`);
    return res;
  } catch (err) { showError('Could not export to Word', err); return null; }
}

export async function officeToPdf(app) {
  try {
    const file = await window.api.officeToPdf();
    return file ? await app.openBytes(file) : null;
  } catch (err) { showError('Could not create the PDF', err); return null; }
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
