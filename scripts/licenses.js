#!/usr/bin/env node
// Writes THIRD-PARTY-NOTICES.md for every production dependency (the package.json
// "dependencies" tree, followed recursively through node_modules) and exits 1 if any of
// them is not under an allow-listed licence (GPL/AGPL/LGPL/MPL/unknown stop the build).
// It also lists the BUNDLED components below, which ship inside those packages' files (pdf.js
// data and wasm decoders copied by scripts/vendor.js, libraries inlined in fontkit's build, PDFium and
// the libraries compiled into @embedpdf/pdfium's wasm),
// with licence texts read from disk; a missing licence file fails the script.
//
// Usage: node scripts/licenses.js [--root <project dir>] [--out <file>]
//   --root defaults to the repository; --out defaults to <root>/THIRD-PARTY-NOTICES.md.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ALLOWED = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'OFL-1.1', 'Unlicense', 'CC0-1.0', 'BlueOak-1.0.0',
  // Zlib: permissive (OSI-approved). Added for pako ("MIT AND Zlib"), which pdf-lib bundles.
  'Zlib',
  // Permissive notice-only licences of libraries compiled into PDFium's wasm (@embedpdf/pdfium):
  // libpng-2.0 (PNG Reference Library v2), FTL (FreeType Project License), IJG (libjpeg).
  'libpng-2.0', 'FTL', 'IJG']);

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const root = resolve(opt('--root') ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const outFile = resolve(opt('--out') ?? join(root, 'THIRD-PARTY-NOTICES.md'));

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

// Node resolution: look in <from>/node_modules, then each parent's node_modules up to root.
function findPackage(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dir === root || dirname(dir) === dir) return null;
    dir = dirname(dir);
  }
}

function licenceId(pkg) {
  let l = pkg.license ?? pkg.licenses;
  if (Array.isArray(l)) l = l.map((x) => (typeof x === 'string' ? x : x?.type)).join(' OR ');
  else if (l && typeof l === 'object') l = l.type;
  return typeof l === 'string' && l.trim() ? l.trim() : 'UNKNOWN';
}

// "(MIT OR GPL-3.0)" is acceptable if one alternative is allowed; "A AND B" needs both.
function isAllowed(expr) {
  const e = expr.replace(/[()]/g, ' ').trim();
  if (/\sOR\s/.test(e)) return e.split(/\s+OR\s+/).some(isAllowed);
  if (/\sAND\s/.test(e)) return e.split(/\s+AND\s+/).every(isAllowed);
  return ALLOWED.has(e);
}

function licenceText(dir) {
  const file = readdirSync(dir).find((f) => /^(licen[sc]e|copying)(\..*)?$/i.test(f));
  return file ? { file, text: readFileSync(join(dir, file), 'utf8').trim() } : null;
}

const rootPkg = readJson(join(root, 'package.json'));
const seen = new Map(); // dir -> record
const queue = Object.keys(rootPkg.dependencies ?? {}).map((name) => ({ name, from: root, via: rootPkg.name }));
const missing = [];
while (queue.length) {
  const { name, from, via } = queue.shift();
  const dir = findPackage(name, from);
  if (!dir) { missing.push(`${name} (required by ${via})`); continue; }
  if (seen.has(dir)) continue;
  const pkg = readJson(join(dir, 'package.json'));
  const id = licenceId(pkg);
  seen.set(dir, { name: pkg.name ?? name, version: pkg.version ?? '?', licence: id, allowed: isAllowed(id), lic: licenceText(dir), repo: pkg.repository?.url ?? pkg.repository ?? pkg.homepage ?? '' });
  for (const dep of Object.keys(pkg.dependencies ?? {})) queue.push({ name: dep, from: dir, via: pkg.name });
}

// Components shipped in the build that are not separate npm dependencies. `files` are relative to
// the project root. pdf.js assets: the files scripts/vendor.js copies into renderer/vendor/pdfjs/
// (Liberation fonts and quickjs are not copied). fontkit: dist/fontkit.umd.min.js (vendored as
// renderer/vendor/fontkit.esm.js) inlines these libraries (identified from the bundle's module
// names, code and comments); fontkit 1.1.1 lists them as devDependencies, so their licence files
// were taken from the npm releases matching those ranges and kept in scripts/third-party-licenses/.
const PJ = 'node_modules/pdfjs-dist', TPL = 'scripts/third-party-licenses';
const PDFIUM = 'compiled into @embedpdf/pdfium dist/pdfium.wasm -> renderer/vendor/pdfium/pdfium.wasm';
const FK = 'inlined in @pdf-lib/fontkit dist/fontkit.umd.min.js (renderer/vendor/fontkit.esm.js)';
const BUNDLED = [
  { name: 'Adobe CMaps', licence: 'BSD-3-Clause', where: 'pdfjs-dist cmaps/ -> renderer/vendor/pdfjs/cmaps/', files: [`${PJ}/cmaps/LICENSE`] },
  { name: 'Foxit standard fonts (PDFium)', licence: 'BSD-3-Clause', where: 'pdfjs-dist standard_fonts/Foxit*.pfb -> renderer/vendor/pdfjs/standard_fonts/', files: [`${PJ}/standard_fonts/LICENSE_FOXIT`] },
  { name: 'OpenJPEG (JPEG 2000 decoder)', licence: 'BSD-2-Clause', where: 'pdfjs-dist wasm/openjpeg.wasm, openjpeg_nowasm_fallback.js -> renderer/vendor/pdfjs/wasm/', files: [`${PJ}/wasm/LICENSE_OPENJPEG`, `${PJ}/wasm/LICENSE_PDFJS_OPENJPEG`] },
  { name: 'PDFium JBIG2 decoder', licence: 'BSD-3-Clause AND Apache-2.0', where: 'pdfjs-dist wasm/jbig2.wasm, jbig2_nowasm_fallback.js -> renderer/vendor/pdfjs/wasm/', files: [`${PJ}/wasm/LICENSE_JBIG2`, `${PJ}/wasm/LICENSE_PDFJS_JBIG2`] },
  { name: 'qcms (colour management)', licence: 'MIT', where: 'pdfjs-dist wasm/qcms_bg.wasm -> renderer/vendor/pdfjs/wasm/', files: [`${PJ}/wasm/LICENSE_QCMS`, `${PJ}/wasm/LICENSE_PDFJS_QCMS`] },
  { name: 'CGATS001Compat ICC profile', licence: 'CC0-1.0', where: 'pdfjs-dist iccs/ -> renderer/vendor/pdfjs/iccs/', files: [`${PJ}/iccs/LICENSE`] },
  ...[
    ['@pdf-lib/restructure', '0.0.1', 'MIT', null],
    ['@pdf-lib/unicode-properties', '0.0.1', 'MIT'],
    ['@pdf-lib/brotli', '0.0.0', 'MIT', null, 'Its brotli decoder sources carry "Copyright 2013 Google Inc." Apache-2.0 headers, kept in the bundle.'],
    ['unicode-trie', '0.3.1', 'MIT', null],
    ['tiny-inflate', '1.0.3', 'MIT'],
    ['dfa', '1.2.0', 'MIT', null],
    ['clone', '1.0.4', 'MIT'],
    ['deep-equal', '1.1.2', 'MIT'],
    ['base64-arraybuffer', '0.1.5', 'MIT'],
    ['iconv-lite', '0.4.24', 'MIT'],
    ['safer-buffer', '2.1.2', 'MIT'],
    ['buffer', '5.7.1', 'MIT'],
    ['base64-js', '1.5.1', 'MIT'],
    ['ieee754', '1.2.1', 'BSD-3-Clause'],
    ['string_decoder', '1.3.0', 'MIT'],
    ['inherits', '2.0.4', 'ISC'],
  ].map(([name, version, licence, file, note]) => ({
    name, version, licence, where: FK, note,
    files: file === null ? [] : [`${TPL}/${name.replace('@', '').replace('/', '-')}-${version}-LICENSE.txt`],
  })),
  // PDFium edit engine: @embedpdf/pdfium dist/pdfium.wasm (vendored by scripts/vendor.js). The npm package's
  // own LICENSE (MIT) covers only the JS wrapper; PDFium's notice ships beside it as LICENSE.pdfium, and the
  // third-party libraries below are statically compiled into the wasm. They were identified from strings
  // in the wasm (library error messages, FreeType module names, version strings); the build has no symbol
  // names. Upstream licence texts were fetched in 2026-10 and kept in scripts/third-party-licenses/.
  // A version is given only where the wasm contains it; otherwise "version unconfirmed".
  { name: 'PDFium', version: 'version unconfirmed', licence: 'BSD-3-Clause AND Apache-2.0', where: PDFIUM,
    note: 'Includes the Foxit/PDFium standard Type 1 fonts and Chrome Sans/Serif MM fonts compiled into the wasm.',
    files: ['node_modules/@embedpdf/pdfium/LICENSE.pdfium'] },
  { name: 'libpng', version: '1.6.43', licence: 'libpng-2.0', where: PDFIUM,
    note: 'Version from the string "1.6.43" in the wasm (libpng\'s version check). Text from libpng v1.6.43 (github.com/pnggroup/libpng, tag v1.6.43, LICENSE).',
    files: [`${TPL}/libpng-1.6.43-LICENSE.txt`] },
  { name: 'zlib', version: 'version unconfirmed', licence: 'Zlib', where: PDFIUM,
    note: 'The wasm contains the string "1.3.1", consistent with zlib 1.3.1 (Chromium\'s zlib), but not tied to zlib by a symbol. Text from github.com/madler/zlib tag v1.3.1, LICENSE.',
    files: [`${TPL}/zlib-LICENSE.txt`] },
  { name: 'FreeType', version: 'version unconfirmed', licence: 'FTL OR GPL-2.0-only', where: PDFIUM,
    note: 'Used under the FreeType Project License (FTL), one of its two alternatives. Portions of this software are copyright (c) The FreeType Project (www.freetype.org). All rights reserved. Texts from github.com/freetype/freetype (master): LICENSE.TXT, docs/FTL.TXT.',
    files: [`${TPL}/freetype-LICENSE.txt`, `${TPL}/freetype-FTL.txt`] },
  { name: 'OpenJPEG (in PDFium)', version: 'version unconfirmed', licence: 'BSD-2-Clause', where: PDFIUM,
    note: 'Text from github.com/uclouvain/openjpeg (master), LICENSE.',
    files: [`${TPL}/openjpeg-LICENSE.txt`] },
  { name: 'libjpeg-turbo (JPEG decoder)', version: 'version unconfirmed', licence: 'IJG AND BSD-3-Clause AND Zlib', where: PDFIUM,
    note: 'PDFium decodes DCT (JPEG) images with libjpeg-turbo. This software is based in part on the work of the Independent JPEG Group. The wasm has no libjpeg message strings, so the library is identified from PDFium\'s DCT codec (built on libjpeg-turbo), not by a string. Texts from github.com/libjpeg-turbo/libjpeg-turbo (main): LICENSE.md, README.ijg.',
    files: [`${TPL}/libjpeg-turbo-LICENSE.md`, `${TPL}/libjpeg-turbo-README.ijg`] },
  { name: 'Little CMS (lcms2)', version: 'version unconfirmed', licence: 'MIT', where: PDFIUM,
    note: 'Colour management; identified by its error messages in the wasm. Text from github.com/mm2/Little-CMS (master), LICENSE.',
    files: [`${TPL}/lcms2-LICENSE.txt`] },
].map((b) => ({ ...b, allowed: isAllowed(b.licence) }));
for (const b of BUNDLED) {
  b.texts = b.files.map((f) => ({ file: f, text: existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8').trim() : null }));
  for (const t of b.texts) if (t.text == null) missing.push(`licence file ${t.file} (for ${b.name})`);
}

const records = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const lines = [
  '# Third-party notices',
  '',
  `ASH PDF Studio ${rootPkg.version} includes the open-source packages below. This file is generated by`,
  '`npm run licenses` (scripts/licenses.js) from the production dependency tree; do not edit it by hand.',
  '',
  '**Electron and Chromium.** The Windows builds also contain the Electron runtime (MIT, Copyright (c)',
  'Electron contributors and GitHub Inc.) and Chromium, which bundles many third-party components under',
  'their own licences. Their full notices ship next to the executable as `LICENSE.electron.txt` and',
  '`LICENSES.chromium.html` (added by electron-builder from the Electron distribution).',
  '',
  '| Package | Version | Licence |',
  '| --- | --- | --- |',
  ...records.map((r) => `| ${r.name} | ${r.version} | ${r.licence} |`),
  '',
  '**Bundled components.** These ship inside the packages above (pdf.js data files and WebAssembly',
  'decoders, libraries compiled into the fontkit build, and PDFium with the libraries compiled into',
  '@embedpdf/pdfium\'s WebAssembly build) and are listed with their own licences. "version unconfirmed" means the',
  'version could not be read from the shipped binary.',
  '',
  '| Component | Version | Licence | Shipped as |',
  '| --- | --- | --- | --- |',
  ...BUNDLED.map((b) => `| ${b.name} | ${b.version ?? '-'} | ${b.licence} | ${b.where} |`),
  '',
];
for (const r of records) {
  lines.push(`## ${r.name} ${r.version}`, '', `Licence: ${r.licence}${r.repo ? `  \nSource: ${String(r.repo).replace(/^git\+/, '')}` : ''}`, '');
  if (r.lic) lines.push(`From \`${r.lic.file}\`:`, '', '```text', r.lic.text, '```', '');
  else lines.push(`The package does not ship a licence file; its package.json declares \`${r.licence}\`. The standard text of that licence applies.`, '');
}
for (const b of BUNDLED) {
  lines.push(`## ${b.name}${b.version ? ` ${b.version}` : ''} (bundled)`, '', `Licence: ${b.licence}  \nShipped as: ${b.where}`, '');
  if (b.note) lines.push(b.note, '');
  for (const t of b.texts) lines.push(`From \`${t.file}\`:`, '', '```text', t.text ?? '(missing)', '```', '');
  if (!b.texts.length) lines.push(`The upstream release ships no licence file; its package.json and README declare \`${b.licence}\`. The standard text of that licence applies.`, '');
}
writeFileSync(outFile, lines.join('\n'));

const bad = [...records, ...BUNDLED].filter((r) => !r.allowed);
console.log(`licenses: ${records.length} production packages, ${BUNDLED.length} bundled components -> ${outFile}`);
for (const r of [...records, ...BUNDLED]) console.log(`  ${r.allowed ? 'ok ' : 'BAD'} ${r.name}${r.version ? `@${r.version}` : ''} ${r.licence}`);
if (missing.length) console.error(`licenses: missing: ${missing.join(', ')} — run npm ci`);
if (bad.length || missing.length) {
  if (bad.length) console.error(`licenses: FAIL — not in allow-list [${[...ALLOWED].join(', ')}]: ${bad.map((r) => `${r.name}@${r.version ?? '-'} (${r.licence})`).join(', ')}`);
  process.exit(1);
}
