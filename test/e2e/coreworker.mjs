#!/usr/bin/env node
// End-to-end test of the core worker's main-thread fallback (renderer/coreworker/client.js): whatever happens
// to the worker, opening still mirrors a file's markups as overlay objects and still detects a signature.
//  - missing: the worker script does not load (404).
//  - crash:   the worker dies while idle (an error event with no call pending), after it served a first open.
//  - hang:    the worker never answers readAnnotations / detectSignatures (as if killed without an error
//             event); the per-call timeout (floor lowered to 1.5 s here) gives up on it.
// Prints "COREWORKER OK". Run `node scripts/vendor.js` first.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, PDFString } from 'pdf-lib';
import { makePdf, makeSignedPdf } from '../helpers.js';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' };
const WORKER = '/renderer/coreworker/worker.js';
// Appended to the worker module per mode (it wraps the module's own self.onmessage).
const INJECT = {
  crash: `\nnew BroadcastChannel('core-test').onmessage = () => setTimeout(() => { throw new Error('test: core worker crashed'); });\n`,
  hang: `\nconst served = self.onmessage;\nself.onmessage = (e) => { if (!['readAnnotations', 'detectSignatures'].includes(e.data.method)) return served(e); };\n`,
};
let mode = 'missing';

const server = createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = resolve(root, '.' + pathname);
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  if (pathname === WORKER && mode === 'missing') { res.writeHead(404).end(); return; }
  try {
    let body = await readFile(file);
    if (pathname === WORKER && INJECT[mode]) body = body.toString('utf8') + INJECT[mode];
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const check = (cond, msg) => { if (!cond) throw new Error(msg); };

/** One page with a foreign /Square markup (mirrored as an overlay object when opened). */
async function markupPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.drawText('Markup page', { x: 50, y: 700, size: 18 });
  page.node.addAnnot(doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Square', Rect: [100, 400, 200, 460], C: [1, 0, 0], F: 4, NM: PDFString.of('cw-square'), T: PDFString.of('Reviewer') })));
  return doc.save();
}
const files = { plain: [...await makePdf(1)], markup: [...await markupPdf()], signed: [...await makeSignedPdf()] };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const problems = [];
let step = 'start';
try {
  for (mode of ['missing', 'crash', 'hang']) {
    step = `${mode}: start`;
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const warnings = [];
    page.on('pageerror', (e) => problems.push(`[${mode}] pageerror: ${e.message}`));
    page.on('console', (m) => { if (/Core worker unavailable/.test(m.text())) warnings.push(m.text()); });
    await page.goto(`${base}/renderer/index.html`);
    await page.waitForFunction(() => document.body.dataset.ready === 'true');
    await page.evaluate(async () => { (await import('/renderer/coreworker/client.js')).coreWorker.timeoutFloorMs = 1500; });
    const open = (name, path, bytes) => page.evaluate(async ({ name, path, bytes }) => {
      const tab = await window.ashStudio.openBytes({ name, path, bytes: new Uint8Array(bytes) });
      await tab.signatureCheck;
      return tab.id;
    }, { name, path, bytes });

    if (mode === 'crash') {
      step = 'crash: a first open served by the worker, then the idle worker dies';
      await open('plain.pdf', 'C:/docs/plain.pdf', files.plain);
      check(await page.evaluate(async () => (await import('/renderer/coreworker/client.js')).coreWorker.inWorker), 'the worker served the first open');
      await page.evaluate(() => new BroadcastChannel('core-test').postMessage('crash'));
      await page.waitForTimeout(500);
    }

    step = `${mode}: markup PDF -> overlay object`;
    const markupId = await open('markup.pdf', 'C:/docs/markup.pdf', files.markup);
    await page.waitForFunction((id) => {
      const t = window.ashStudio.state.tabs.find((x) => x.id === id);
      return t?.objects?.some((o) => o.id === 'cw-square') && document.querySelector('.page[data-page-index="0"].rendered');
    }, markupId, { timeout: 15_000 }).catch(() => { throw new Error('the markup never became an overlay object'); });
    const shown = await page.evaluate(async (id) => {
      const t = window.ashStudio.state.tabs.find((x) => x.id === id);
      return (await (await t.pdfDoc.getPage(1)).getAnnotations()).filter((a) => a.subtype === 'Square').length;
    }, markupId);
    check(shown === 0, `the displayed document still has the Square (drawn twice): ${shown}`);

    step = `${mode}: signed PDF -> detected`;
    const signedId = await open('signed.pdf', 'C:/docs/signed.pdf', files.signed);
    const sp = await page.evaluate((id) => window.ashStudio.state.tabs.find((x) => x.id === id).signedPath, signedId);
    check(sp === 'C:/docs/signed.pdf', `signed file not detected: signedPath ${JSON.stringify(sp)}`);

    check(warnings.length === 1, `expected the fallback logged once, got ${warnings.length}`);
    check(!(await page.evaluate(async () => (await import('/renderer/coreworker/client.js')).coreWorker.inWorker)), 'calls still go to a lost worker');
    await page.close();
  }
} catch (err) {
  problems.push(`[${step}] ${err.message.split('\n')[0]}`);
} finally {
  await browser.close();
  server.close();
}
if (problems.length) { console.error('COREWORKER FAILED\n  ' + problems.join('\n  ')); process.exit(1); }
console.log('COREWORKER OK');
