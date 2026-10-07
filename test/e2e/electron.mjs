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

  step = 'print with unsaved text markup and note objects';
  // Stub the system print in the main process: record what the print container holds while the
  // renderer waits on api.print(), and print the same view to PDF (proves it renders printable pages).
  await app.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    globalThis.__printed = [];
    wc.print = (opts, done) => {
      (async () => {
        const imgs = await wc.executeJavaScript(`(async () => Promise.all([...document.querySelectorAll('.print-container img')].map(async (img) => {
          await img.decode();
          const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
          const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
          const s = img.naturalWidth / 612;
          return { w: img.naturalWidth, h: img.naturalHeight, mark: Array.from(ctx.getImageData(Math.round(350 * s), Math.round(407 * s), 1, 1).data) };
        })))()`);
        const pdf = await wc.printToPDF({ printBackground: true });
        globalThis.__printed.push({ opts, imgs, pdf: Buffer.from(pdf).toString('base64') });
        done(true, '');
      })().catch((e) => { globalThis.__printed.push({ error: e.message }); done(false, e.message); });
    };
  });
  await win.evaluate(() => {
    const t = window.ashStudio.state.tabs.find((x) => x.name === 'sample.pdf');
    t.objects = [...(t.objects ?? []),
      { id: 'pr-th', page: 0, type: 'textHighlight', quads: [[300, 400, 400, 400, 300, 414, 400, 414]], color: '#0000ff', opacity: 1 },
      { id: 'pr-note', page: 1, type: 'note', x: 300, y: 100, color: '#ffd400', note: 'Printed note' },
      { id: 'pr-u', page: 2, type: 'underline', quads: [[72, 80, 300, 80, 72, 94, 300, 94]], color: '#00a000' }];
  });
  await win.click('.menu-btn:text-is("File")');
  await win.click('.menu [data-id="print"]');
  await win.waitForSelector('.vx-print-dialog');
  await win.click('.vx-print-dialog .btn.primary');
  // Either the stubbed print runs, or the renderer shows its "Could not print" error dialog.
  let printed = null;
  for (let i = 0; i < 300 && !printed; i++) {
    const err = await win.evaluate(() => [...document.querySelectorAll('.dialog.error')].map((d) => d.textContent).join(' / '));
    if (err) throw new Error(`print failed in the renderer: ${err}`);
    printed = await app.evaluate(() => globalThis.__printed[0] ?? null);
    if (!printed) await new Promise((res) => setTimeout(res, 100));
  }
  expect('webContents.print called', JSON.stringify(printed), printed && !printed.error && printed.opts?.silent === false && printed.opts?.printBackground === true);
  expect('print container page images', JSON.stringify(printed.imgs.map(({ w, h }) => [w, h])),
    printed.imgs.length === 3 && printed.imgs.every(({ w, h }) => w === 1275 && h === 1650));
  const [mr, mg, mb] = printed.imgs[0].mark;
  expect('textHighlight burnt into the printed page', String(printed.imgs[0].mark), mr < 60 && mg < 60 && mb > 190);
  const printedPdf = await PDFDocument.load(Buffer.from(printed.pdf, 'base64'));
  expect('printToPDF page count', printedPdf.getPageCount(), printedPdf.getPageCount() === 3);
  await win.waitForSelector('.print-container', { state: 'detached', timeout: 10000 });
  const dialogs = await win.evaluate(() => [...document.querySelectorAll('.dialog')].map((d) => d.textContent).join(' / '));
  expect('no dialog after printing', dialogs, dialogs === '');

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

  step = 'copyText puts text on the system clipboard';
  r = await call('copyText', 'ASH copy 4711');
  expect('copyText', r, r === 'ok:true');
  const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
  expect('clipboard.readText', clip, clip === 'ASH copy 4711');
  r = await call('copyText', 42);
  expect('copyText non-string', r, r.startsWith('rejected:'));
  step = 'openExternal: only http(s)/mailto reach shell.openExternal';
  await app.evaluate(({ shell }) => { globalThis.__opened = []; shell.openExternal = async (u) => { globalThis.__opened.push(u); }; });
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'ms-settings:privacy']) {
    r = await call('openExternal', bad);
    expect(`openExternal ${bad}`, r, r.startsWith('rejected:'));
  }
  expect('shell.openExternal after rejected urls', JSON.stringify(await app.evaluate(() => globalThis.__opened)), (await app.evaluate(() => globalThis.__opened)).length === 0);
  r = await call('openExternal', 'https://example.com/a?b=1');
  expect('openExternal https', r, r === 'ok:true');
  const opened = await app.evaluate(() => globalThis.__opened);
  expect('shell.openExternal https', JSON.stringify(opened), JSON.stringify(opened) === '["https://example.com/a?b=1"]');

  // ---- windows: New window / Open in new window / files from a second instance
  const winFlags = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => {
    const p = w.webContents.getLastWebPreferences();
    return { sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration };
  }));
  const winCount = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  const titles = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()).sort());
  const appReady = (page) => page.waitForFunction(() => window.ashStudio?.state, null, { timeout: 30000 });
  const hasTab = (page, name) => page.waitForFunction((n) => window.ashStudio?.state.tabs.some((t) => t.name === n && t.view), name, { timeout: 30000 });
  const watch = (page) => {
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  };
  const winPdf = async (name) => { const p = join(tmp, name); await writeFile(p, pdfBytes); return p; };
  const secondInstance = (p) => app.evaluate(({ app: a }, [p, root]) => { a.emit('second-instance', {}, [process.execPath, root, p], root); }, [p, root]);
  const focusByTitle = (t) => app.evaluate(({ BrowserWindow }, t) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.getTitle().startsWith(t));
    w.focus(); w.emit('focus'); // xvfb has no window manager to report focus changes
  }, t);
  const windowsLeft = (n) => app.evaluate(({ BrowserWindow }, n) => new Promise((ok, no) => {
    const end = Date.now() + 10000;
    const tick = () => (BrowserWindow.getAllWindows().length === n ? ok()
      : Date.now() > end ? no(new Error(`expected ${n} windows, have ${BrowserWindow.getAllWindows().length}`)) : setTimeout(tick, 50));
    tick();
  }), n);
  const closeByTitle = (t) => app.evaluate(({ BrowserWindow }, t) => BrowserWindow.getAllWindows().find((x) => x.getTitle().startsWith(t)).close(), t);

  step = 'windows: Ctrl+N opens a second window with the same security settings';
  expect('window count before', await winCount(), (await winCount()) === 1);
  let nextWin = app.waitForEvent('window', { timeout: 30000 });
  await win.locator('body').press('Control+n');
  const win2 = await nextWin;
  watch(win2);
  await appReady(win2);
  let flags = await winFlags();
  expect('webPreferences of every window', JSON.stringify(flags), flags.length === 2
    && flags.every((f) => f.sandbox === true && f.contextIsolation === true && f.nodeIntegration === false));
  expect('no node in the second page', 'require', await win2.evaluate(() => typeof window.require + typeof window.process) === 'undefinedundefined');

  step = 'windows: IPC from the second window (open, read, title per window)';
  const second = await winPdf('second.pdf');
  await app.evaluate(({ dialog }, d) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [d] }); }, second);
  r = await win2.evaluate(() => window.api.openFiles({}).then((f) => f.map((x) => x.name).join()));
  expect('openFiles in window 2', r, r === 'second.pdf');
  r = await win2.evaluate((p) => window.api.readFile(p).then((b) => b.length), second);
  expect('readFile in window 2', r, r === pdfBytes.length);
  await call('setTitle', 'one');
  await win2.evaluate(() => window.api.setTitle('two'));
  let t = await titles();
  expect('per-window titles', JSON.stringify(t), t[0].startsWith('one') && t[1].startsWith('two'));

  step = 'windows: Open in new window opens the chosen PDF as a tab in a new window';
  nextWin = app.waitForEvent('window', { timeout: 30000 });
  r = await call('openInNewWindow');
  expect('openInNewWindow', r, r === 'ok:true');
  const win3 = await nextWin;
  watch(win3);
  await hasTab(win3, 'second.pdf');
  expect('window count', await winCount(), (await winCount()) === 3);
  await win3.evaluate(() => window.api.setTitle('three'));
  await closeByTitle('three');
  await windowsLeft(2);

  step = "windows: second instance, open.target 'tab' -> tab in the focused window";
  r = await call('settingsSet', 'open.target', 'tab');
  expect('settingsSet open.target', r, r === 'ok:true');
  await focusByTitle('two');
  await secondInstance(await winPdf('third.pdf'));
  await hasTab(win2, 'third.pdf');
  expect('window count after second instance (tab)', await winCount(), (await winCount()) === 2);
  r = await win.evaluate(() => window.ashStudio.state.tabs.some((x) => x.name === 'third.pdf'));
  expect('third.pdf not in window 1', r, r === false);

  step = "windows: second instance, open.target 'window' -> new window";
  await call('settingsSet', 'open.target', 'window');
  nextWin = app.waitForEvent('window', { timeout: 30000 });
  await secondInstance(await winPdf('fourth.pdf'));
  const win4 = await nextWin;
  watch(win4);
  await hasTab(win4, 'fourth.pdf');
  flags = await winFlags();
  expect('webPreferences after second instance', JSON.stringify(flags), flags.length === 3
    && flags.every((f) => f.sandbox === true && f.contextIsolation === true && f.nodeIntegration === false));
  await win4.evaluate(() => window.api.setTitle('four'));
  await closeByTitle('four');
  await call('settingsSet', 'open.target', undefined);

  step = 'windows: closing the second window leaves the first working';
  await closeByTitle('third.pdf'); // window 2's title follows its active tab
  await windowsLeft(1);
  r = await call('readFile', pdfPath);
  expect('readFile in window 1 after close', r, r === `ok:${JSON.stringify({ bytes: pdfBytes.length })}`);
  await secondInstance(await winPdf('fifth.pdf'));
  await hasTab(win, 'fifth.pdf');

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
