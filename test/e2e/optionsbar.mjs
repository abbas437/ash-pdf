#!/usr/bin/env node
// Options row e2e: for every tool with options, activated by toolbar click and by its shortcut, at 1280 and 1920 px,
// in both themes: the options row sits in normal flow directly under the toolbar (top >= toolbar bottom), never
// intersects the menu bar / tabs, the viewer starts below it, and File still opens its menu. Prints "E2E OK".
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' };

const server = createServer(async (req, res) => {
  const file = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try {
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const problems = [];
const check = (cond, msg) => { if (!cond) throw new Error(msg); };
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let step = 'start';
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  const chooser = page.waitForEvent('filechooser');
  await page.click('#btn-open');
  await (await chooser).setFiles({ name: 'ob.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) });
  await page.waitForFunction(() => window.ashStudio.state.tabs.some((t) => t.view));
  const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const tool = () => page.evaluate(() => window.ashStudio.state.tool);
  const toolIds = await page.$$eval('.tb-btn[data-tool]', (bs) => bs.filter((b) => !b.disabled).map((b) => ({ id: b.dataset.tool, key: /\(([^)]+)\)\s*$/.exec(b.title)?.[1] ?? '' })));
  check(toolIds.length > 5, `only ${toolIds.length} tools found`);
  let withOptions = 0;

  const assertLayout = async (label) => {
    const r = await page.evaluate(() => {
      const bb = (s) => { const e = document.querySelector(s); return e && e.getBoundingClientRect(); };
      const o = bb('.options-bar'), t = bb('.toolbar'), m = bb('.menubar'), tabs = bb('.tabstrip'), w = bb('.work');
      const hit = o.width ? document.elementFromPoint(o.x + 4, o.y + 2) : null;
      return { o, t, m, tabs, w, pos: getComputedStyle(document.querySelector('.options-bar')).position, hitInBar: !!hit?.closest('.options-bar') };
    });
    const { o, t, m, tabs, w } = r;
    check(r.pos === 'static', `${label}: options row is ${r.pos}, expected static (in flow)`);
    check(o.top >= t.bottom - 0.5, `${label}: options top ${o.top} above toolbar bottom ${t.bottom}`);
    for (const [n, b] of [['menubar', m], ['tabstrip', tabs]]) check(o.top >= b.bottom - 0.5 || o.bottom <= b.top + 0.5, `${label}: options row intersects ${n}`);
    check(w.top >= o.bottom - 0.5, `${label}: work area top ${w.top} overlaps options bottom ${o.bottom}`);
    check(r.hitInBar, `${label}: options row not hit-testable at its own corner (covered)`);
    await page.click('.menubar >> text=File');
    check(await page.locator('.menu-item').first().isVisible(), `${label}: File menu did not open`);
    await page.keyboard.press('Escape');
    await page.mouse.click(5, 790);
  };

  for (const theme of ['light', 'dark']) {
    for (const width of [1280, 1920]) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate((th) => { document.documentElement.dataset.theme = th; }, theme);
      await settle(); await settle();
      for (const { id, key } of toolIds) {
        for (const via of ['click', 'key']) {
          if (via === 'key' && !/^[A-Za-z]$/.test(key)) continue;
          step = `${theme} ${width} ${id} via ${via}`;
          await page.evaluate(() => window.ashStudio.state.tool !== 'select' && document.querySelector('.tb-btn[data-tool="select"]').click());
          await page.mouse.click(640, 500); // focus out of any field
          if (via === 'click') {
            if (await page.evaluate((i) => !!document.querySelector(`[data-tool="${i}"]`).closest('.tb-more-panel'), id)) await page.click('.tb-more-btn');
            await page.click(`.tb-btn[data-tool="${id}"]`);
          } else await page.keyboard.press(key.toLowerCase());
          await settle();
          if ((await tool()) !== id) continue; // shortcut not bound to this tool
          const shown = await page.evaluate(() => { const o = document.querySelector('.options-bar'); return !o.hidden && o.offsetHeight > 0; });
          if (!shown) continue;
          withOptions++;
          await assertLayout(step);
        }
      }
    }
  }
  step = 'summary';
  check(withOptions >= 20, `only ${withOptions} option-row activations checked`);
  check(problems.length === 0, problems.join('; '));
  console.log('E2E OK');
} catch (e) {
  console.error(`E2E FAIL at "${step}": ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
