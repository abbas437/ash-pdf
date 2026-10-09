// Tools > Recognize text (OCR)…: makes scanned pages searchable. The dialog picks the pages (current / all / a
// range) and whether to skip pages that already carry text (pdf.js getTextContent). Inside runOp each page is
// drawn by pdf.js at 300 dpi (less for very large sheets), recognised by the vendored tesseract.js (English, LSTM
// only, fully offline) and its words written as an invisible text layer by src/core/ocr.js addTextLayer. The
// visible page is unchanged; the change is one undoable page operation. The tesseract worker is started on first
// use and terminated after every run (it holds the wasm heap and the English model, about 100 MB).
import { bus } from '../bus.js';
import { activeTab } from '../state.js';
import { h } from './dom.js';
import { showDialog, showError, toast, progressDialog as showProgress, CANCELLED } from './dialogs.js';
import { viewer } from './viewer.js';
import { runOp } from './pagetools.js';
import { pref } from './prefs.js';
import { imageCoverage, looksScanned, SAMPLE_PAGES } from './scan-lib.js';
import { parseRanges } from '../../src/core/pdfOps.js';

const TESS = new URL('./vendor/tesseract/', document.baseURI).href;
const ENGINE_FILES = ['tesseract.esm.min.js', 'worker.min.js', 'tesseract-core-simd-lstm.js', 'tesseract-core-simd-lstm.wasm']
  .map((f) => TESS + f).concat(new URL('./vendor/tessdata/eng.traineddata.gz', document.baseURI).href);
const DPI = 300;
const MAX_PIXELS = 64e6, MAX_SIDE = 16384; // canvas and wasm-heap limits: big drawing sheets are read at a lower dpi
const range = (n) => [...Array(n).keys()];

/** Pixels per PDF point for a page box: 300 dpi, reduced so the canvas stays within MAX_PIXELS / MAX_SIDE. */
export function ocrScale(view, rotate = 0) {
  const w = Math.abs(view[2] - view[0]), h0 = Math.abs(view[3] - view[1]);
  const [pw, ph] = rotate % 180 ? [h0, w] : [w, h0];
  const s = DPI / 72;
  return Math.min(s, Math.sqrt(MAX_PIXELS / (pw * ph)), MAX_SIDE / pw, MAX_SIDE / ph);
}

class EngineMissing extends Error {}

/** A tesseract worker on the vendored files (no CDN, no blob: worker, no IndexedDB cache). */
async function startWorker() {
  const ok = await Promise.all(ENGINE_FILES.map((u) => fetch(u).then((r) => { r.body?.cancel().catch(() => {}); return r.ok; }, () => false)));
  if (!ok.every(Boolean)) throw new EngineMissing('The text recognition engine is not installed with this copy of ASH PDF Studio (renderer/vendor/tesseract and tessdata are missing). Reinstall the application, or run "node scripts/vendor.js" in a development checkout.');
  const { default: Tesseract } = await import(TESS + 'tesseract.esm.min.js');
  return Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, {
    workerPath: TESS + 'worker.min.js', corePath: TESS + 'tesseract-core-simd-lstm.js',
    langPath: new URL('./vendor/tessdata', document.baseURI).href, workerBlobURL: false, cacheMethod: 'none', gzip: true,
  });
}

function openPdf(tab, bytes) {
  const V = new URL('./vendor/pdfjs/', document.baseURI).href; // same resources as viewer.js
  return viewer.pdfjs.getDocument({ data: bytes.slice(), password: tab.password ?? undefined, cMapUrl: V + 'cmaps/', cMapPacked: true,
    standardFontDataUrl: V + 'standard_fonts/', wasmUrl: V + 'wasm/', iccUrl: V + 'iccs/', isEvalSupported: false, enableScripting: false });
}

const hasText = async (page) => (await page.getTextContent()).items.some((it) => it.str?.trim());

/** Page content at OCR resolution → {canvas, geom} for addTextLayer. */
async function renderPage(page) {
  const scale = ocrScale(page.view, page.rotate);
  const vp = page.getViewport({ scale });
  const c = document.createElement('canvas');
  c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvas: c, viewport: vp, background: '#ffffff', annotationMode: viewer.pdfjs.AnnotationMode.DISABLE }).promise;
  return { canvas: c, geom: { view: page.view, rotate: page.rotate, scale } };
}

function wordsOf(data) {
  const out = [];
  for (const b of data.blocks ?? []) for (const p of b.paragraphs ?? []) for (const l of p.lines ?? []) for (const w of l.words ?? []) {
    if (w.text?.trim()) out.push({ text: w.text, bbox: w.bbox });
  }
  return out;
}

/** The Cancel-able "Recognizing page i of n…" dialog. */
const progressDialog = () => showProgress({ title: 'Recognize text', text: 'Starting text recognition…', statusId: 'ocr-progress', className: 'ocr-progress' });
const CANCEL = CANCELLED;

/** Runs OCR on `indices` (0-based) of `tab` as one page operation. Resolves true when a text layer was added. */
export function recognize(tab, indices, { skipText = true } = {}) {
  return runOp(tab, 'Recognize text', async (bytes, n) => {
    const want = indices.filter((i) => i < n);
    const prog = progressDialog();
    const race = (p) => Promise.race([p, prog.cancelled]);
    let task = null, starting = null, cancelled = false;
    try {
      task = openPdf(tab, bytes);
      const doc = await race(task.promise);
      if (doc === CANCEL) { cancelled = true; return null; }
      const todo = [];
      for (const i of want) {
        const page = await doc.getPage(i + 1);
        if (!skipText || !(await hasText(page))) todo.push(page);
      }
      if (!todo.length) { toast(want.length === 1 ? 'This page already contains text' : 'All the selected pages already contain text'); return null; }
      starting = startWorker();
      const worker = await race(starting);
      if (worker === CANCEL) { cancelled = true; return null; }
      const pages = [];
      for (const [k, page] of todo.entries()) {
        prog.set(`Recognizing page ${k + 1} of ${todo.length}…`);
        const { canvas, geom } = await renderPage(page);
        const res = await race(worker.recognize(canvas, {}, { blocks: true, text: false }));
        canvas.width = 0; canvas.height = 0;
        if (res === CANCEL) { cancelled = true; return null; }
        pages.push({ index: page.pageNumber - 1, geom, words: wordsOf(res.data) });
      }
      const found = pages.reduce((s, p) => s + p.words.length, 0);
      if (!found) { toast('No text was recognized'); return null; }
      const { addTextLayer } = await import('../../src/core/ocr.js');
      const out = await addTextLayer(bytes, pages);
      toast(`Recognized ${found} word${found === 1 ? '' : 's'} on ${pages.length} page${pages.length === 1 ? '' : 's'}`);
      return { bytes: out, map: new Map(range(n).map((i) => [i, i])) };
    } catch (err) {
      if (err instanceof EngineMissing) { showError('Text recognition is not available', err); return null; }
      throw err;
    } finally {
      prog.close();
      if (cancelled) toast('Text recognition cancelled');
      // Cancel mid-start: the worker may still arrive; terminate it whenever it does.
      starting?.then((w) => w.terminate()).catch(() => {});
      task?.destroy();
    }
  });
}

/** Tools > Recognize text (OCR)…: asks for the pages, then runs recognize(). */
export async function ocrDialog(tab = activeTab(), { pages: preset = 'current' } = {}) {
  if (!tab?.pdfDoc) return false;
  const n = tab.numPages;
  const radio = (v, label, checked) => h('label.ocr-radio', {}, h('input', { type: 'radio', name: 'ocr-pages', value: v, id: `ocr-${v}`, checked: checked || null }), h('span', {}, label));
  const pages = h('input.input#ocr-pages-range', { type: 'text', placeholder: `e.g. 1-3, 7 (of ${n})`, 'aria-label': 'Page range' });
  const skip = h('input#ocr-skip', { type: 'checkbox', checked: true });
  const error = h('p.vx-error', { role: 'alert' });
  const body = h('div.ocr-form', {},
    h('div.ocr-radios', { role: 'radiogroup', 'aria-label': 'Pages' },
      radio('current', `Current page (${tab.currentPage + 1})`, preset === 'current'), radio('all', `All pages (${n})`, preset === 'all'), h('div.ocr-row', {}, radio('range', 'Pages'), pages)),
    h('label.ocr-check', {}, skip, h('span', {}, 'Skip pages that already contain text')),
    h('p.ocr-note', {}, 'Language: English. The recognized text is added invisibly behind the page image, so the page can be searched and copied; it looks the same.'),
    error);
  pages.addEventListener('focus', () => { body.querySelector('#ocr-range').checked = true; });
  let indices = null;
  const validate = () => {
    const mode = body.querySelector('input[name="ocr-pages"]:checked').value;
    try {
      indices = mode === 'all' ? range(n) : mode === 'range' ? parseRanges(pages.value, n) : [tab.currentPage];
    } catch (err) { error.textContent = `Pages: ${err.message}`; pages.focus(); return false; }
    return true;
  };
  const res = await showDialog({
    title: 'Recognize text (OCR)', body, className: 'ocr-dialog', initialFocus: `#ocr-${preset}`,
    buttons: [{ label: 'Cancel', value: 'cancel', cancel: true }, { label: 'Recognize', value: 'ok', primary: true, validate }],
  });
  if (res !== 'ok' || !indices) return false;
  return recognize(tab, indices, { skipText: skip.checked });
}

/** Does the start of `tab` look scanned (no text, images over most of the first pages)? */
async function scannedStart(tab) {
  const doc = tab.pdfDoc, OPS = viewer.pdfjs.OPS, pages = [];
  for (let i = 1; i <= Math.min(SAMPLE_PAGES, doc.numPages); i++) {
    const page = await doc.getPage(i);
    const textItems = (await page.getTextContent()).items.filter((it) => it.str?.trim()).length;
    let coverage = 0;
    if (!textItems) { const ops = await page.getOperatorList(); coverage = imageCoverage(ops.fnArray, ops.argsArray, OPS, page.view); }
    pages.push({ textItems, coverage });
  }
  return looksScanned(pages);
}

/** The non-blocking "This looks like a scanned document" bar, shown once per document for the active tab. */
function initScanPrompt() {
  const bar = h('div.scan-bar', { role: 'region', 'aria-label': 'Scanned document', hidden: true },
    h('span.scan-bar-text', {}, 'This looks like a scanned document. Recognize text to make it searchable and copyable.'),
    h('button.btn.scan-bar-go', { type: 'button', onclick: () => { const t = activeTab(); if (t) { t.scanPrompt = false; sync(); ocrDialog(t, { pages: 'all' }); } } }, 'Recognize text'),
    h('button.btn.scan-bar-no', { type: 'button', onclick: () => { const t = activeTab(); if (t) t.scanPrompt = false; sync(); } }, 'Not now'));
  (document.querySelector('.banner') ?? document.querySelector('.toolbar'))?.after(bar);
  const sync = () => { const t = activeTab(); bar.hidden = !(t?.scanPrompt && !t.readOnly); };
  bus.on('tab:activated', sync); bus.on('tab:closed', sync);
  bus.on('tab:loaded', ({ tab, reloaded }) => {
    if (reloaded || tab.scanChecked || !tab.pdfDoc || !pref('ocr.prompt')) return;
    tab.scanChecked = true; // once per document per session
    scannedStart(tab).then((yes) => { if (yes) { tab.scanPrompt = true; sync(); } }, () => {});
  });
}

export function initOcr(app) {
  initScanPrompt();
  app.registerMenuItem('Tools', { separator: true });
  app.registerMenuItem('Tools', { id: 'ocr', label: 'Recognize text (OCR)…', action: () => ocrDialog(), enabled: () => !!activeTab()?.pdfDoc && !activeTab().readOnly });
  app.ocr = { ocrDialog, recognize, startWorker };
}
