#!/usr/bin/env node
// Runs the REAL Electron app (electron binary + a display, e.g. xvfb-run, as a non-root user) and opens a PDF
// passed on the command line, then checks the main process's capability checks through window.api.
// env: ELECTRON_BIN (optional; defaults to the installed electron package).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const electronBin = process.env.ELECTRON_BIN || createRequire(import.meta.url)('electron');
const tmp = await mkdtemp(join(tmpdir(), 'ash-pdf-e2e-'));
const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
for (let n = 1; n <= 3; n++) doc.addPage([612, 792]).drawText(`Electron page ${n}`, { x: 72, y: 700, size: 28, font });
const pdfBytes = await doc.save();
const pdfPath = join(tmp, 'sample.pdf');
await writeFile(pdfPath, pdfBytes);

// Folder fixtures: grant <tmp>/x/a; <tmp>/x/ab shares the prefix but is outside it.
const a = join(tmp, 'x', 'a'), ab = join(tmp, 'x', 'ab'), big = join(tmp, 'big');
await mkdir(join(a, 'sub'), { recursive: true });
await mkdir(ab, { recursive: true });
await mkdir(big, { recursive: true });
await writeFile(join(a, 'doc.pdf'), pdfBytes);
await writeFile(join(a, 'sub', 'inner.PDF'), pdfBytes);
await writeFile(join(a, 'note.txt'), 'secret');
await writeFile(join(ab, 'f.pdf'), pdfBytes);
await symlink(join(ab, 'f.pdf'), join(a, 'link.pdf'));       // inside the folder, pointing outside
await symlink(join(a, 'note.txt'), join(a, 'note-alias.pdf')); // .pdf name, real file is .txt
execFileSync('mkfifo', [join(a, 'pipe.pdf')]);
for (let i = 0; i < 60; i++) await writeFile(join(big, `f${i}.txt`), '');
const TEST_BUDGET = 50; // entries visited per listing; big/ has 60
// Portable mode keeps userData (settings, library) inside tmp. ASH_TEST_FAKE_SAFESTORAGE swaps the OS
// keyring (absent here) for a reversible test cipher, so the at-rest encryption path runs.
const dataDir = join(tmp, 'ASH-PDF-Studio-data');
const libDir = (kind) => join(dataDir, 'library', kind);
await mkdir(libDir('signature'), { recursive: true });
await mkdir(libDir('stamp'), { recursive: true });
await writeFile(join(libDir('signature'), 'orphan.bin'), 'x');
const old = new Date(Date.now() - 5 * 60_000);
await utimes(join(libDir('signature'), 'orphan.bin'), old, old);
await writeFile(join(libDir('signature'), 'fresh.bin'), 'x'); // young orphan: a put may be in progress
for (let i = 0; i < 500; i++) {
  await writeFile(join(libDir('stamp'), `s${i}.json`), '{}');
  await writeFile(join(libDir('stamp'), `s${i}.bin`), 'x');
}

let step = 'launch';
const app = await electron.launch({
  executablePath: electronBin, args: ['--disable-gpu', root, pdfPath], cwd: root,
  env: { ...process.env, PORTABLE_EXECUTABLE_DIR: tmp, ASH_SEARCH_MAX_ENTRIES: String(TEST_BUDGET), ASH_TEST_FAKE_SAFESTORAGE: '1' },
});
try {
  const problems = [];
  const win = await app.firstWindow();
  win.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  win.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  step = 'opens the PDF given on the command line';
  await win.waitForFunction(() => window.ashStudio?.state.tabs.some((t) => t.name === 'sample.pdf' && t.view), null, { timeout: 30000 });
  step = 'page 1 renders';
  await win.waitForFunction(() => {
    const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId);
    return t?.view?.pageEls[0]?.classList.contains('rendered');
  }, null, { timeout: 30000 });
  const pages = await win.locator('.viewer-scroll:not([hidden]) .page').count();
  if (pages !== 3) throw new Error(`expected 3 pages, saw ${pages}`);
  if (process.env.E2E_SHOTS) await win.screenshot({ path: join(process.env.E2E_SHOTS, 'electron_pdf.png') });

  // window.api call in the page: 'ok:<summary>' or 'rejected:<message>'.
  const call = (fn, ...args) => win.evaluate(async ([fn, args]) => {
    try {
      const r = await Promise.race([window.api[fn](...args), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 5000))]);
      return 'ok:' + JSON.stringify(r instanceof Uint8Array ? { bytes: r.length } : r);
    } catch (e) { return 'rejected:' + e.message; }
  }, [fn, args]);
  const expect = (what, got, ok) => { if (!ok) throw new Error(`${what}: got ${got}`); };
  const grantFolder = async (dir) => {
    await app.evaluate(({ dialog }, d) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [d] }); }, dir);
    const r = await call('openFolder');
    expect('openFolder', r, r === `ok:${JSON.stringify({ path: dir })}`);
  };

  step = 'folder grant: PDFs only, inside the folder only';
  await grantFolder(a);
  let r = await call('readFile', join(a, 'doc.pdf'));
  expect('read PDF in granted folder', r, r === `ok:${JSON.stringify({ bytes: pdfBytes.length })}`);
  r = await call('readFile', join(a, 'sub', 'inner.PDF'));
  expect('read .PDF (upper case) in a subfolder', r, r.startsWith('ok:'));
  r = await call('readFile', join(ab, 'f.pdf'));
  expect('read sibling folder sharing the prefix', r, r.startsWith('rejected:'));
  r = await call('readFile', join(a, 'note.txt'));
  expect('read .txt in granted folder', r, r.startsWith('rejected:'));
  r = await call('readFile', join(a, 'note-alias.pdf'));
  expect('read .pdf symlink to a .txt', r, r.startsWith('rejected:'));
  r = await call('readFile', join(a, 'link.pdf'));
  expect('read symlink pointing outside', r, r.startsWith('rejected:'));
  r = await call('readFile', join(a, 'pipe.pdf'));
  expect('read FIFO named .pdf (must not hang)', r, r.startsWith('rejected:') && !r.includes('timeout'));

  step = 'listPdfs';
  r = await call('listPdfs', a, { recursive: true });
  const listed = JSON.parse(r.slice(3));
  const names = listed.files.map((f) => f.name).sort().join(',');
  expect('listPdfs names', r, names === 'doc.pdf,inner.PDF' && listed.truncated === false);
  await grantFolder(big);
  r = await call('listPdfs', big, { recursive: true });
  expect('listPdfs over the entry budget', r, r.startsWith('ok:') && JSON.parse(r.slice(3)).truncated === true);
  r = await call('cancelSearch');
  expect('cancelSearch', r, r === 'ok:true');

  step = 'library ids and limits';
  for (const id of ['../x', 'CON', 'nul', 'Com1', 'LPT9']) {
    r = await call('libraryPut', 'signature', id, { meta: {}, bytes: new Uint8Array([1]) });
    expect(`libraryPut id ${id}`, r, r.startsWith('rejected:'));
  }
  r = await call('libraryPut', 'signature', 'CONSOLE', { meta: {}, bytes: new Uint8Array([1]) });
  expect('libraryPut id CONSOLE', r, r === 'ok:true');
  r = await call('libraryList', 'signature');
  expect('libraryList', r, r === `ok:${JSON.stringify([{ id: 'CONSOLE', meta: {} }])}`);
  expect('stale orphan .bin removed', 'present', !existsSync(join(libDir('signature'), 'orphan.bin')));
  expect('young orphan .bin kept', 'missing', existsSync(join(libDir('signature'), 'fresh.bin')));
  r = await call('libraryPut', 'stamp', 'one-more', { meta: {}, bytes: new Uint8Array([1]) });
  expect('libraryPut past 500 items', r, r.startsWith('rejected:'));
  r = await call('libraryPut', 'stamp', 's0', { meta: { v: 2 } });
  expect('libraryPut updates an existing item when full', r, r === 'ok:true');

  step = 'library: encrypted at rest';
  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const png = [...PNG_SIG, ...Array.from({ length: 200 }, (_, i) => (i * 37) & 255)];
  const onDisk = (id) => readFileSync(join(libDir('signature'), `${id}.bin`));
  const sealed = (buf) => buf.subarray(0, 4).toString('latin1') === 'ASE1' && !buf.includes(PNG_SIG);
  // window.api.libraryGet in the page, bytes as a plain array.
  const get = (id) => win.evaluate(async (id) => {
    const r = await window.api.libraryGet('signature', id);
    return r && { ...r, bytes: r.bytes && Array.from(r.bytes) };
  }, id);
  r = await win.evaluate((b) => window.api.libraryPut('signature', 'sealed', { meta: { name: 'Sealed' }, bytes: new Uint8Array(b) }), png);
  expect('libraryPut sealed', r, r === true);
  expect('no PNG bytes on disk after put', onDisk('sealed').subarray(0, 12).toString('hex'), sealed(onDisk('sealed')));
  let got = await get('sealed');
  expect('libraryGet returns the original bytes', JSON.stringify(got), got.encrypted === true && JSON.stringify(got.bytes) === JSON.stringify(png));

  step = 'library: plain legacy item re-encrypted on first read';
  await writeFile(join(libDir('signature'), 'legacy.json'), JSON.stringify({ name: 'Old' }));
  await writeFile(join(libDir('signature'), 'legacy.bin'), Buffer.from(png));
  got = await get('legacy');
  expect('legacy item read', JSON.stringify(got), got.encrypted === true && JSON.stringify(got.bytes) === JSON.stringify(png));
  expect('legacy .bin rewritten encrypted', onDisk('legacy').subarray(0, 12).toString('hex'), sealed(onDisk('legacy')));
  got = await get('legacy');
  expect('legacy item read again', JSON.stringify(got), JSON.stringify(got.bytes) === JSON.stringify(png));

  step = 'library: undecryptable item is unavailable, not an error';
  await writeFile(join(libDir('signature'), 'broken.json'), JSON.stringify({ name: 'Moved' }));
  await writeFile(join(libDir('signature'), 'broken.bin'), Buffer.concat([Buffer.from('ASE1'), Buffer.from('junk from another computer')]));
  r = await call('libraryGet', 'signature', 'broken');
  expect('libraryGet undecryptable', r, r === `ok:${JSON.stringify({ id: 'broken', meta: { name: 'Moved' }, bytes: null, encrypted: true, unavailable: true })}`);
  step = 'library: manager lists the unavailable item';
  await win.click('.menu-btn:text-is("Tools")');
  await win.click('.menu-item[data-id="signature-manage"]');
  const badge = await win.textContent('.sigman-item[data-id="broken"] .sigman-unavailable', { timeout: 10000 });
  expect('unavailable badge', badge, badge === 'Unavailable on this computer — re-create it');
  const note = await win.textContent('.sigman-wrap .sigman-protect');
  expect('manager note', note, note.startsWith('Saved signatures are protected by your Windows account; add a password for extra protection.'));
  await win.keyboard.press('Escape');
  await win.waitForSelector('.sigman-wrap', { state: 'detached', timeout: 5000 });

  step = 'settings keys';
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    r = await call('settingsSet', key, { polluted: true });
    expect(`settingsSet ${key}`, r, r.startsWith('rejected:'));
    r = await call('settingsGet', key);
    expect(`settingsGet ${key}`, r, r.startsWith('rejected:'));
  }
  r = await call('settingsSet', 'plain', 1);
  expect('settingsSet plain', r, r === 'ok:true');
  r = await call('settingsGet', 'plain');
  expect('settingsGet plain', r, r === 'ok:1');

  step = 'pdfium: app:// serves the wasm as application/wasm';
  const wasm = await win.evaluate(async () => {
    const res = await fetch(new URL('vendor/pdfium/pdfium.wasm', location.href));
    const head = new Uint8Array(await res.arrayBuffer(), 0, 4);
    return { status: res.status, type: res.headers.get('content-type'), magic: Array.from(head).join(',') };
  });
  expect('pdfium.wasm response', JSON.stringify(wasm), wasm.status === 200 && wasm.type === 'application/wasm' && wasm.magic === '0,97,115,109');
  step = 'pdfium: selfTest in the worker under the app CSP';
  const st = await win.evaluate(() => window.ashStudio.pdfium.selfTest().catch((e) => ({ error: `${e.name}: ${e.message}` })));
  expect('pdfium selfTest', JSON.stringify({ ...st, objects: undefined }),
    !st.error && st.pageCount === 2 && st.text === 'PDFium self-test 4711' && st.originalIsPrefix && st.outLength > st.inLength);

  step = 'office (fake runner): File > Export to Word document';
  const out = join(tmp, 'out dir; & "x"', 'Résumé & co.docx');
  await mkdir(dirname(out), { recursive: true });
  await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, out);
  const menuClick = async (id) => { await win.click('.menu-btn:text-is("File")'); await win.click(`.menu-item[data-id="${id}"]`); };
  await menuClick('export-docx');
  await win.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /Saved R.sum. & co\.docx/.test(t.textContent)), null, { timeout: 15000 });
  const calls = await app.evaluate(() => globalThis.__ashOfficeCalls.map(({ command, args }) => ({ command, args })));
  const c = calls[0];
  expect('Word runner call', JSON.stringify(calls), calls.length === 1 && c.command === 'powershell.exe'
    && c.args.slice(0, 5).join(' ') === '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File' && c.args[5].endsWith('pdf-to-docx.ps1')
    && c.args[6].endsWith('document.pdf') && c.args[7] === out && c.args.length === 8);
  expect('docx written', '', (await readFile(out, 'utf8')) === 'ASH fake Office output');
  step = 'office (fake runner): Microsoft Word missing -> clear error';
  await app.evaluate(() => { process.env.ASH_TEST_FAKE_OFFICE = 'missing'; });
  await menuClick('export-docx');
  await win.waitForFunction(() => /Microsoft Word is not installed/.test(document.querySelector('dialog[open], .dialog')?.textContent ?? ''), null, { timeout: 15000 });
  await win.keyboard.press('Escape');
  await app.evaluate(() => { process.env.ASH_TEST_FAKE_OFFICE = '1'; });

  step = 'no renderer errors';
  if (problems.length) throw new Error(problems.join('\n'));
  console.log('pdf electron e2e: OK');
} catch (err) {
  console.error(`pdf electron e2e FAILED at step "${step}":`, err.message);
  process.exitCode = 1;
} finally {
  await app.close();
  await rm(tmp, { recursive: true, force: true });
}
