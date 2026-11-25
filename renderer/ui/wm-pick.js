// Remove watermark… > Pick it on the page…: for watermarks drawn as ordinary page content (no marking
// that core/watermarks.js can find). The user clicks the watermark's objects on the current page
// (Shift+click adds parts), Enter finds the same objects in the same place on every page
// (wm-pick-lib.js findMatches) and, after a confirm, removes them as one undo step (pdfium wmpick.js).
// Esc cancels at any point and leaves the document unchanged. Picking follows measure-scale.js pickLine.
import { bus } from '../bus.js';
import { h } from './dom.js';
import { showDialog, toast } from './dialogs.js';
import { viewer } from './viewer.js';
import { runOp } from './pagetools.js';
import { pdfium } from '../pdfium/client.js';
import { findMatches, objectAt, summary } from './wm-pick-lib.js';
import { ENTITLED } from './pagemarks.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const HINT = 'Click the watermark (Shift+click to add parts). Enter when done, Esc to cancel.';
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const identity = (n) => new Map(Array.from({ length: n }, (_, i) => [i, i]));

/** Objects of every page of `bytes`: [{ pageIndex, width, height, objects }]. */
async function listPages(bytes) {
  const id = await pdfium.open(bytes);
  try {
    const n = await pdfium.pageCount(id), pages = [];
    for (let i = 0; i < n; i++) pages.push({ pageIndex: i, ...(await pdfium.pageObjects(id, i)) });
    return pages;
  } finally { await pdfium.close(id).catch(() => {}); }
}
async function listPage(bytes, i) {
  const id = await pdfium.open(bytes);
  try { return await pdfium.pageObjects(id, i); } finally { await pdfium.close(id).catch(() => {}); }
}

/**
 * Click-to-pick on page `pageIndex` of `tab`. Resolves the picked objects (as listed by pageObjects),
 * or null on Esc, a click outside the pages or a tab switch.
 */
function pickObjects(tab, pageIndex, objects) {
  const scrollEl = viewer.getScrollEl(tab);
  const pe = viewer.getPageEl(tab, pageIndex);
  const vp1 = tab.pages[pageIndex].getViewport({ scale: 1 });
  const { width, height } = viewer.pageSize(tab, pageIndex);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'overlay-svg ms-cal-svg wm-pick-svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  const ref = viewer.getOverlaySvg(tab, pageIndex);
  if (ref) { svg.style.width = ref.style.width; svg.style.height = ref.style.height; if (ref.dataset.viewRotation) svg.dataset.viewRotation = ref.dataset.viewRotation; }
  pe.append(svg);
  const hint = h('div.vx-snap-hint.wm-pick-hint', { role: 'status' }, HINT);
  document.body.append(hint);
  scrollEl.classList.add('vx-snapping');
  let picked = [];
  const paint = () => {
    svg.replaceChildren(...picked.map((o) => {
      const [l, b, r, t] = o.bbox, q = o.quad ?? [l, b, r, b, r, t, l, t];
      const pts = [0, 2, 4, 6].map((k) => vp1.convertToViewportPoint(q[k], q[k + 1]).map((v) => v.toFixed(2)).join(','));
      const poly = document.createElementNS(SVG_NS, 'polygon');
      poly.setAttribute('class', 'wm-pick-outline');
      poly.setAttribute('points', pts.join(' '));
      return poly;
    }));
    hint.textContent = picked.length ? `${plural(picked.length, 'object')} picked. ${HINT}` : HINT;
  };
  return new Promise((resolve) => {
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    const onDown = (e) => {
      if (!scrollEl.contains(e.target)) { finish(null); return; } // a click elsewhere cancels
      if (e.button !== 0 || !e.target.closest?.('.page')) return; // gaps and scrollbars still scroll
      stop(e);
      let hit = null;
      if (e.target.closest('.page') === pe) {
        const r = pe.getBoundingClientRect();
        const [x, y] = viewer.getViewport(tab, pageIndex).convertToPdfPoint(e.clientX - r.left, e.clientY - r.top);
        hit = objectAt(objects, x, y);
      }
      if (!hit) picked = [];                                       // empty space (or another page) clears
      else if (!e.shiftKey) picked = [hit];
      else if (!picked.includes(hit)) picked = [...picked, hit];
      paint();
    };
    const onUp = (e) => { if (scrollEl.contains(e.target)) stop(e); };
    const onKey = (e) => {
      if (e.key === 'Escape') { stop(e); finish(null); }
      else if (e.key === 'Enter') { stop(e); if (picked.length) finish(picked); }
    };
    const offTab = bus.on('tab:activated', () => finish(null));
    const opts = { capture: true };
    window.addEventListener('pointerdown', onDown, opts);
    window.addEventListener('pointerup', onUp, opts);
    window.addEventListener('keydown', onKey, opts);
    function finish(result) {
      window.removeEventListener('pointerdown', onDown, opts);
      window.removeEventListener('pointerup', onUp, opts);
      window.removeEventListener('keydown', onKey, opts);
      offTab();
      svg.remove();
      hint.remove();
      scrollEl.classList.remove('vx-snapping');
      resolve(result);
    }
  });
}

/** The whole flow; resolves true when objects were removed. */
export async function pickWatermark(tab) {
  if (!tab || tab.readOnly) return false;
  const pageIndex = tab.currentPage ?? 0;
  const { objects } = await listPage(tab.bytes, pageIndex);
  const picked = await pickObjects(tab, pageIndex, objects);
  if (!picked) return false;
  const found = findMatches(picked, await listPages(tab.bytes));
  let signed = false;
  try { signed = (await (await import('../../src/core/signatures.js')).detectSignatures(tab.bytes)).signed; } catch { /* not decisive: no extra warning */ }
  const body = h('div.pt-form.wm-form', {},
    h('p.wm-pick-found', {}, summary(found, tab.numPages ?? tab.pages.length)),
    h('p.pt-hint.wm-note', {}, ENTITLED),
    signed ? h('p.rd-warn.wm-signed', {}, 'Signatures in this document will become invalid.') : null);
  const v = await showDialog({
    title: 'Remove watermark', body, className: 'pt-dialog wm-pick-dialog', initialFocus: '.btn.primary',
    buttons: [{ label: 'Cancel', value: 'cancel', cancel: true }, { label: 'Remove', value: 'ok', primary: true }],
  });
  if (v !== 'ok') return false;
  let removed = 0;
  const ok = await runOp(tab, 'Remove watermark', async (bytes, n) => {
    // Matched again on the op's bytes: object ids belong to one parse of one set of bytes.
    const again = findMatches(picked, await listPages(bytes));
    if (!again.objects) return null;
    const id = await pdfium.open(bytes);
    let out;
    try { out = await pdfium.removeObjects(id, again.pages); } finally { await pdfium.close(id).catch(() => {}); }
    // Page content rewritten: the old bytes still hold the watermark, so the next save must rewrite the
    // whole file (as for Remove watermark and Apply redactions; saveTab clears it after a full save).
    tab.requiresFullSave = true;
    removed = again.pages.length;
    return { bytes: out, map: identity(n) };
  });
  if (ok) toast(`Removed from ${plural(removed, 'page')}`);
  return ok;
}
