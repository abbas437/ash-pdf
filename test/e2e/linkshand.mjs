#!/usr/bin/env node
// End-to-end test of page links and the Hand tool in Chromium via playwright-core: an internal
// GoTo link scrolls to its page; a URI link opens the External link dialog (URL shown, Copy link
// -> api.copyText, Open -> api.openExternal, recorded by the browser shim); a javascript: link's
// Open is refused with a toast; links do not fire in drawing tools nor over an annotation object;
// hovering a link shows its URL in the status bar; the Hand tool, Space held and a middle-button
// drag pan the viewer. Prints "LINKSHAND OK".
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts, PDFName, PDFString, PDFNull } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };

const URL_OK = 'https://example.com/a?b=1';
const URL_JS = 'javascript:alert(1)';
async function makePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let k = 1; k <= 4; k++) doc.addPage([612, 792]).drawText(`Page ${k}`, { x: 72, y: 740, size: 24, font });
  const [p1, , p3] = doc.getPages();
  p1.drawText('Go to page 3', { x: 76, y: 688, size: 16, font });
  p1.drawText(URL_OK, { x: 76, y: 608, size: 16, font });
  p1.drawText(URL_JS, { x: 76, y: 528, size: 16, font });
  const ctx = doc.context;
  const link = (rect, extra) => ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: rect, Border: [0, 0, 0], ...extra }));
  const uri = (u) => ctx.obj({ S: 'URI', URI: PDFString.of(u) });
  const annots = [
    link([72, 680, 300, 710], { Dest: ctx.obj([p3.ref, PDFName.of('XYZ'), PDFNull, 792, PDFNull]) }),
    link([72, 600, 300, 630], { A: uri(URL_OK) }),
    link([72, 520, 300, 550], { A: uri(URL_JS) }),
  ];
  p1.node.set(PDFName.of('Annots'), ctx.obj(annots));
  return Buffer.from(await doc.save());
}

const server = createServer(async (req, res) => {
  const file = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file)); } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const check = (cond, msg) => { if (!cond) throw new Error(msg); };
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const problems = [];
let step = 'start';
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  await page.goto(`${base}/renderer/index.html`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  step = 'open';
  const pdf = await makePdf();
  await page.evaluate((b) => window.ashStudio.openBytes({ name: 'links.pdf', bytes: new Uint8Array(b) }), [...pdf]);
  await page.waitForFunction(() => document.querySelectorAll('.page[data-page-index="0"] .pdf-link').length === 3);
  const links = page.locator('.page[data-page-index="0"] .pdf-link');
  const center = async (i) => { const b = await links.nth(i).boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
  const sc = page.locator('.viewer-scroll:not([hidden])');
  const scrollTop = () => sc.evaluate((el) => el.scrollTop);
  const setScroll = async (v) => { await sc.evaluate((el, y) => { el.scrollTop = y; }, v); await page.waitForTimeout(150); };
  const tool = () => page.evaluate(() => window.ashStudio.state.tool);
  const opened = () => page.evaluate(() => [...window.__ashShim.opened]);
  const dialogCount = () => page.locator('.link-dialog').count();
  const clickAt = async (p, opts) => { await page.mouse.move(p.x, p.y); await page.mouse.down(opts); await page.mouse.up(opts); };
  const page3Offset = () => page.evaluate(() => {
    const s = document.querySelector('.viewer-scroll:not([hidden])'), p = s.querySelector('.page[data-page-index="2"]');
    return p.getBoundingClientRect().top - s.getBoundingClientRect().top;
  });

  step = 'hovering a link shows its URL in the status bar';
  let p = await center(1);
  await page.mouse.move(p.x, p.y);
  await page.waitForFunction((u) => document.querySelector('footer.statusbar .st-link:not([hidden])')?.textContent === u, URL_OK, { timeout: 3000 });

  step = 'internal link scrolls to page 3';
  check(await tool() === 'select', `start tool ${await tool()}`);
  await clickAt(await center(0));
  await page.waitForFunction(() => {
    const s = document.querySelector('.viewer-scroll:not([hidden])'), q = s.querySelector('.page[data-page-index="2"]');
    return Math.abs(q.getBoundingClientRect().top - s.getBoundingClientRect().top) < 40;
  }, null, { timeout: 3000 });
  await setScroll(0);

  step = 'URI link: dialog with the URL, Copy link, Open';
  await clickAt(await center(1));
  await page.locator('.link-dialog').waitFor({ timeout: 3000 });
  check(await page.locator('.link-dialog .url-field').inputValue() === URL_OK, 'dialog shows the full URL');
  await page.locator('.link-dialog button', { hasText: 'Copy link' }).click();
  await page.waitForFunction((u) => window.__ashShim.copied.includes(u), URL_OK, { timeout: 3000 });
  check(await dialogCount() === 1, 'Copy link keeps the dialog open');
  await page.locator('.link-dialog button', { hasText: 'Open' }).click();
  await page.waitForFunction(() => window.__ashShim.opened.length === 1, null, { timeout: 3000 });
  check(JSON.stringify(await opened()) === JSON.stringify([URL_OK]), `opened ${JSON.stringify(await opened())}`);
  check(await dialogCount() === 0, 'dialog closed after Open');

  step = 'javascript: link: Open is refused with a toast';
  await clickAt(await center(2));
  await page.locator('.link-dialog').waitFor({ timeout: 3000 });
  check(await page.locator('.link-dialog .url-field').inputValue() === URL_JS, 'dialog shows the javascript: URL');
  await page.locator('.link-dialog button', { hasText: 'Open' }).click();
  await page.locator('.toast', { hasText: 'not opened' }).first().waitFor({ timeout: 3000 });
  check((await opened()).length === 1, `javascript: link reached openExternal: ${JSON.stringify(await opened())}`);

  step = 'links do not fire while a drawing tool is active';
  await page.locator('.viewer-scroll:not([hidden])').focus();
  await page.keyboard.press('p');
  check(await tool() === 'draw', `tool after P: ${await tool()}`);
  await clickAt(await center(1));
  await page.waitForTimeout(300);
  check(await dialogCount() === 0, 'a link fired under the Draw tool');
  await page.keyboard.press('Control+z');

  step = 'Select: an annotation object over a link wins over the link';
  await page.keyboard.press('r');
  const b0 = await links.nth(0).boundingBox();
  await page.mouse.move(b0.x - 4, b0.y - 4);
  await page.mouse.down();
  await page.mouse.move(b0.x + b0.width + 4, b0.y + b0.height + 4, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.press('v');
  const objs = await page.evaluate(() => { const t = window.ashStudio.state.tabs.find((x) => x.id === window.ashStudio.state.activeId); return t.objects.length; });
  check(objs === 1, `expected one rectangle over the link, got ${objs}`);
  await clickAt({ x: b0.x + b0.width / 2, y: b0.y + 1 });
  await page.waitForTimeout(400);
  check(await scrollTop() < 5, `link under an object navigated (scrollTop ${await scrollTop()})`);
  await page.keyboard.press('Control+z');

  step = 'Hand tool: Q, drag 200 px pans 200 px';
  await page.keyboard.press('q');
  check(await tool() === 'hand', `tool after Q: ${await tool()}`);
  await setScroll(0);
  const box = await sc.boundingBox();
  const from = { x: box.x + box.width / 2 + 200, y: box.y + box.height - 100 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, from.y - 200, { steps: 10 });
  await page.mouse.up();
  const panned = await scrollTop();
  check(Math.abs(panned - 200) <= 3, `Hand drag of 200 px changed scrollTop by ${panned}`);

  step = 'Hand tool: a click on a link still follows it';
  await setScroll(0);
  await clickAt(await center(1));
  await page.locator('.link-dialog').waitFor({ timeout: 3000 });
  await page.locator('.link-dialog button', { hasText: 'Cancel' }).click();
  check((await opened()).length === 1, 'Cancel must not open');

  step = 'Space held: temporary Hand, back to Select on release';
  await page.locator('.viewer-scroll:not([hidden])').focus();
  await page.keyboard.press('v');
  await setScroll(0);
  await page.keyboard.down('Space');
  check(await tool() === 'hand', `tool with Space held: ${await tool()}`);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, from.y - 150, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  check(Math.abs(await scrollTop() - 150) <= 3, `Space-drag of 150 px changed scrollTop by ${await scrollTop()}`);
  check(await tool() === 'select', `tool after Space release: ${await tool()}`);

  step = 'middle-button drag pans in any tool';
  await page.keyboard.press('p');
  await setScroll(0);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(from.x, from.y - 120, { steps: 10 });
  await page.mouse.up({ button: 'middle' });
  check(Math.abs(await scrollTop() - 120) <= 3, `middle drag of 120 px changed scrollTop by ${await scrollTop()}`);
  const n = await page.evaluate(() => window.ashStudio.state.tabs.find((x) => x.id === window.ashStudio.state.activeId).objects.length);
  check(n === 0, `middle drag drew ${n} objects`);

  if (problems.length) throw new Error(problems.join('\n'));
  console.log('LINKSHAND OK');
} catch (err) {
  console.error(`FAILED at "${step}": ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
