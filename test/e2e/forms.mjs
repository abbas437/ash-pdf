#!/usr/bin/env node
// End-to-end test of form filling (renderer/ui/forms.js) in Chromium via playwright-core.
// Builds an AcroForm PDF with pdf-lib, opens it through the browser shim, checks control
// geometry at 100 %, 150 % and view rotation 90, fills every kind of field, saves through
// app.saveTab (beforeSave hooks), verifies the saved values with pdf-lib, then flattens.
// Prints "FORMS OK". Run `node scripts/vendor.js` first.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = join(root, 'test', 'e2e', 'out');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };
const H = 792; // page height (pt) of the unrotated page 1
const RADIO = [['A', 72], ['B', 110], ['C', 148]];

async function makeFormPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([612, 792]);
  const p2 = doc.addPage([612, 792]);
  p2.setRotation(degrees(90));
  p1.drawText('Shop drawing transmittal', { x: 72, y: 720, size: 20, font });
  const form = doc.getForm();
  form.createTextField('name').addToPage(p1, { x: 72, y: 650, width: 200, height: 22 });
  const notes = form.createTextField('notes');
  notes.enableMultiline();
  notes.addToPage(p1, { x: 72, y: 520, width: 300, height: 80 });
  form.createCheckBox('agree').addToPage(p1, { x: 72, y: 480, width: 14, height: 14 });
  const choice = form.createRadioGroup('choice');
  for (const [opt, x] of RADIO) choice.addOptionToPage(opt, p1, { x, y: 440, width: 14, height: 14 });
  const colour = form.createDropdown('colour');
  colour.addOptions(['Red', 'Green', 'Blue']);
  colour.addToPage(p1, { x: 72, y: 400, width: 120, height: 20 });
  const ref = form.createTextField('ref');
  ref.setText('REF-001');
  ref.addToPage(p1, { x: 300, y: 650, width: 150, height: 22 });
  ref.enableReadOnly();
  form.createButton('btn').addToPage('Go', p1, { x: 300, y: 400, width: 80, height: 20 });
  form.createTextField('p2text').addToPage(p2, { x: 100, y: 300, width: 180, height: 20 });
  return Buffer.from(await doc.save());
}

const server = createServer(async (req, res) => {
  const file = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try {
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
await mkdir(OUT, { recursive: true });

const problems = [];
const fail = (msg) => { throw new Error(msg); };
const check = (cond, msg) => { if (!cond) fail(msg); };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let step = 'start';
try {
  const pdf = await makeFormPdf();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('console', (m) => {
    if (m.type() === 'error' || /\[bus\]|\[forms\]|failed to render|Content Security Policy/i.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  const S = 'const app = window.ashStudio, v = app.viewer, tab = app.state.tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  step = 'open';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  const chooser = page.waitForEvent('filechooser');
  await page.click('#btn-open');
  await (await chooser).setFiles({ name: 'form.pdf', mimeType: 'application/pdf', buffer: pdf });
  await page.waitForFunction(() => document.querySelectorAll('.form-layer .form-ctl').length >= 10, null, { timeout: 10_000 });
  const barText = await page.textContent('.forms-bar-text');
  check(await page.locator('.forms-bar').isVisible() && barText.includes('fillable fields') && barText.includes('8 fields'), `info bar: ${barText}`);
  check(await page.locator('#app [data-tool="forms"]').isEnabled(), 'Forms tool button not enabled');

  step = 'tab order';
  const order = await ev('return [...v.getOverlayEl(tab, 0).querySelectorAll(".form-ctl")].map((e) => e.dataset.field + (e.dataset.option ? ":" + e.dataset.option : ""));');
  check(JSON.stringify(order) === JSON.stringify(['name', 'ref', 'notes', 'agree', 'choice:A', 'choice:B', 'choice:C', 'colour', 'btn']), `page 1 control order: ${order}`);
  check((await page.getAttribute('[data-field="name"]', 'aria-label')) === 'name', 'accessible name of text field');
  check((await page.getAttribute('.form-unsupported[data-field="btn"]', 'title')).includes('not supported'), 'button field tooltip');

  // Expected client AABB of every control from the core's field rects (first widget) and the
  // test's own radio geometry, mapped with viewer.pageToClient (independent of forms.js CSS).
  const geometry = async (label) => {
    const res = await ev(`
      const core = await import('/src/core/index.js');
      const fields = await core.listFields(tab.bytes);
      const radio = arg.radio.map(([o, x]) => ({ o, rect: { x, y: arg.H - 440 - 14, w: 14, h: 14 } }));
      const want = [];
      for (const f of fields) {
        if (f.type === 'radio') for (const r of radio) want.push({ sel: '[data-field="choice"][data-option="' + r.o + '"]', pageIndex: 0, rect: r.rect });
        else want.push({ sel: '[data-field="' + f.name + '"]', pageIndex: f.pageIndex, rect: f.rect });
      }
      const out = [];
      for (const w of want) {
        const el = v.getOverlayEl(tab, w.pageIndex).querySelector(w.sel);
        if (!el) { out.push(w.sel + ' missing'); continue; }
        const a = v.pageToClient(tab, w.pageIndex, w.rect.x, w.rect.y), b = v.pageToClient(tab, w.pageIndex, w.rect.x + w.rect.w, w.rect.y + w.rect.h);
        const e = { l: Math.min(a.clientX, b.clientX), t: Math.min(a.clientY, b.clientY), r: Math.max(a.clientX, b.clientX), b: Math.max(a.clientY, b.clientY) };
        const g = el.getBoundingClientRect();
        const d = Math.max(Math.abs(g.left - e.l), Math.abs(g.top - e.t), Math.abs(g.right - e.r), Math.abs(g.bottom - e.b));
        if (!(d <= 1.5)) out.push(w.sel + ' off by ' + d.toFixed(2) + 'px');
      }
      return { out, n: want.length };`, { radio: RADIO, H });
    check(res.n === 10, `${label}: expected 10 widgets, got ${res.n}`);
    check(!res.out.length, `${label}: ${res.out.join('; ')}`);
  };
  step = 'geometry 100%';
  await page.selectOption('.zoom-select', '1'); await settle();
  await geometry('zoom 100%');
  step = 'geometry 150%';
  await page.selectOption('.zoom-select', '1.5'); await settle();
  await geometry('zoom 150%');
  step = 'geometry rotation 90';
  await page.selectOption('.zoom-select', '1'); await page.click('#btn-rotr'); await settle();
  await geometry('view rotation 90');
  await ev('v.scrollToPage(tab, 0);'); await settle();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'forms-rot90.png') });
  await page.click('#btn-rotl'); await settle();

  step = 'fill';
  await ev('v.scrollToPage(tab, 0);'); await settle();
  check(!(await ev('return tab.dirty;')), 'tab dirty before any edit');
  await page.fill('[data-field="name"]', 'Ahmad Test');
  check(await ev('return tab.dirty;'), 'typing did not mark the tab dirty');
  await page.fill('textarea[data-field="notes"]', 'Line one\nLine two');
  await page.check('[data-field="agree"]');
  await page.check('[data-field="choice"][data-option="B"]');
  await page.selectOption('[data-field="colour"]', 'Green');
  const ref = page.locator('[data-field="ref"]');
  check(!(await ref.isEditable()), 'read-only field is editable');
  await ref.focus(); await page.keyboard.type('XYZ');
  check((await ref.inputValue()) === 'REF-001', 'read-only field value changed');
  const p2 = page.locator('[data-field="p2text"]');
  await p2.fill('Δelta');
  const warn = page.locator('.form-warn:not([hidden])');
  check(await warn.count() === 1 && await warn.isVisible(), 'non-WinAnsi warning not shown');
  await p2.fill('plain');
  check(await page.locator('.form-warn:not([hidden])').count() === 0, 'warning did not clear for WinAnsi text');
  await p2.fill('Δelta');

  step = 'screenshot';
  await ev('v.scrollToPage(tab, 0);'); await settle();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'forms-filled.png') });

  step = 'save';
  check((await ev('return app.state.hooks.beforeSave.length >= 1;')), 'no beforeSave hook registered');
  check(await ev('return await app.saveTab(tab, false);'), 'saveTab returned false');
  const saved = Uint8Array.from(await ev('return Array.from(await window.api.readFile(tab.path));'));
  const doc = await PDFDocument.load(saved);
  const form = doc.getForm();
  const got = {
    name: form.getTextField('name').getText(), notes: form.getTextField('notes').getText(),
    agree: form.getCheckBox('agree').isChecked(), choice: form.getRadioGroup('choice').getSelected(),
    colour: form.getDropdown('colour').getSelected()[0], ref: form.getTextField('ref').getText(), p2text: form.getTextField('p2text').getText(),
  };
  const exp = { name: 'Ahmad Test', notes: 'Line one\nLine two', agree: true, choice: 'B', colour: 'Green', ref: 'REF-001', p2text: 'Δelta' };
  check(JSON.stringify(got) === JSON.stringify(exp), `saved values ${JSON.stringify(got)} != ${JSON.stringify(exp)}`);
  check(!(await ev('return tab.dirty;')), 'tab still dirty after save');

  // Page operation, fill, save, then undo the page operation: the undo snapshot predates the
  // save, so the filled value must survive outside tab.bytes and be written by the next save.
  step = 'undo page change after save';
  const reloaded = () => page.waitForFunction(() => { const t = window.ashStudio.state.tabs[0]; return !!t.forms && document.querySelectorAll('.form-layer .form-ctl').length >= 10; }, null, { timeout: 10_000 });
  await ev('await app.pageTools.rotate(tab, [1], 90);');
  await page.waitForFunction(() => window.ashStudio.state.tabs[0].pages?.[1]?.rotate === 180, null, { timeout: 10_000 });
  await reloaded();
  await page.fill('[data-field="name"]', 'After rotate');
  check(await ev('return await app.saveTab(tab, false);'), 'saveTab after rotate returned false');
  check(await ev('return await app.pageTools.undo(tab);'), 'page undo returned false');
  await reloaded();
  await page.waitForFunction(() => window.ashStudio.state.tabs[0].pages?.[1]?.rotate === 90, null, { timeout: 10_000 });
  await settle();
  check((await page.inputValue('[data-field="name"]')) === 'After rotate', `name field after undo: ${await page.inputValue('[data-field="name"]')}`);
  check(await ev('return await app.saveTab(tab, false);'), 'saveTab after undo returned false');
  const resaved = (await PDFDocument.load(Uint8Array.from(await ev('return Array.from(await window.api.readFile(tab.path));')))).getForm();
  check(resaved.getTextField('name').getText() === 'After rotate', `saved name after undo: ${resaved.getTextField('name').getText()}`);
  check(resaved.getDropdown('colour').getSelected()[0] === 'Green', 'saved colour lost after undo');

  step = 'flatten';
  await page.click('.forms-bar-flatten');
  await page.click('.dialog button[data-value="flatten"]');
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs[0]; return t.dirty && !t.forms && !document.querySelector('.form-layer'); }, null, { timeout: 10_000 });
  await page.waitForTimeout(500);
  check(!(await page.locator('.forms-bar').isVisible()), 'info bar still visible after flatten');
  check(await ev('return await app.saveTab(tab, false);'), 'saveTab after flatten returned false');
  const flat = await PDFDocument.load(Uint8Array.from(await ev('return Array.from(await window.api.readFile(tab.path));')));
  check(flat.getForm().getFields().length === 0, `flattened PDF still has ${flat.getForm().getFields().length} fields`);
  check(await page.locator('.form-ctl').count() === 0, 'controls remain after flatten');
} catch (err) {
  problems.push(`[${step}] ${err.message.split('\n')[0]}`);
} finally {
  await browser.close();
  server.close();
}
if (problems.length) {
  console.error('FORMS FAILED\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('FORMS OK');
