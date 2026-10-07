#!/usr/bin/env node
// Real Electron app, fresh portable data dir: last-session restore, missing files, start-up modes, recent
// files, and main ignoring a session entry whose path was never granted. Launched like electron.mjs.
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const electronBin = process.env.ELECTRON_BIN || createRequire(import.meta.url)('electron');
const tmp = await mkdtemp(join(tmpdir(), 'ash-pdf-session-'));
const dataDir = join(tmp, 'ASH-PDF-Studio-data');
async function pdf(name) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 3; n++) doc.addPage([612, 792]).drawText(`${name} page ${n}`, { x: 72, y: 700, size: 28, font });
  const p = join(tmp, name);
  await writeFile(p, await doc.save());
  return p;
}
const [a, b, c] = [await pdf('a.pdf'), await pdf('b.pdf'), await pdf('c.pdf')];
const never = join(tmp, 'never-granted.pdf');
await writeFile(never, readFileSync(a));
const readJson = (f) => JSON.parse(readFileSync(join(dataDir, f), 'utf8'));
const sessionPaths = () => readJson('session.json').windows.flatMap((w) => w.files.map((f) => f.path));

let step = 'launch';
let app = null;
const problems = [];
const expect = (what, got, ok) => { if (!ok) throw new Error(`${what}: got ${got}`); };
async function launch(...files) {
  app = await electron.launch({
    executablePath: electronBin, args: ['--disable-gpu', root, ...files], cwd: root,
    env: { ...process.env, PORTABLE_EXECUTABLE_DIR: tmp, ASH_TEST_FAKE_SAFESTORAGE: '1', ASH_TEST_FAKE_OFFICE: '1' },
  });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  win.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  await win.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 30000 });
  return win;
}
async function quit() { await app.close(); app = null; }
const tabs = (win) => win.evaluate(() => window.ashStudio.state.tabs.map((t) => t.name));
const waitTabs = (win, names) => win.waitForFunction((n) => {
  const t = window.ashStudio.state.tabs;
  return t.length === n.length && t.every((x, i) => x.name === n[i] && x.view);
}, names, { timeout: 30000 });

try {
  step = 'run 1: two PDFs from the command line are recorded';
  let win = await launch(a, b);
  await waitTabs(win, ['a.pdf', 'b.pdf']);
  await win.evaluate(() => { // page 3 of b, then a active
    const s = window.ashStudio, [ta, tb] = s.state.tabs;
    s.viewer.scrollToPage(tb, 2);
    s.activate(ta.id);
  });
  await win.waitForTimeout(1000);
  await quit();
  let s = readJson('session.json');
  expect('saved session', JSON.stringify(s), s.windows.length === 1 && s.windows[0].active === a
    && JSON.stringify(s.windows[0].files) === JSON.stringify([{ path: a, page: 1 }, { path: b, page: 3 }]));
  expect('recent list', JSON.stringify(readJson('recent.json')), JSON.stringify(readJson('recent.json')) === JSON.stringify([b, a]));

  step = 'run 2: the start screen offers 2 files; Reopen opens both tabs';
  win = await launch();
  const offer = await win.locator('[data-session="reopen"]').textContent({ timeout: 10000 });
  expect('offer text', offer, offer === 'Reopen last session (2 files)');
  await win.click('[data-session="reopen"]');
  await waitTabs(win, ['a.pdf', 'b.pdf']);
  const st = await win.evaluate(() => { const s = window.ashStudio.state; return { active: s.tabs.find((t) => t.id === s.activeId).name, page: s.tabs[1].currentPage }; });
  expect('restored active tab and page', JSON.stringify(st), st.active === 'a.pdf' && st.page === 2);
  expect('panel gone', '', !(await win.locator('.session-offer').count()));

  step = 'run 2: sessionUpdate with a never-granted path is ignored';
  await win.waitForTimeout(800); // let the renderer's own reports settle
  const r = await win.evaluate(([a, b, never]) => window.api.sessionUpdate({ files: [{ path: a, page: 1 }, { path: never, page: 1 }, { path: b, page: 1 }], active: never }), [a, b, never]);
  expect('sessionUpdate result', r, r === true);
  await quit();
  expect('session without the ungranted path', JSON.stringify(sessionPaths()), JSON.stringify(sessionPaths()) === JSON.stringify([a, b]));
  expect('recent without the ungranted path', '', !readJson('recent.json').includes(never));

  step = 'run 3: a deleted file is listed as unavailable, the other opens';
  await unlink(b);
  win = await launch();
  await win.click('[data-session="reopen"]', { timeout: 10000 });
  const missing = win.locator('.session-missing-dialog');
  await missing.waitFor({ timeout: 30000 });
  const listed = await missing.locator('li .file-name').allTextContents();
  expect('missing list', JSON.stringify(listed), JSON.stringify(listed) === '["b.pdf"]');
  await missing.locator('.dialog-buttons button').click();
  await waitTabs(win, ['a.pdf']);

  step = 'run 3: recent files lists both, the deleted one as Not found';
  await win.click('.menu-btn:has-text("File")');
  await win.click('.menu-item[data-id="recent"]');
  const items = win.locator('.recent-dialog .recent-item');
  await items.first().waitFor({ timeout: 10000 });
  const rows = await items.evaluateAll((els) => els.map((e) => [e.querySelector('.file-name').textContent, e.disabled, e.querySelector('.file-missing')?.textContent ?? '']));
  expect('recent rows', JSON.stringify(rows), JSON.stringify(rows) === JSON.stringify([['a.pdf', false, ''], ['b.pdf', true, 'Not found']]));
  await win.keyboard.press('Escape');
  await win.evaluate(() => window.api.settingsSet('startup.mode', 'restore'));
  await quit();

  step = "run 4: 'restore' with a file on the command line opens only that file";
  win = await launch(c);
  await waitTabs(win, ['c.pdf']);
  await win.waitForTimeout(1500);
  expect('tabs', JSON.stringify(await tabs(win)), JSON.stringify(await tabs(win)) === '["c.pdf"]');
  expect('session still offered on the start screen', '', (await win.locator('[data-session="reopen"]').count()) === 1);
  await win.evaluate(() => window.api.settingsSet('startup.mode', 'new'));
  await quit();
  expect('session after run 4', JSON.stringify(sessionPaths()), JSON.stringify(sessionPaths()) === JSON.stringify([c]));

  step = "run 5: 'new' opens nothing and offers nothing";
  win = await launch();
  await win.waitForTimeout(1500);
  expect('tabs', JSON.stringify(await tabs(win)), (await tabs(win)).length === 0);
  expect('no offer', '', (await win.locator('.session-offer').count()) === 0);
  await quit();

  step = 'no renderer errors';
  if (problems.length) throw new Error(problems.join('\n'));
  console.log('pdf electron session e2e: OK');
} catch (err) {
  console.error(`pdf electron session e2e FAILED at step "${step}":`, err.message);
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(() => {});
  if (existsSync(tmp)) await rm(tmp, { recursive: true, force: true });
}
