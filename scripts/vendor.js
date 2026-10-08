#!/usr/bin/env node
// Copies the browser runtime of the PDF libraries from node_modules into
// renderer/vendor/ so the renderer can load them through its import map
// (no bundler, no node_modules inside the packaged app).
//
// Output (final names, referenced by renderer/index.html's import map):
//   renderer/vendor/pdf.min.mjs            pdfjs-dist legacy/build/pdf.min.mjs           ("pdfjs-dist")
//   renderer/vendor/pdf.worker.min.mjs     pdfjs-dist legacy/build/pdf.worker.min.mjs    ("pdfjs-worker")
//   renderer/vendor/pdfjs/cmaps/           pdfjs-dist cmaps/          -> getDocument({ cMapUrl })
//   renderer/vendor/pdfjs/standard_fonts/  pdfjs-dist standard_fonts/ -> getDocument({ standardFontDataUrl })
//   renderer/vendor/pdfjs/wasm/            pdfjs-dist wasm/ (JPEG2000, JBIG2, QCMS colour) -> getDocument({ wasmUrl })
//   renderer/vendor/pdfjs/iccs/            pdfjs-dist iccs/ (CMYK ICC profile)            -> getDocument({ iccUrl })
//   renderer/vendor/pdf-lib.esm.min.js     pdf-lib dist/pdf-lib.esm.min.js (self-contained ES module) ("pdf-lib")
//   renderer/vendor/fontkit.esm.js         generated ES wrapper around @pdf-lib/fontkit's UMD build ("@pdf-lib/fontkit")
//   renderer/vendor/minisearch.js          minisearch dist/es/index.js (self-contained ES module) ("minisearch")
//   renderer/vendor/write-excel-file.esm.js generated ES wrapper around write-excel-file's UMD bundle (fflate inlined) ("write-excel-file")
//   renderer/vendor/docx.mjs                docx dist/index.mjs (self-contained ES module, MIT; bundles jszip, pako, sax, xml-js...) ("docx")
//   renderer/vendor/mammoth.mjs             generated ES wrapper around mammoth's browserify bundle (BSD-2-Clause) ("mammoth")
//   renderer/vendor/read-excel-file.mjs    generated ES wrapper around read-excel-file's UMD browser bundle (fflate, saxen inlined) (MIT) ("read-excel-file")
//   renderer/vendor/fonts/<font>-latin-400-normal.woff2  @fontsource/* handwriting fonts (SIL OFL 1.1) for typed signatures
//   renderer/vendor/fonts/edit/<Family>-<Style>.ttf  @expo-google-fonts/{carlito,caladea,arimo,tinos,cousine} full TrueType fonts
//                                           (SIL OFL 1.1): substitutes for editing original PDF text (renderer/pdfium/textedit.js FONT_FILES)
//   renderer/vendor/pdfium/index.browser.js @embedpdf/pdfium dist/index.browser.js (PDFium wasm glue, MIT) -> renderer/pdfium/worker.js
//   renderer/vendor/pdfium/pdfium.wasm      @embedpdf/pdfium dist/pdfium.wasm (PDFium, BSD-3-Clause/Apache-2.0) -> renderer/pdfium/client.js
//   renderer/vendor/tesseract/worker.min.js tesseract.js dist/worker.min.js (OCR worker, Apache-2.0), started as a same-origin Worker
//   renderer/vendor/tesseract/tesseract.esm.min.js tesseract.js dist/tesseract.esm.min.js (createWorker API)
//   renderer/vendor/tesseract/tesseract-core-simd-lstm.{js,wasm} tesseract.js-core (Tesseract + Leptonica wasm, LSTM-only, SIMD);
//                                           kept beside worker.min.js because Emscripten resolves the .wasm against the worker URL
//   renderer/vendor/tessdata/eng.traineddata.gz @tesseract.js-data/eng 4.0.0_best_int (English LSTM model, Apache-2.0)
//   renderer/vendor/licenses/              licence files of everything above
//
// Why fontkit is wrapped: @pdf-lib/fontkit's ES build (dist/fontkit.es.min.js) does
// `import pako from "pako"`, and pako 1.x ships no ES module. Its UMD build is fully
// self-contained (pako bundled), so we emit a module that gives the UMD factory a
// CommonJS-style `module` object and re-exports `module.exports` as the default export.
//
// Idempotent: renderer/vendor/ is deleted and rebuilt on every run.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FONT_FILES } from '../renderer/pdfium/textedit.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const out = join(root, 'renderer', 'vendor');

const copied = [];
function copy(src, dest, filter) {
  const from = join(nm, src);
  if (!existsSync(from)) throw new Error(`vendor: missing ${relative(root, from)} — run npm ci`);
  const to = join(out, dest);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, filter: filter ? (p) => filter(p) : undefined });
  copied.push(`${src} -> renderer/vendor/${dest}`);
}
function version(pkg) {
  return JSON.parse(readFileSync(join(nm, pkg, 'package.json'), 'utf8')).version;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// --- pdf.js (Apache-2.0) ---
// The legacy build is used: the modern build needs very recent JS built-ins (e.g.
// Map.prototype.getOrInsertComputed) that the Playwright test Chromium lacks; legacy
// polyfills them and runs in both Electron and test browsers.
copy('pdfjs-dist/legacy/build/pdf.min.mjs', 'pdf.min.mjs');
copy('pdfjs-dist/legacy/build/pdf.worker.min.mjs', 'pdf.worker.min.mjs');
copy('pdfjs-dist/cmaps', 'pdfjs/cmaps');
// Liberation fonts are excluded: pdf.js ships Liberation 1.x under GPL-2.0 with a font
// exception, outside this project's font policy (OFL/Apache/MIT/BSD). Without them pdf.js
// renders non-embedded Helvetica/Arial with the system's sans-serif font.
copy('pdfjs-dist/standard_fonts', 'pdfjs/standard_fonts', (p) => !/Liberation/i.test(p));
// quickjs-eval.* only serves PDF JavaScript (enableScripting), which this app keeps off.
copy('pdfjs-dist/wasm', 'pdfjs/wasm', (p) => !/quickjs-eval\./.test(p));
copy('pdfjs-dist/iccs', 'pdfjs/iccs');
copy('pdfjs-dist/LICENSE', 'licenses/pdfjs-dist-LICENSE.txt');

// --- pdf-lib (MIT) — dist/pdf-lib.esm.min.js is a self-contained ES module ---
const pdfLibSrc = readFileSync(join(nm, 'pdf-lib/dist/pdf-lib.esm.min.js'), 'utf8');
if (/(^|[;}\s])import[\s{*"']/.test(pdfLibSrc.slice(0, 2000)) || !/export\{[^}]*\bPDFDocument\b/.test(pdfLibSrc)) {
  throw new Error('vendor: pdf-lib.esm.min.js is not the expected self-contained ES module with a PDFDocument export');
}
copy('pdf-lib/dist/pdf-lib.esm.min.js', 'pdf-lib.esm.min.js');
copy('pdf-lib/LICENSE.md', 'licenses/pdf-lib-LICENSE.md');

// --- @pdf-lib/fontkit (MIT) — wrap the self-contained UMD build as an ES module ---
const umd = readFileSync(join(nm, '@pdf-lib/fontkit/dist/fontkit.umd.min.js'), 'utf8');
if (/[=(,;:!&|?]require\(/.test(umd)) throw new Error('vendor: fontkit UMD build has external require() calls; wrapper is not valid');
writeFileSync(
  join(out, 'fontkit.esm.js'),
  `// Generated by scripts/vendor.js from @pdf-lib/fontkit@${version('@pdf-lib/fontkit')} dist/fontkit.umd.min.js (MIT).\n` +
    `// The UMD factory sees a CommonJS-style \`module\` and stores the API on module.exports.\n` +
    `const module = { exports: {} };\nconst exports = module.exports;\n` +
    umd +
    `\n;export default module.exports;\n`,
);
copied.push('@pdf-lib/fontkit/dist/fontkit.umd.min.js -> renderer/vendor/fontkit.esm.js (ES wrapper)');
const fkLicence = ['LICENSE', 'LICENSE.md', 'license'].map((f) => join(nm, '@pdf-lib/fontkit', f)).find(existsSync);
if (fkLicence) cpSync(fkLicence, join(out, 'licenses', '@pdf-lib-fontkit-LICENSE.txt'));

// --- MiniSearch (MIT) — dist/es/index.js is a self-contained ES module (advanced search index) ---
copy('minisearch/dist/es/index.js', 'minisearch.js');
copy('minisearch/LICENSE.txt', 'licenses/minisearch-LICENSE.txt');
// --- write-excel-file (MIT; bundles fflate, MIT) — File > Export to Excel. Its browser ES build imports
// many files plus the bare "fflate"; the UMD bundle is self-contained, so wrap it like fontkit.
const wef = readFileSync(join(nm, 'write-excel-file/bundle/write-excel-file.min.js'), 'utf8');
if (/[=(,;:!&|?]require\(/.test(wef)) throw new Error('vendor: write-excel-file bundle has external require() calls; wrapper is not valid');
writeFileSync(join(out, 'write-excel-file.esm.js'),
  `// Generated by scripts/vendor.js from write-excel-file@${version('write-excel-file')} bundle/write-excel-file.min.js (MIT).\n` +
    `const module = { exports: {} };\nconst exports = module.exports;\n` + wef.replace(/\n\/\/# sourceMappingURL=.*$/, '') + `\n;export default module.exports;\n`);
copied.push('write-excel-file/bundle/write-excel-file.min.js -> renderer/vendor/write-excel-file.esm.js (ES wrapper)');
copy('write-excel-file/LICENSE', 'licenses/write-excel-file-LICENSE.txt');
copy('fflate/LICENSE', 'licenses/fflate-LICENSE.txt');
// --- docx (MIT) — File > Export to Word, built-in engine (renderer/ui/docx-export.js). dist/index.mjs inlines its
// dependencies (jszip, pako, sax, xml, xml-js, nanoid, hash.js and Node polyfills) and imports nothing.
const docxSrc = readFileSync(join(nm, 'docx/dist/index.mjs'), 'utf8');
if (/^\s*import[\s{*"']/m.test(docxSrc) || !/\bPacker\b/.test(docxSrc)) throw new Error('vendor: docx dist/index.mjs is not the expected self-contained ES module');
copy('docx/dist/index.mjs', 'docx.mjs');
copy('docx/LICENSE', 'licenses/docx-LICENSE.txt');
// --- mammoth (BSD-2-Clause) — File > Create PDF from Office…, built-in engine: .docx -> HTML (renderer/ui/office-html.js).
// mammoth.browser.min.js is a browserify standalone bundle (its dependencies inlined, require() only internal):
// wrap it like fontkit so its UMD prelude stores the API on module.exports.
const mammothSrc = readFileSync(join(nm, 'mammoth/mammoth.browser.min.js'), 'utf8');
if (/^\s*import[\s{*"']/m.test(mammothSrc) || !/convertToHtml/.test(mammothSrc)) throw new Error('vendor: mammoth.browser.min.js is not the expected standalone bundle');
writeFileSync(join(out, 'mammoth.mjs'),
  `// Generated by scripts/vendor.js from mammoth@${version('mammoth')} mammoth.browser.min.js (BSD-2-Clause).\n` +
    `const module = { exports: {} };\nconst exports = module.exports;\n` + mammothSrc + `\n;export default module.exports;\n`);
copied.push('mammoth/mammoth.browser.min.js -> renderer/vendor/mammoth.mjs (ES wrapper)');
copy('mammoth/LICENSE', 'licenses/mammoth-LICENSE.txt');
// --- read-excel-file (MIT; bundles fflate and saxen, MIT) — File > Create PDF from Office…, built-in engine: .xlsx -> HTML.
// bundle/read-excel-file.min.js is a UMD build whose factory returns readXlsxFile(file) -> [{sheet, data}] (all sheets).
const rxSrc = readFileSync(join(nm, 'read-excel-file/bundle/read-excel-file.min.js'), 'utf8');
if (/[=(,;:!&|?]require\(/.test(rxSrc) || /^\s*import[\s{*"']/m.test(rxSrc)) throw new Error('vendor: read-excel-file bundle has external imports; wrapper is not valid');
writeFileSync(join(out, 'read-excel-file.mjs'),
  `// Generated by scripts/vendor.js from read-excel-file@${version('read-excel-file')} bundle/read-excel-file.min.js (MIT).\n` +
    `const module = { exports: {} };\nconst exports = module.exports;\n` + rxSrc.replace(/\n\/\/# sourceMappingURL=.*$/, '') + `\n;export default module.exports;\n`);
copied.push('read-excel-file/bundle/read-excel-file.min.js -> renderer/vendor/read-excel-file.mjs (ES wrapper)');
copy('read-excel-file/LICENSE', 'licenses/read-excel-file-LICENSE.txt');
// --- Handwriting fonts for typed signatures (SIL OFL 1.1), latin subset, regular weight ---
// Font names and families are listed in renderer/ui/signatures.js (SIG_FONTS) and styles.css.
const SIGNATURE_FONTS = ['dancing-script', 'great-vibes', 'caveat', 'sacramento'];
for (const f of SIGNATURE_FONTS) {
  copy(`@fontsource/${f}/files/${f}-latin-400-normal.woff2`, `fonts/${f}-latin-400-normal.woff2`);
  copy(`@fontsource/${f}/LICENSE`, `licenses/@fontsource-${f}-LICENSE.txt`);
}

// --- Substitute fonts for editing original text (SIL OFL 1.1), full TrueType (PDFium cannot load woff/woff2) ---
// Loaded lazily by renderer/pdfium/worker.js from the app's origin; the file list is textedit.js FONT_FILES.
for (const [file, src] of Object.entries(FONT_FILES)) copy(src, `fonts/edit/${file}`);
for (const pkg of new Set(Object.values(FONT_FILES).map((src) => src.split('/').slice(0, 2).join('/')))) {
  copy(`${pkg}/LICENSE_FONT`, `licenses/${pkg.replace('/', '-')}-LICENSE_FONT.txt`);
}

// --- @embedpdf/pdfium (MIT wrapper; PDFium BSD-3-Clause + Apache-2.0) — edit engine, loaded lazily ---
// Only the browser build and the wasm: the build has no imports, and its DEFAULT_PDFIUM_WASM_URL (a CDN)
// is never used — renderer/pdfium/client.js compiles the vendored wasm itself. Source maps are not copied.
copy('@embedpdf/pdfium/dist/index.browser.js', 'pdfium/index.browser.js');
copy('@embedpdf/pdfium/dist/pdfium.wasm', 'pdfium/pdfium.wasm');
copy('@embedpdf/pdfium/LICENSE', 'licenses/@embedpdf-pdfium-LICENSE.txt');
copy('@embedpdf/pdfium/LICENSE.pdfium', 'licenses/pdfium-LICENSE.txt');

// --- OCR: tesseract.js (Apache-2.0) + tesseract.js-core wasm + English traineddata — Tools > Recognize text (OCR) ---
// Only the LSTM-only SIMD core is copied (the app sets corePath to it; English uses the LSTM engine only), as the
// separate .js + .wasm pair rather than the base64 *.wasm.js builds. No source maps. Everything loads offline from
// the app's own origin: workerPath, corePath and langPath are set by renderer/ui/ocr.js.
copy('tesseract.js/dist/worker.min.js', 'tesseract/worker.min.js');
copy('tesseract.js/dist/tesseract.esm.min.js', 'tesseract/tesseract.esm.min.js');
copy('tesseract.js-core/tesseract-core-simd-lstm.js', 'tesseract/tesseract-core-simd-lstm.js');
copy('tesseract.js-core/tesseract-core-simd-lstm.wasm', 'tesseract/tesseract-core-simd-lstm.wasm');
copy('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'tessdata/eng.traineddata.gz');
copy('tesseract.js/LICENSE.md', 'licenses/tesseract.js-LICENSE.md');
copy('tesseract.js-core/LICENSE', 'licenses/tesseract.js-core-LICENSE.txt');

const count = (d) => readdirSync(d, { recursive: true }).length;
for (const line of copied) console.log(`vendor: ${line}`);
console.log(`vendor: done — pdfjs-dist@${version('pdfjs-dist')}, pdf-lib@${version('pdf-lib')}, @pdf-lib/fontkit@${version('@pdf-lib/fontkit')}, @embedpdf/pdfium@${version('@embedpdf/pdfium')}, tesseract.js@${version('tesseract.js')}, tesseract.js-core@${version('tesseract.js-core')}, docx@${version('docx')}, mammoth@${version('mammoth')}, read-excel-file@${version('read-excel-file')}; ${count(out)} entries in renderer/vendor`);
