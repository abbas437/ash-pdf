// scripts/pdfjs-patch.mjs: the pdf.js source patches applied by scripts/vendor.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PDFDocument, PDFName } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import { patchPdfjs } from '../scripts/pdfjs-patch.mjs';

const BUILD = fileURLToPath(new URL('../node_modules/pdfjs-dist/legacy/build/', import.meta.url));
const MIN = readFileSync(BUILD + 'pdf.min.mjs', 'utf8');

// Page filled with a colored tiling pattern whose tile is wider than the page.
// 'single': one 1000 x 1000 tile at Matrix scale 3 covers the page, which shows the tile's middle
//   (tile x 500..704, inside the blue x 400..1000). Its content sets a blend mode, so pdf.js isolates it (drawPattern), as a tile
//   with a soft mask is.
// 'repeat': a 1000 x 100 tile repeated down the page (the fill spans 8 tiles, so pdf.js builds a
//   repeating pattern canvas); the page shows tile x 300..912, inside the blue x 250..1000.
async function bigTileFixture(kind) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const single = kind === 'single';
  // Only the right part of the tile is painted, so a tile drawn from just its left part (the defect)
  // leaves the page white instead of blue.
  const tile = doc.context.stream(`${single ? '/G0 gs 0 0 1 rg 400 0 600 1000' : '0 0 1 rg 250 0 750 100'} re f`, {
    Type: 'Pattern', PatternType: 1, PaintType: 1, TilingType: 1,
    BBox: [0, 0, 1000, single ? 1000 : 100], XStep: 1000, YStep: single ? 1000 : 100,
    Matrix: single ? [3, 0, 0, 3, -1500, -1500] : [1, 0, 0, 1, -300, 0],
    Resources: single ? { ExtGState: { G0: { Type: 'ExtGState', BM: 'Multiply' } } } : {},
  });
  page.node.set(PDFName.of('Resources'), doc.context.obj({ Pattern: { P0: doc.context.register(tile) } }));
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('/Pattern cs /P0 scn 0 0 612 792 re f')));
  return doc.save();
}

// Renders page 1 with the given pdf.min.mjs source (written beside the real build so its imports and
// the fake worker resolve) and returns the RGBA of a few points spread over the page.
async function samples(src, bytes, scale) {
  const file = `${BUILD}.ash-patch-test-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`;
  writeFileSync(file, src);
  try {
    const pdfjs = await import(pathToFileURL(file).href);
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(BUILD + 'pdf.worker.min.mjs').href;
    const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0, isEvalSupported: false }).promise;
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, canvas, viewport }).promise;
    await doc.loadingTask.destroy();
    return [[0.1, 0.1], [0.5, 0.5], [0.9, 0.5], [0.9, 0.9]].map(([fx, fy]) =>
      Array.from(ctx.getImageData(Math.floor(fx * canvas.width), Math.floor(fy * canvas.height), 1, 1).data));
  } finally {
    rmSync(file, { force: true });
  }
}
const isBlue = ([r, g, b]) => r < 40 && g < 40 && b > 215;

test('patchPdfjs matches the bundled pdf.js exactly once and derives the scale from the capped size', () => {
  const out = patchPdfjs(MIN);
  assert.notEqual(out, MIN);
  assert.match(out, /getSizeAndScale\((\w+),\w+,(\w+)\)\{const (\w+)=Math\.max\(TilingPattern\.MAX_PATTERN_SIZE,\w+\);let (\w+)=Math\.ceil\(\1\*\2\);\4>=\3&&\(\4=\3\);\2=\4\/\1;return\{scale:\2,size:\4\}\}/);
  assert.throws(() => patchPdfjs(out), /matched 0 times/);
  assert.throws(() => patchPdfjs('export {}'), /matched 0 times/);
});

for (const [kind, scale] of [['single', 2], ['repeat', 4]]) {
  test(`a tiling pattern tile larger than the pattern canvas limit is drawn whole at high zoom (${kind})`, async () => {
    const bytes = await bigTileFixture(kind);
    // At this scale the tile is 6000 px ('single') or 4000 px ('repeat') wide, over the 3000 px limit.
    const patched = await samples(patchPdfjs(MIN), bytes, scale);
    assert.ok(patched.every(isBlue), `patched pdf.js left part of the page unpainted: ${JSON.stringify(patched)}`);
    // The fixture reproduces the defect with the unpatched build (otherwise this test would prove nothing).
    const unpatched = await samples(MIN, bytes, scale);
    assert.ok(!unpatched.every(isBlue), 'unpatched pdf.js painted the whole page; the fixture no longer exercises the clipping');
    // At scale 1 the tile is within the limit and is drawn whole.
    assert.ok((await samples(patchPdfjs(MIN), bytes, 1)).every(isBlue));
  });
}
