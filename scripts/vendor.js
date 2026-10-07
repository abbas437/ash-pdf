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
//   renderer/vendor/fonts/<font>-latin-400-normal.woff2  @fontsource/* handwriting fonts (SIL OFL 1.1) for typed signatures
//   renderer/vendor/pdfium/index.browser.js @embedpdf/pdfium dist/index.browser.js (PDFium wasm glue, MIT) -> renderer/pdfium/worker.js
//   renderer/vendor/pdfium/pdfium.wasm      @embedpdf/pdfium dist/pdfium.wasm (PDFium, BSD-3-Clause/Apache-2.0) -> renderer/pdfium/client.js
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
// --- Handwriting fonts for typed signatures (SIL OFL 1.1), latin subset, regular weight ---
// Font names and families are listed in renderer/ui/signatures.js (SIG_FONTS) and styles.css.
const SIGNATURE_FONTS = ['dancing-script', 'great-vibes', 'caveat', 'sacramento'];
for (const f of SIGNATURE_FONTS) {
  copy(`@fontsource/${f}/files/${f}-latin-400-normal.woff2`, `fonts/${f}-latin-400-normal.woff2`);
  copy(`@fontsource/${f}/LICENSE`, `licenses/@fontsource-${f}-LICENSE.txt`);
}

// --- @embedpdf/pdfium (MIT wrapper; PDFium BSD-3-Clause + Apache-2.0) — edit engine, loaded lazily ---
// Only the browser build and the wasm: the build has no imports, and its DEFAULT_PDFIUM_WASM_URL (a CDN)
// is never used — renderer/pdfium/client.js compiles the vendored wasm itself. Source maps are not copied.
copy('@embedpdf/pdfium/dist/index.browser.js', 'pdfium/index.browser.js');
copy('@embedpdf/pdfium/dist/pdfium.wasm', 'pdfium/pdfium.wasm');
copy('@embedpdf/pdfium/LICENSE', 'licenses/@embedpdf-pdfium-LICENSE.txt');
copy('@embedpdf/pdfium/LICENSE.pdfium', 'licenses/pdfium-LICENSE.txt');

const count = (d) => readdirSync(d, { recursive: true }).length;
for (const line of copied) console.log(`vendor: ${line}`);
console.log(`vendor: done — pdfjs-dist@${version('pdfjs-dist')}, pdf-lib@${version('pdf-lib')}, @pdf-lib/fontkit@${version('@pdf-lib/fontkit')}, @embedpdf/pdfium@${version('@embedpdf/pdfium')}; ${count(out)} entries in renderer/vendor`);
