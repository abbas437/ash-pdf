import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const script = join(root, 'scripts', 'licenses.js');
const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('notices list the components bundled in the build with their licence texts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ash-licenses-'));
  try {
    const out = join(dir, 'NOTICES.md');
    const r = run(['--out', out]);
    assert.equal(r.status, 0, r.stderr);
    const md = readFileSync(out, 'utf8');
    for (const name of ['Adobe CMaps', 'Foxit standard fonts', 'OpenJPEG', 'PDFium JBIG2', 'qcms', 'CGATS001Compat ICC profile',
      '@pdf-lib/restructure', '@pdf-lib/unicode-properties', '@pdf-lib/brotli', 'unicode-trie', 'tiny-inflate', 'dfa',
      'iconv-lite', 'buffer', 'ieee754', 'base64-arraybuffer',
      'PDFium', 'libpng 1.6.43', 'zlib', 'FreeType', 'OpenJPEG (in PDFium)', 'libjpeg-turbo (JPEG decoder)', 'Little CMS (lcms2)',
      'Tesseract OCR', 'Leptonica', 'libpng (in Tesseract) 1.6.38', 'zlib (in Tesseract)', 'IJG libjpeg (in Tesseract)', 'LibTIFF', 'libwebp',
      'Tesseract English traineddata (eng) 4.0.0_best_int', 'Carlito font', 'Caladea font', 'Arimo font', 'Tinos font', 'Cousine font']) {
      assert.match(md, new RegExp(`^## ${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}.*\\(bundled\\)$`, 'm'), `no section for ${name}`);
    }
    // Licence texts come from the files, not just the identifiers.
    assert.match(md, /Copyright 1990-2009 Adobe Systems Incorporated/);
    assert.match(md, /Copyright 2014 PDFium Authors/);
    assert.match(md, /2-clauses[\s*]+BSD License/);
    assert.match(md, /Copyright \(C\) 2009-2024 Mozilla Corporation/);
    // PDFium and the libraries compiled into its wasm, with their upstream texts.
    assert.match(md, /^\| @embedpdf\/pdfium \| 2\.15\.1 \| MIT \|$/m);
    assert.match(md, /Apache License\s+Version 2\.0, January 2004/);
    assert.match(md, /PNG Reference Library License version 2/);
    assert.match(md, /Jean-loup Gailly and Mark Adler/);
    assert.match(md, /The FreeType Project LICENSE/);
    assert.match(md, /Independent JPEG Group/);
    assert.match(md, /Marti Maria Saguer/);
    // OCR: tesseract.js and its core wasm (Apache-2.0), with the libraries compiled into the wasm.
    assert.match(md, /^\| tesseract\.js \| 7\.0\.0 \| Apache-2\.0 \|$/m);
    assert.match(md, /^\| tesseract\.js-core \| 7\.0\.0 \| Apache-2\.0 \|$/m);
    assert.match(md, /Copyright \(C\) 2001-2020 Leptonica/);
    assert.match(md, /Copyright © 1988-1997 Sam Leffler/);
    assert.match(md, /Copyright \(c\) 2010, Google Inc\. All rights reserved\./);
    // Substitute fonts for text editing: the OFL text from LICENSE_FONT, not only the packages' MIT LICENSE.
    assert.match(md, /Copyright 2013 The Carlito Project Authors/);
    assert.match(md, /^\| @expo-google-fonts\/carlito \| 0\.4\.1 \| MIT AND OFL-1\.1 \|$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the script fails when a bundled component licence file is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ash-licenses-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', dependencies: {} }));
    const r = run(['--root', dir, '--out', join(dir, 'NOTICES.md')]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /licence file node_modules\/pdfjs-dist\/cmaps\/LICENSE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the script fails when PDFium\'s licence file (LICENSE.pdfium) is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ash-licenses-'));
  try {
    // A root whose files are all present except node_modules/@embedpdf/pdfium/LICENSE.pdfium.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', dependencies: {} }));
    mkdirSync(join(dir, 'node_modules', '@embedpdf', 'pdfium'), { recursive: true });
    symlinkSync(join(root, 'node_modules', 'pdfjs-dist'), join(dir, 'node_modules', 'pdfjs-dist'));
    symlinkSync(join(root, 'node_modules', '@expo-google-fonts'), join(dir, 'node_modules', '@expo-google-fonts'));
    symlinkSync(join(root, 'scripts'), join(dir, 'scripts'));
    const r = run(['--root', dir, '--out', join(dir, 'NOTICES.md')]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /missing: licence file node_modules\/@embedpdf\/pdfium\/LICENSE\.pdfium \(for PDFium\)( —|$)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
