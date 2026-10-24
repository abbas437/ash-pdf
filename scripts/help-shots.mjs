#!/usr/bin/env node
// Help screenshots: renders the shots listed in help/shots.json into help/img/<name>.png using the
// browser build (same static-server harness as the e2e tests). Run: npm run help:shots [name …]
// help/shots.json: [{ name, viewport?: {width, height}, open?: <number of sample PDFs to open>,
//   keys?: ["t", …] (pressed after opening), eval?: "<async JS body run in the page>",
//   wait?: <ms>, clip?: "<selector>" (default: the whole window), pad?: <px around the clip> }]
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml' };

async function samplePdf(n) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let k = 1; k <= 4; k++) {
    const p = doc.addPage([595, 842]);
    p.drawText(`Sample document ${n}`, { x: 60, y: 770, size: 22, font: bold, color: rgb(0.08, 0.14, 0.12) });
    p.drawText(`Page ${k}`, { x: 60, y: 740, size: 12, font });
    for (let i = 0; i < 18; i++) p.drawText('ASH PDF Studio opens, reads and edits PDF files on your computer.', { x: 60, y: 700 - i * 22, size: 11, font, color: rgb(0.25, 0.28, 0.26) });
    p.drawRectangle({ x: 60, y: 160, width: 475, height: 90, borderColor: rgb(0.6, 0.48, 0.17), borderWidth: 1 });
  }
  return Buffer.from(await doc.save());
}

const only = process.argv.slice(2);
const shots = JSON.parse(await readFile(join(root, 'help', 'shots.json'), 'utf8')).filter((s) => !only.length || only.includes(s.name));
const server = createServer(async (req, res) => {
  const file = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file)); } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
await mkdir(join(root, 'help', 'img'), { recursive: true });
let failed = 0;
try {
  for (const s of shots) {
    const page = await browser.newPage({ viewport: s.viewport ?? { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    try {
      await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
      await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 15_000 });
      for (let i = 1; i <= (s.open ?? 0); i++) {
        const chooser = page.waitForEvent('filechooser');
        await page.click('#btn-open');
        await (await chooser).setFiles({ name: `Sample ${i}.pdf`, mimeType: 'application/pdf', buffer: await samplePdf(i) });
        await page.waitForFunction((n) => window.ashStudio?.state.tabs.length >= n && window.ashStudio.state.tabs.at(-1).numPages > 0, i, { timeout: 15_000 });
      }
      await page.waitForTimeout(300);
      for (const k of s.keys ?? []) { await page.keyboard.press(k); await page.waitForTimeout(80); }
      if (s.eval) await page.evaluate(new Function(`return (async () => { ${s.eval} })();`));
      await page.waitForTimeout(s.wait ?? 400);
      let clip;
      if (s.clip) {
        const r = await page.$eval(s.clip, (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; });
        const p = s.pad ?? 0;
        clip = { x: Math.max(0, r.x - p), y: Math.max(0, r.y - p), width: r.width + 2 * p, height: r.height + 2 * p };
      }
      await page.screenshot({ path: join(root, 'help', 'img', `${s.name}.png`), clip });
      console.log(`help shot: ${s.name}.png`);
    } catch (err) {
      failed++;
      console.error(`help shot ${s.name} FAILED: ${err.message}`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
process.exitCode = failed ? 1 : 0;
