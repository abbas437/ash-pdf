// Tools > Compare revisions…: compares an older and a newer revision of a submittal page by page (by
// index) and opens the result as a new, unsaved overlay PDF (src/core/compareReport.js): unchanged ink
// grey, removed red, added green, a dashed rectangle with a note round each changed area.
// Per page pair: both pages are drawn by pdf.js on white with annotations off at the same pixel size
// (the newer page's at the chosen dpi, lowered to fit a canvas; an older page of another size is
// scaled to fit it), compared by compare-lib.js comparePages, and their words diffed by
// textdiff-lib.js. The pixel compare runs in a worker (compare-client.js), so the window and Cancel stay
// responsive; Cancel terminates it mid-page and cancels a page being drawn (renderTask.cancel). Pages in one
// revision only become 'added' / 'removed' pages (onlyPage). The composite is PNG, or JPEG q 0.85 above JPEG_PIXELS, and goes into the report as soon as it is
// made (createCompareReport). Canvases and pdf.js page resources (page.cleanup) are released after every page
// and the loop yields to the UI between pages; Cancel stops it before the report is finished, so no tab opens.
// The per-page results stay on the new tab (tab.compare) for the Differences sidebar panel.
import { bus } from '../bus.js';
import { state, activeTab } from '../state.js';
import { h } from './dom.js';
import { showDialog, showError, toast, progressDialog, CANCELLED } from './dialogs.js';
import { registerSidebarTab, showSidebarTab, refreshSidebarTab } from './sidebar.js';
import { viewer } from './viewer.js';
import { splitView } from './splitview.js';
import { onlyPage, regionsToPoints } from './compare-lib.js';
import { compareWorker } from './compare-client.js';
import { pageWords, diffWords } from './textdiff-lib.js';
import { DPI_PRESETS, DEFAULT_OPTIONS, guessOrder, renderScale, pagePairs, hasChanges, pageLabel, pageSummary, regionKind, diffCsv, diffText } from './comparerev-lib.js';
import { parseRanges } from '../../src/core/pdfOps.js';

const OPTIONS_KEY = 'compare.options';
const JPEG_PIXELS = 4e6; // above this a composite is stored as JPEG (A1 at 150 dpi: 17 Mpx)
const TAB = 'differences';
const BROWSE = '__browse__';
let app = null;

const nextFrame = () => new Promise((r) => setTimeout(r, 0));
/** A short, single-line reason for a page that failed: no stack, no control characters, at most 100 characters. */
const errorReason = (err) => {
  const t = String(err?.message ?? err ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() || 'unknown error';
  return t.length > 100 ? `${t.slice(0, 99)}…` : t;
};
const release = (c) => { c.width = 0; c.height = 0; };
/** e2e hook (test/e2e/comparerev.mjs): stage timestamps of a run, when the test sets window.__compareTrace = []. */
const trace = (stage) => window.__compareTrace?.push({ stage, t: performance.now() });
const baseName = (n) => String(n ?? '').replace(/\.pdf$/i, '');

async function loadOptions() {
  try { return { ...DEFAULT_OPTIONS, ...((await window.api.settingsGet(OPTIONS_KEY)) ?? {}) }; } catch { return { ...DEFAULT_OPTIONS }; }
}

/** Page i of `tab` drawn on white into a W x H canvas, scaled to fit (top-left). Returns {canvas, rgba, fit}.
 *  live.task is the pdf.js render task while it draws, so Cancel can stop it (renderTask.cancel). */
async function draw(tab, i, W, H, live) {
  const page = tab.pages[i];
  const v1 = page.getViewport({ scale: 1 });
  const fit = Math.min(W / v1.width, H / v1.height);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  trace('draw');
  live.task = page.render({ canvas: c, viewport: page.getViewport({ scale: fit }), background: '#ffffff', annotationMode: viewer.pdfjs.AnnotationMode.DISABLE });
  try {
    await live.task.promise;
  } finally {
    live.task = null;
    page.cleanup(); // drop this render's operator list and decoded images (pdf.js skips it while the viewer is drawing the page)
  }
  const rgba = ctx.getImageData(0, 0, W, H).data;
  return { canvas: c, rgba, fit, v1 };
}

async function encode(rgba, W, H) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length), W, H), 0, 0);
  const jpeg = W * H > JPEG_PIXELS;
  const blob = await new Promise((r) => c.toBlob(r, jpeg ? 'image/jpeg' : 'image/png', 0.85));
  release(c);
  if (!blob) throw new Error(`could not encode a ${W} x ${H} page image`);
  return { bytes: new Uint8Array(await blob.arrayBuffer()), type: jpeg ? 'jpeg' : 'png' };
}

async function words(tab, i) {
  const page = tab.pages[i];
  return pageWords((await viewer.getTextContent(tab, i)).items, page.view, page.rotate);
}

/**
 * Compare `older` and `newer` (open tabs) with opts {indices?, dpi, align, text}.
 * Resolves the new compare tab, or null when cancelled.
 */
export async function compareRevisions(older, newer, opts = {}) {
  const o = { ...DEFAULT_OPTIONS, ...opts };
  const pairs = pagePairs(older.numPages, newer.numPages, o.indices);
  const prog = progressDialog({ title: 'Compare revisions', text: 'Starting…', statusId: 'compare-progress', className: 'compare-progress' });
  const results = [];
  const t0 = performance.now();
  const live = { task: null }; // the page being drawn
  prog.cancelled.then(() => live.task?.cancel()); // Cancel stops a draw at once (it rejects; Cancel wins below)
  try {
    const { createCompareReport } = await import('../../src/core/index.js');
    const report = await createCompareReport({ older: { name: older.name }, newer: { name: newer.name }, date: new Date() });
    for (const [k, p] of pairs.entries()) {
      if (prog.isCancelled()) return null;
      prog.set(`Comparing page ${k + 1} of ${pairs.length}…`);
      await nextFrame();
      const ref = p.newer !== null ? newer : older, ri = p.newer ?? p.older;
      // index: the output page in the compare document; olderPage / newerPage: the 1-based source pages (null: none).
      const res = { index: k, older: p.older, newer: p.newer, olderPage: p.older === null ? null : p.older + 1, newerPage: p.newer === null ? null : p.newer + 1, regions: [], text: { added: [], removed: [] }, stats: null, shift: { dx: 0, dy: 0 }, scaled: false, capped: false };
      let size = { width: 595.28, height: 841.89 }; // used for a failed page whose own size is unknown
      let page; // this page of the report
      try {
        const v = ref.pages[ri].getViewport({ scale: 1 });
        size = { width: v.width, height: v.height };
        if (window.__compareFailPage === ri + 1) throw new Error('Test failure: page render failed'); // e2e hook (test/e2e/comparerev.mjs)
        const scale = renderScale(v.width, v.height, o.dpi);
        const W = Math.max(1, Math.round(v.width * scale)), H = Math.max(1, Math.round(v.height * scale));
        let composite;
        if (p.older !== null && p.newer !== null) {
          const drawBoth = async () => {
            const b = await draw(newer, p.newer, W, H, live);
            const a = await draw(older, p.older, W, H, live);
            release(a.canvas); release(b.canvas);
            return { a, b };
          };
          let { a, b } = await drawBoth();
          res.scaled = Math.abs(a.v1.width - v.width) > 0.5 || Math.abs(a.v1.height - v.height) > 0.5;
          if (prog.isCancelled()) return null;
          trace('compare');
          const run = (x, y) => Promise.race([compareWorker.compare(x.rgba, y.rgba, W, H, { align: o.align }), prog.cancelled]);
          let cmp = await run(a, b).catch(async (err) => {
            if (!err?.lost || prog.isCancelled()) throw err;
            ({ a, b } = await drawBoth()); // the worker was lost holding the pixels: draw again, compare on the main thread
            return run(a, b);
          });
          if (cmp === CANCELLED) { compareWorker.stop(); return null; } // terminate the worker mid-page
          trace('compared');
          composite = cmp.composite;
          Object.assign(res, { regions: regionsToPoints(cmp.regions, scale), stats: cmp.stats, capped: cmp.capped,
            shift: { dx: cmp.shift.dx / scale, dy: cmp.shift.dy / scale } });
          res.status = 'compared';
          if (o.text) {
            const k2 = a.fit / scale; // older points -> newer points when the older page was scaled to fit
            const ow = (await words(older, p.older)).map((w) => ({ ...w, box: { x: w.box.x * k2, y: w.box.y * k2, w: w.box.w * k2, h: w.box.h * k2 } }));
            const d = diffWords(ow, await words(newer, p.newer), { shiftPt: res.shift });
            res.text = { added: d.added, removed: d.removed };
          }
        } else {
          const one = await draw(ref, ri, W, H, live);
          release(one.canvas);
          composite = onlyPage(one.rgba, W, H, p.newer !== null ? 'newer' : 'older');
          res.status = p.newer !== null ? 'added' : 'removed';
        }
        if (prog.isCancelled()) return null;
        const image = await encode(composite, W, H);
        page = { width: v.width, height: v.height, image, regions: res.regions, status: res.status, textChanges: res.text, olderPage: res.olderPage, newerPage: res.newerPage };
      } catch (err) {
        if (err === CANCELLED || prog.isCancelled()) return null; // Cancel wins over errors
        // Skip this page, keep going: the report gets a blank page with the reason.
        const reason = errorReason(err);
        console.warn(`[compare] page ${res.newerPage ?? res.olderPage} not compared: ${err?.message ?? err}`);
        Object.assign(res, { status: 'error', error: reason, regions: [], text: { added: [], removed: [] }, stats: null, shift: { dx: 0, dy: 0 }, scaled: false, capped: false });
        page = { ...size, status: 'error', error: reason, olderPage: res.olderPage, newerPage: res.newerPage };
      }
      results.push(res);
      try {
        if (window.__compareFailEmbed === res.index + 1) throw new Error('Test failure: page embed failed'); // e2e hook
        await report.addPage(page); // embedded now: the encoded image is not kept here
      } catch (err) {
        // The report is left unchanged by a failed addPage: add this page again as a blank error page.
        const reason = errorReason(err);
        console.warn(`[compare] page ${res.newerPage ?? res.olderPage} not added to the report: ${err?.message ?? err}`);
        Object.assign(res, { status: 'error', error: reason, regions: [], text: { added: [], removed: [] }, stats: null, shift: { dx: 0, dy: 0 }, scaled: false, capped: false });
        await report.addPage({ width: page.width, height: page.height, status: 'error', error: reason, olderPage: res.olderPage, newerPage: res.newerPage });
      }
    }
    if (prog.isCancelled() || !results.length) return null;
    const failed = results.filter((r) => r.status === 'error');
    if (failed.length === results.length) {
      const nums = failed.map((r) => r.newerPage ?? r.olderPage);
      prog.close(); // not behind the error dialog
      await showError('Could not compare the revisions', new Error(`No page could be compared (page${nums.length === 1 ? '' : 's'} ${nums.join(', ')}). ${failed[0].error}`));
      return null;
    }
    prog.set('Building the compare document…');
    const bytes = await report.finish();
    if (prog.isCancelled()) return null;
    const ms = Math.round(performance.now() - t0);
    console.info(`[compare] ${pairs.length} page(s) in ${ms} ms, ${bytes.length} bytes`);
    const tab = await app.openBytes({ name: `Compare – ${baseName(older.name)} vs ${baseName(newer.name)}.pdf`, bytes });
    if (!tab) return null;
    tab.compare = { older: { id: older.id, name: older.name }, newer: { id: newer.id, name: newer.name }, pages: results, ms, bytes: bytes.length };
    showSidebarTab(TAB);
    if (!state.sidebarOpen) state.sidebarOpen = true;
    refreshSidebarTab(TAB);
    const changed = results.filter((r) => hasChanges(r) && r.status !== 'error').length;
    const skipped = failed.length ? `; ${failed.length} not compared` : '';
    toast((changed ? `${changed} page${changed === 1 ? '' : 's'} with differences` : 'No differences found') + skipped);
    return tab;
  } catch (err) {
    if (err !== CANCELLED) showError('Could not compare the revisions', err);
    return null;
  } finally {
    compareWorker.stop(); // the worker lives for one run
    prog.close();
  }
}

async function browse() {
  const files = await window.api.openFiles({ filters: [{ name: 'PDF', extensions: ['pdf'] }], multiple: false });
  const f = files?.[0];
  if (!f) return null;
  const { bytes, stamp } = f.bytes instanceof Uint8Array ? f : await window.api.readFile(f.path, { withStamp: true });
  return app.openBytes({ name: f.name ?? String(f.path).split(/[\\/]/).pop(), path: f.path ?? null, bytes, stamp: stamp ?? null });
}

/** Tools > Compare revisions…: choose the documents and options, then compareRevisions(). */
export async function compareDialog() {
  const tabs = state.tabs.filter((t) => t.pdfDoc && !t.compare);
  const cur = activeTab();
  const recentTwo = tabs.length >= 2 ? [tabs[tabs.length - 2], tabs[tabs.length - 1]] : tabs;
  const [g0, g1] = recentTwo.length === 2 ? guessOrder(...recentTwo) : [recentTwo[0] ?? cur, recentTwo[0] ?? cur];
  const saved = await loadOptions();
  const pick = (id, label, sel) => h('label.cmp-row', {}, h('span', {}, label),
    h('select.input', { id, 'aria-label': label }, tabs.map((t) => h('option', { value: t.id, selected: t === sel }, t.name)), h('option', { value: BROWSE }, 'Browse…')));
  const check = (id, label, on) => h('label.cmp-check', {}, h('input', { type: 'checkbox', id, checked: on || null }), h('span', {}, label));
  const range = h('input.input#cmp-range', { type: 'text', placeholder: 'All pages, or e.g. 1-5', 'aria-label': 'Pages' });
  const dpi = h('select.input#cmp-dpi', { 'aria-label': 'Quality' }, DPI_PRESETS.map((d) => h('option', { value: d, selected: d === saved.dpi }, `${d} dpi${d === 150 ? ' (default)' : ''}`)));
  const error = h('p.vx-error', { role: 'alert' });
  const body = h('div.cmp-form', {},
    pick('cmp-older', 'Older revision', g0), pick('cmp-newer', 'Newer revision', g1),
    h('label.cmp-row', {}, h('span', {}, 'Pages'), range),
    h('label.cmp-row', {}, h('span', {}, 'Quality'), dpi),
    check('cmp-align', 'Align shifted pages automatically', saved.align),
    check('cmp-text', 'List text changes', saved.text),
    h('p.ocr-note', {}, 'Pages are compared in order (page 1 with page 1, …) as pictures at the chosen quality.'),
    error);
  for (const id of ['#cmp-older', '#cmp-newer']) {
    const sel = body.querySelector(id);
    sel.addEventListener('change', async () => {
      if (sel.value !== BROWSE) return;
      const t = await browse().catch((err) => { showError('Could not open the file', err); return null; });
      if (!t) { sel.value = tabs[0]?.id ?? ''; return; }
      tabs.push(t);
      for (const s of body.querySelectorAll('select[id^="cmp-o"], select[id^="cmp-n"]')) s.insertBefore(h('option', { value: t.id }, t.name), s.lastChild);
      sel.value = t.id;
    });
  }
  let chosen = null;
  const validate = () => {
    const older = tabs.find((t) => t.id === body.querySelector('#cmp-older').value);
    const newer = tabs.find((t) => t.id === body.querySelector('#cmp-newer').value);
    if (!older || !newer) { error.textContent = 'Choose an older and a newer document.'; return false; }
    if (older === newer) { error.textContent = 'Choose two different documents.'; return false; }
    let indices = null;
    try { if (range.value.trim()) indices = parseRanges(range.value, Math.max(older.numPages, newer.numPages)); } catch (err) { error.textContent = `Pages: ${err.message}`; range.focus(); return false; }
    chosen = { older, newer, opts: { indices, dpi: Number(dpi.value),
      align: body.querySelector('#cmp-align').checked, text: body.querySelector('#cmp-text').checked } };
    return true;
  };
  const res = await showDialog({ title: 'Compare revisions', body, className: 'compare-dialog', help: 'compare-revisions', initialFocus: '#cmp-older',
    buttons: [{ label: 'Cancel', value: 'cancel', cancel: true }, { label: 'Compare', value: 'ok', primary: true, validate }] });
  if (res !== 'ok' || !chosen) return null;
  const { indices, ...keep } = chosen.opts;
  window.api.settingsSet(OPTIONS_KEY, keep).catch(() => {});
  return compareRevisions(chosen.older, chosen.newer, chosen.opts);
}

// ---------------------------------------------------------------- Differences panel

/**
 * One compare mark read from its /Contents (see compareReport.js): "Change 3: added" / "removed" / "added and
 * removed" for an area, "Change 4: text added" / "text removed" plus a `Text: "…"` line for a text phrase.
 * Returns {area: kind} or {text: side, phrase}, or null for a note in another wording.
 */
function parseMark(note) {
  const lines = String(note ?? '').split('\n');
  const m = /^Change \d+: (text )?(added and removed|added|removed)\s*$/.exec(lines[0].trim());
  if (!m) return null;
  if (!m[1]) return { area: m[2] };
  const t = lines.slice(1).find((l) => l.startsWith('Text: '));
  return { text: m[2], phrase: t ? t.slice(6).replace(/^"|"$/g, '') : '' };
}

/** A basic list from a saved compare PDF: its /T "Compare" squares (session results are richer). */
function fromAnnotations(tab) {
  const objs = (tab.objects ?? []).filter((o) => o.author === 'Compare');
  if (!objs.length) return null;
  const pages = new Map();
  for (const o of objs) {
    const p = pages.get(o.page) ?? { index: o.page, status: 'compared', regions: [], text: { added: [], removed: [] }, notes: [] };
    const first = String(o.note ?? '').split('\n')[0];
    const mark = parseMark(o.note);
    if (mark?.text) {
      p.text[mark.text].push({ text: mark.phrase });
      p.notes.push({ text: `${mark.text === 'added' ? '+' : '−'} ${mark.phrase}`, id: o.id });
    } else {
      // regionKind() reads added / removed pixel counts: 1 / 0, 0 / 1 or 1 / 1 stand for the kind.
      const kind = mark?.area;
      p.regions.push({ added: kind === 'removed' ? 0 : 1, removed: kind === 'added' ? 0 : 1 });
      p.notes.push({ text: first, id: o.id });
    }
    pages.set(o.page, p);
  }
  return [...pages.values()].sort((a, b) => a.index - b.index);
}

/** Scroll page i into view and flash box b (top-left points) with a temporary SVG rectangle. */
function flash(tab, i, b) {
  viewer.scrollToPage(tab, i);
  if (!b) return;
  requestAnimationFrame(() => {
    const ref = viewer.getOverlaySvg(tab, i), pageEl = viewer.getPageEl(tab, i);
    if (!ref || !pageEl) return;
    const { width, height } = viewer.pageSize(tab, i);
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'overlay-svg cmp-flash');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.width = ref.style.width; svg.style.height = ref.style.height;
    if (ref.dataset.viewRotation) svg.dataset.viewRotation = ref.dataset.viewRotation;
    const r = document.createElementNS(NS, 'rect');
    Object.entries({ x: b.x - 4, y: b.y - 4, width: b.w + 8, height: b.h + 8, fill: 'none', stroke: '#1a73e8', 'stroke-width': 3, 'stroke-dasharray': '6 3' }).forEach(([k, v]) => r.setAttribute(k, String(v)));
    svg.append(r);
    pageEl.append(svg);
    pageEl.scrollIntoView?.({ block: 'nearest' });
    setTimeout(() => svg.remove(), 1600);
  });
}

/** The older and newer revisions side by side, each pane at its own source page of result p. */
function sideBySide(tab, p) {
  const c = tab.compare;
  const a = state.tabs.find((t) => t.id === c?.older.id), b = state.tabs.find((t) => t.id === c?.newer.id);
  if (!a || !b) { toast('Open both revisions to show them side by side'); return; }
  splitView.open([a.id, b.id], 'v', { sync: true, focus: 1 });
  const at = (t, n) => viewer.scrollToPage(t, Math.max(0, Math.min((n ?? 1) - 1, t.numPages - 1)));
  at(a, p.olderPage ?? p.newerPage);
  at(b, p.newerPage ?? p.olderPage);
}

async function copyList(pages) {
  // api.copyText: navigator.clipboard is denied in the app (see copytext.js).
  try { await window.api.copyText(diffText(pages)); toast('Differences copied'); } catch (err) { showError('Copy list', err); }
}

async function exportCsv(tab, pages) {
  try {
    await window.api.saveFile({ defaultPath: `${baseName(tab.name)}-differences.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }], bytes: new TextEncoder().encode(diffCsv(pages)) });
  } catch (err) { showError('Export differences', err); }
}

/**
 * Source page numbers of a reopened compare PDF, read from its pages' /ASHCompare keys (compareReport.js).
 * Cached on the tab per bytes; the panel is redrawn when they arrive. A page without them keeps no source numbers.
 */
function loadSources(tab) {
  if (tab.cmpSources?.bytes === tab.bytes) return tab.cmpSources.list;
  const mine = { bytes: tab.bytes, list: null };
  tab.cmpSources = mine;
  import('../../src/core/index.js').then(({ readCompareSources }) => readCompareSources(tab.bytes))
    .then((list) => { mine.list = list; }, () => { mine.list = []; })
    .then(() => { if (tab.cmpSources === mine && mine.list.some(Boolean)) refreshSidebarTab(TAB); });
  return null;
}

function render(container, tab) {
  if (!tab) { container.replaceChildren(h('p.sb-empty', {}, 'No document open')); return; }
  const live = tab.compare?.pages;
  const saved = !live && fromAnnotations(tab);
  if (saved) {
    const src = loadSources(tab);
    for (const p of saved) { // unknown (no key): both stay unset, the Older column stays blank
      const s = src?.[p.index];
      if (s) Object.assign(p, { newerPage: s.newerPage, olderPage: s.olderPage });
    }
  }
  if (!live && !saved) { container.replaceChildren(h('p.sb-empty', {}, 'Not a compare document. Use Tools › Compare revisions… to make one.')); return; }
  const list = h('div.cmp-list', { role: 'list', 'aria-label': 'Differences' });
  const item = (label, onclick, cls = '') => h(`button.cmp-item${cls}`, { type: 'button', role: 'listitem', onclick }, label);
  if (live) {
    const changed = live.filter(hasChanges);
    if (!changed.length) list.append(h('p.sb-empty', {}, 'No differences found'));
    for (const p of changed) {
      list.append(h('div.cmp-page', {},
        item(pageSummary(p), () => flash(tab, p.index, null), '.cmp-page-head'),
        p.scaled ? h('p.cmp-note', {}, 'Pages differ in size: the older page was scaled to fit.') : null,
        p.capped ? h('p.cmp-note', {}, 'Many changes: shown as one area.') : null,
        h('button.btn.cmp-sbs', { type: 'button', onclick: () => sideBySide(tab, p) }, 'Side by side')));
      p.regions.forEach((r, k) => list.append(item(`Change ${k + 1}: ${regionKind(r)}`, () => flash(tab, p.index, r))));
      for (const t of p.text.added) list.append(item(`+ ${t.text}`, () => flash(tab, p.index, t.box), '.cmp-add'));
      for (const t of p.text.removed) list.append(item(`− ${t.text}`, () => flash(tab, p.index, t.box), '.cmp-rem'));
    }
  } else {
    list.append(h('p.cmp-note', {}, 'Saved compare document: the list is read from its compare marks. Run the compare again for the text list and Side by side.'));
    for (const p of saved) {
      list.append(h('div.cmp-page', {}, item(`${pageLabel(p)} — ${p.notes.length} mark${p.notes.length === 1 ? '' : 's'}`, () => flash(tab, p.index, null), '.cmp-page-head')));
      for (const n of p.notes) list.append(item(n.text || 'Change', () => { viewer.scrollToPage(tab, p.index); app.annotations?.select(tab, [n.id]); }));
    }
  }
  const pages = live ?? saved;
  const bar = h('div.cm-toolbar', {},
    h('button.btn.cmp-copy', { type: 'button', onclick: () => copyList(pages) }, 'Copy list'),
    h('button.btn.cmp-csv', { type: 'button', onclick: () => exportCsv(tab, pages) }, 'Export CSV'));
  container.replaceChildren(bar, list);
}

export function initCompareRevisions(a) {
  app = a;
  registerSidebarTab({ id: TAB, label: 'Differences', icon: 'search', render });
  a.registerMenuItem('Tools', { separator: true });
  a.registerMenuItem('Tools', { id: 'compare-revisions', label: 'Compare revisions…', action: () => compareDialog(), enabled: () => state.tabs.some((t) => t.pdfDoc) });
  bus.on('tab:activated', ({ tab }) => { if (tab?.compare || (tab && fromAnnotations(tab))) showSidebarTab(TAB); });
  a.compareRevisions = { compareDialog, compareRevisions };
}
