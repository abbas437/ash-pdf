#!/usr/bin/env node
// End-to-end test of the PDFium edit worker (renderer/pdfium/) in Chromium under the real CSP of
// renderer/index.html: lazy start (no worker/wasm request before first use), then
// ashStudio.pdfium.selfTest() -> page count, text of a known text object, incremental save whose output
// starts with the original bytes; plus error propagation and no CSP violation. Prints "PDFIUM OK".
// Run `node scripts/vendor.js` first.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };
const server = createServer(async (req, res) => {
  const file = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file)); } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const check = (cond, msg) => { if (!cond) throw new Error(msg); };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let step = 'start';
try {
  const page = await browser.newPage();
  const problems = [], requests = [];
  page.on('console', (m) => { if (m.type() === 'error' || /Content Security Policy|Refused to/i.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(`${base}/renderer/index.html`);
  await page.waitForFunction(() => window.ashStudio?.pdfium);

  step = 'lazy: nothing loaded before first use';
  await page.waitForTimeout(300);
  const early = requests.filter((u) => /pdfium\/worker\.js|pdfium\.wasm|index\.browser\.js/.test(u));
  check(early.length === 0 && !(await page.evaluate(() => window.ashStudio.pdfium.started)), `loaded before use: ${early.join(', ')}`);

  step = 'selfTest';
  const r = await page.evaluate(() => window.ashStudio.pdfium.selfTest().catch((e) => ({ error: `${e.name}: ${e.message}` })));
  check(!r.error, `selfTest threw: ${r.error}`);
  check(r.pageCount === 2, `pageCount ${r.pageCount}`);
  check(r.text === 'PDFium self-test 4711', `text ${JSON.stringify(r.text)}`);
  const o = r.objects[0];
  check(o.font === 'Helvetica' && Math.round(o.size) === 14 && o.matrix.join() === '1,0,0,1,50,700' && o.bounds.length === 4 && o.bounds[0] > 49, `object ${JSON.stringify(o)}`);
  check(r.originalIsPrefix && r.outLength > r.inLength, `incremental save: prefix=${r.originalIsPrefix} in=${r.inLength} out=${r.outLength}`);

  step = 'errors propagate; caller bytes stay usable';
  const e = await page.evaluate(async () => {
    const p = window.ashStudio.pdfium, junk = new Uint8Array([1, 2, 3]);
    const a = await p.open(junk).then(() => 'resolved', (err) => err.message);
    const b = await p.pageCount(9999).then(() => 'resolved', (err) => err.message);
    return { a, b, junkLen: junk.length };
  });
  check(/cannot open document/.test(e.a) && /no open document 9999/.test(e.b) && e.junkLen === 3, `errors ${JSON.stringify(e)}`);

  step = 'no console errors or CSP violations';
  check(!problems.length, problems.join('\n'));
  console.log(`PDFIUM OK (pages=${r.pageCount}, text="${r.text}", incremental ${r.inLength} -> ${r.outLength} bytes)`);
} catch (err) {
  console.error(`PDFIUM FAILED at step "${step}": ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
