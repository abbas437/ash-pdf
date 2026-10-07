// Measurements: bytes added to the app, init time, 50-page open/render time and memory, API shape.
import { statSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { PKG_DIR, WASM_PATH, loadPdfium, openDoc, renderRGBA, makeFixture } from './_lib.mjs';

const kb = (n) => `${(n / 1024).toFixed(0)} KiB`;
const js = join(PKG_DIR, 'dist', 'index.browser.js');
for (const [name, f] of [['pdfium.wasm', WASM_PATH], ['index.browser.js', js]]) {
  const buf = readFileSync(f);
  console.log(`size ${name}: ${kb(buf.length)} raw, ${kb(gzipSync(buf, { level: 9 }).length)} gzip-9`);
}
const rss0 = process.memoryUsage().rss;
const { m, ms } = await loadPdfium();
console.log(`init (compile+instantiate+PDFiumExt_Init): ${ms.toFixed(0)} ms; wasm heap ${kb(m.pdfium.HEAPU8.length)}; rss +${kb(process.memoryUsage().rss - rss0)}`);

const bytes = await makeFixture(50);
let t = performance.now();
const d = openDoc(m, bytes);
console.log(`50-page PDF (${kb(bytes.length)}): open ${(performance.now() - t).toFixed(1)} ms, pages=${m.FPDF_GetPageCount(d.doc)}`);
t = performance.now();
let peakHeap = 0;
for (let i = 0; i < 50; i++) {
  const page = m.FPDF_LoadPage(d.doc, i);
  renderRGBA(m, page, 1.5); // ~108 dpi, 918x1188
  peakHeap = Math.max(peakHeap, m.pdfium.HEAPU8.length);
  m.FPDF_ClosePage(page);
}
const tr = performance.now() - t;
console.log(`render 50 pages @1.5x: ${tr.toFixed(0)} ms total, ${(tr / 50).toFixed(1)} ms/page (incl. BGRA->RGBA copy in JS); wasm heap peak ${kb(peakHeap)}; rss +${kb(process.memoryUsage().rss - rss0)}`);
d.close();
console.log(`API: ${Object.keys(m).filter((k) => /^(FPDF|EPDF|PDFiumExt)/.test(k)).length} cwrapped C functions, all synchronous; only init() is async; single-threaded (no pthreads/SharedArrayBuffer: ${typeof m.pdfium.PThread === 'undefined' ? 'none found' : 'present'})`);
