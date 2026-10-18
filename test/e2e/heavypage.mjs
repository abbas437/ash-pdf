#!/usr/bin/env node
// End-to-end test for heavy vector pages (AutoCAD plots with hundreds of thousands of strokes; reported 18-Oct-2026:
// the window stayed blank for 8-13 s per sheet, which looked like a failed open).
//  1. The first render of a page is shown while pdf.js draws it: the page canvas is in the DOM and already has ink
//     while pdf.js is still drawing it (its render task still running).
//  2. The sidebar thumbnail renders with the main view's annotation mode, so pdf.js parses the page once (one
//     display intent state on the page) instead of twice in its single worker.
// Prints "HEAVYPAGE OK". Run `node scripts/vendor.js` first.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' };

/** A3 landscape page with `n` short stroked segments in many small paths (like a CAD plot), as PDF bytes. */
async function heavyPdf(n) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([1191, 842]);
  const parts = ['0.2 w 0 0 0 RG'];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < n; i++) {
    const x = 20 + rnd() * 1150, y = 20 + rnd() * 800;
    parts.push(`${x.toFixed(1)} ${y.toFixed(1)} m ${(x + rnd() * 6).toFixed(1)} ${(y + rnd() * 6).toFixed(1)} l S`);
  }
  const stream = doc.context.flateStream(parts.join('\n'));
  page.node.set(doc.context.obj('Contents'), doc.context.register(stream));
  return doc.save();
}

const server = createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (pathname === '/__heavy.pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }).end(Buffer.from(await heavyPdf(150_000))); return; }
  const file = resolve(root, '.' + pathname);
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

  step = 'open a heavy page: the canvas shows ink while pdf.js is still drawing';
  const r = await page.evaluate(async () => {
    const bytes = new Uint8Array(await (await fetch('/__heavy.pdf')).arrayBuffer());
    const ink = (c) => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4 * 31) if (d[i + 3] > 0 && (d[i] < 128 || d[i + 1] < 128 || d[i + 2] < 128)) return true;
      return false;
    };
    const t0 = performance.now();
    const opened = window.ashStudio.openBytes({ name: 'heavy.pdf', bytes });
    let inkBeforeRendered = false, sawCanvasBeforeRendered = false;
    while (performance.now() - t0 < 90_000) {
      await new Promise((res) => setTimeout(res, 50));
      const pageEl = document.querySelector('.page[data-page-index="0"]');
      if (!pageEl) continue;
      if (pageEl.classList.contains('rendered')) break;
      // only while pdf.js is still drawing the page (its render task is live) does a visible canvas prove progress
      const ps = window.ashStudio.state.tabs.find((t) => t.name === 'heavy.pdf')?.view?.ps?.[0];
      const c = pageEl.querySelector('canvas.page-canvas');
      if (c && ps?.task) { sawCanvasBeforeRendered = true; if (!inkBeforeRendered && ink(c)) inkBeforeRendered = true; }
    }
    await opened;
    const pageEl = document.querySelector('.page[data-page-index="0"]');
    return { sawCanvasBeforeRendered, inkBeforeRendered, rendered: !!pageEl?.classList.contains('rendered'), canvases: pageEl?.querySelectorAll('canvas.page-canvas').length ?? 0, ms: Math.round(performance.now() - t0) };
  });
  check(r.rendered, `page never rendered: ${JSON.stringify(r)}`);
  check(r.sawCanvasBeforeRendered && r.inkBeforeRendered, `the page stayed blank until fully drawn: ${JSON.stringify(r)}`);
  check(r.canvases === 1, `expected exactly one page canvas after rendering: ${JSON.stringify(r)}`);

  step = 'thumbnail shares the main view\'s parsed page (one display intent)';
  await page.waitForFunction(() => document.querySelector('.thumb-canvas'), null, { timeout: 60_000 });
  const intents = await page.evaluate(() => {
    const pg = window.ashStudio.state.tabs[0].pages[0];
    // cache keys start with pdf.js RenderingIntentFlag bits: 256 (OPLIST) is getOperatorList() - here the scanned-
    // document check, which runs on a page without text - not a render
    return [...(pg._intentStates?.keys?.() ?? [])].filter((k) => (parseInt(String(k), 10) & 256) === 0);
  });
  check(intents.length === 1, `the page was parsed for ${intents.length} display intents (${JSON.stringify(intents)}); thumbnail and view should share one`);

  step = 'zoom re-render keeps a single canvas';
  await page.keyboard.press('Control+Equal');
  await page.waitForFunction(() => document.querySelector('.page[data-page-index="0"].rendered') && document.querySelectorAll('.page[data-page-index="0"] canvas.page-canvas').length === 1, null, { timeout: 90_000 });

  check(problems.length === 0, `console/page errors: ${problems.join(' | ')}`);
  console.log(`HEAVYPAGE OK (first render ${r.ms} ms, ink shown while drawing; one parse for view + thumbnail)`);
} catch (err) {
  console.error(`heavypage e2e FAILED at step "${step}": ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
