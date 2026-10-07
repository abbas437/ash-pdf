// Item 1: open from bytes, page count, render to RGBA, compare pixels with pdf.js.
import { loadPdfium, openDoc, renderRGBA, makeFixture, check } from './_lib.mjs';
import { renderPage } from '../../../test/helpers.js';

const { m, ms } = await loadPdfium();
console.log(`init ${ms.toFixed(0)} ms`);
const bytes = await makeFixture(3);
const d = openDoc(m, bytes);
check('FPDF_GetPageCount', m.FPDF_GetPageCount(d.doc) === 3, `count=${m.FPDF_GetPageCount(d.doc)}`);
const page = m.FPDF_LoadPage(d.doc, 0);
const img = renderRGBA(m, page, 1);
console.log(`rendered ${img.w}x${img.h} RGBA (${img.rgba.length} bytes)`);
const pj = await renderPage(bytes, 0, 1);
// Top-left visible coords: image drawn at PDF (300,480)-(460,560) -> visible y = 792-560..792-480
const probes = [['image centre', 380, 272], ['blank margin', 20, 20], ['inside "I" of Invoice', 51, 87]];
for (const [name, x, y] of probes) {
  const a = img.px(x, y), b = pj.sample(x, y);
  const diff = Math.max(...[0, 1, 2].map((k) => Math.abs(a[k] - b[k])));
  check(`pixel ${name} (${x},${y}) pdfium vs pdf.js`, diff <= 60, `pdfium=${a.slice(0, 3)} pdfjs=${b.slice(0, 3)} maxdiff=${diff}`);
}
m.FPDF_ClosePage(page);
d.close();
