import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
      'iconv-lite', 'buffer', 'ieee754', 'base64-arraybuffer']) {
      assert.match(md, new RegExp(`^## ${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}.*\\(bundled\\)$`, 'm'), `no section for ${name}`);
    }
    // Licence texts come from the files, not just the identifiers.
    assert.match(md, /Copyright 1990-2009 Adobe Systems Incorporated/);
    assert.match(md, /Copyright 2014 PDFium Authors/);
    assert.match(md, /2-clauses[\s*]+BSD License/);
    assert.match(md, /Copyright \(C\) 2009-2024 Mozilla Corporation/);
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
