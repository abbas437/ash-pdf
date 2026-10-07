#!/usr/bin/env node
// Browser smoke test: serves the repo over HTTP, opens renderer/index.html in Chromium
// (playwright-core) and checks that the page boots under its CSP with the browser shim,
// that the import map resolves, and that pdf.js can open a PDF made in-page by pdf-lib.
// Run `npm run vendor` first. Chromium path: $CHROMIUM_PATH or the sandbox default below.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };

const server = createServer(async (req, res) => {
  const file = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const problems = [];
try {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`));
  });
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('app')?.textContent.includes('ready'), null, { timeout: 10_000 });

  const result = await page.evaluate(async () => {
    const { PDFDocument, StandardFonts } = await import('pdf-lib');
    const fontkit = (await import('@pdf-lib/fontkit')).default;
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([595, 842]).drawText('ASH PDF Studio smoke', { x: 50, y: 780, size: 18, font });
    const bytes = await doc.save();

    const pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', location.href).href;
    const vendor = new URL('./vendor/pdfjs/', location.href).href;
    const pdf = await pdfjs.getDocument({
      data: bytes, cMapUrl: vendor + 'cmaps/', cMapPacked: true, standardFontDataUrl: vendor + 'standard_fonts/',
      wasmUrl: vendor + 'wasm/', iccUrl: vendor + 'iccs/', isEvalSupported: false, enableScripting: false,
    }).promise;
    const page1 = await pdf.getPage(1);
    const text = (await page1.getTextContent()).items.map((i) => i.str).join('');
    const vp = page1.getViewport({ scale: 1 });
    const canvas = document.createElement('canvas');
    canvas.width = vp.width; canvas.height = vp.height;
    await page1.render({ canvas, viewport: vp }).promise;
    return {
      isElectron: window.api.isElectron,
      apiKeys: Object.keys(window.api).sort().join(','),
      hasPDFDocument: typeof PDFDocument === 'function',
      fontkitCreate: typeof fontkit.create === 'function',
      numPages: pdf.numPages,
      text,
    };
  });
  if (result.isElectron !== false) problems.push(`window.api.isElectron = ${result.isElectron}`);
  if (!result.hasPDFDocument) problems.push('pdf-lib import did not return PDFDocument');
  if (!result.fontkitCreate) problems.push('@pdf-lib/fontkit default export has no create()');
  if (result.numPages !== 1) problems.push(`numPages = ${result.numPages}`);
  if (!result.text.includes('ASH PDF Studio smoke')) problems.push(`text layer = ${JSON.stringify(result.text)}`);
  const expectedKeys = 'getLaunchFiles,isElectron,onOpenFile,openFiles,print,readFile,saveFile,setTitle,settingsGet,settingsSet,showItem,version,writeFile';
  if (result.apiKeys !== expectedKeys) problems.push(`api keys = ${result.apiKeys}`);
  await page.waitForTimeout(300); // let late console/CSP reports arrive
} catch (err) {
  problems.push(`exception: ${err.message}`);
} finally {
  await browser.close();
  server.close();
}

if (problems.length) {
  console.error('SMOKE FAILED\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('SMOKE OK');
