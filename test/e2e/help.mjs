#!/usr/bin/env node
// End-to-end test of the in-app help (renderer/help/help-engine.js + renderer/ui/help-adapter.js) in Chromium:
// F1 / search / Show me spotlight / More-button fallback / guided tour / F1 context / dialog "?" / welcome card /
// external links. Prints "HELP OK".
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = join(root, 'test', 'e2e', 'out');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };

async function makePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let k = 1; k <= 2; k++) doc.addPage([612, 792]).drawText(`Page ${k}`, { x: 360, y: 700, size: 20, font });
  return Buffer.from(await doc.save());
}

const problems = [];
const server = createServer(async (req, res) => {
  const file = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try { const buf = await readFile(file); res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(buf); } catch { problems.push(`404 ${req.url}`); res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
await mkdir(OUT, { recursive: true });


const check = (cond, msg) => { if (!cond) throw new Error(msg); };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let step = 'start';
try {
  const pdf = await makePdf();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', body), arg);
  const H = 'const H = await import("/renderer/help/help-engine.js"); const data = (await import("/renderer/help/help-data.js")).default;';
  const hev = (body, arg) => ev(`${H}\n${body}`, arg);
  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const rect = (sel) => ev('const e = document.querySelector(arg); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom };', sel);
  const overlap = (a, b) => !!a && !!b && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
  const waitFor = (fn, arg, what) => page.waitForFunction(fn, arg, { timeout: 5000 }).catch(() => { throw new Error(`timed out waiting for ${what}`); });
  const text = (sel) => ev('return document.querySelector(arg)?.textContent?.trim() ?? null;', sel);

  step = 'boot';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  const chooser = page.waitForEvent('filechooser');
  await page.click('#btn-open');
  await (await chooser).setFiles({ name: 'two.pdf', mimeType: 'application/pdf', buffer: pdf });
  await page.waitForFunction(() => { const a = window.ashStudio, t = a.state.tabs[0]; return t?.numPages === 2 && a.viewer.getOverlaySvg(t, 1); }, null, { timeout: 10_000 });
  await frames();
  check(!(await page.$('.ah-welcome')), 'welcome card must be suppressed under webdriver');

  step = 'F1 opens welcome';
  const welcomeTitle = await hev('return data.topics.find((t) => t.id === "welcome").title;');
  await page.mouse.move(1450, 500);
  await page.keyboard.press('F1');
  await waitFor(() => { const p = document.querySelector('.ash-help'); return p && !p.hidden; }, null, 'help panel');
  check((await text('.ah-body h1')) === welcomeTitle, `F1 topic title "${await text('.ah-body h1')}" != "${welcomeTitle}"`);

  step = 'search text box';
  await page.fill('.ah-search', 'text box');
  await waitFor(() => document.querySelector('.ah-result'), null, 'search results');
  const first = await text('.ah-result .ah-rt');
  check(first === 'Adding and formatting text boxes', `first result is "${first}"`);
  await page.press('.ah-search', 'Enter');
  await waitFor(() => /text boxes/i.test(document.querySelector('.ah-body h1')?.textContent ?? ''), null, 'text boxes topic');

  step = 'show me spotlight';
  await page.click('a.help-showme[data-showme="tool:text"]');
  await waitFor(() => document.querySelector('.ah-spot') && document.querySelector('.ash-help.ah-folded'), null, 'spotlight + folded panel');
  await frames();
  check(overlap(await rect('.ah-spot'), await rect('[data-tool="text"]')), 'spotlight does not overlap the Text tool');
  await page.keyboard.press('Escape');
  await waitFor(() => !document.querySelector('.ah-spot') && !document.querySelector('.ash-help.ah-folded'), null, 'spotlight to end and panel to unfold');

  step = 'show me fallback (More button)';
  await page.setViewportSize({ width: 700, height: 1000 });
  await waitFor(() => !!document.querySelector('.tb-more-panel [data-tool="text"]'), null, 'Text tool inside .tb-more-panel');
  check(await hev('return await H.showMe("tool:text");'), 'showMe returned false at 700px');
  await frames();
  check(overlap(await rect('.ah-spot'), await rect('.tb-more-btn')), 'spotlight does not overlap the More button');
  await page.keyboard.press('Escape');
  await waitFor(() => !document.querySelector('.ah-spot'), null, 'spotlight to end');
  await page.setViewportSize({ width: 1600, height: 1000 });
  await waitFor(() => !document.querySelector('.tb-more-panel [data-tool="text"]'), null, 'Text tool back in the toolbar');

  step = 'tour';
  await page.click('.ah-home');
  await page.click('.ah-tourbtn[data-tour="first-steps"]');
  await waitFor(() => /^.*· 1 \//.test(document.querySelector('.ah-pop .ah-step .ah-step-n')?.textContent ?? ''), null, 'tour step 1');
  // Next moves on; then the tour's first event step advances on that app event.
  await page.click('.ah-pop .ah-step-btns .ah-primary');
  await waitFor(() => /· 2 \//.test(document.querySelector('.ah-pop .ah-step .ah-step-n')?.textContent ?? ''), null, 'tour step 2 after Next');
  await page.click('.ah-pop .ah-step-btns button:not(.ah-primary):nth-last-child(2)'); // Back
  await waitFor(() => /· 1 \//.test(document.querySelector('.ah-pop .ah-step .ah-step-n')?.textContent ?? ''), null, 'tour step 1 after Back');
  const evIdx = await hev('return data.tours.find((t) => t.id === "first-steps").steps.findIndex((s) => s.advanceOn?.startsWith("event:"));');
  check(evIdx >= 0, 'first-steps has no event step');
  for (let i = 0; i < evIdx; i++) {
    await page.click('.ah-pop .ah-step-btns .ah-primary');
    await waitFor((n) => new RegExp(`· ${n} /`).test(document.querySelector('.ah-pop .ah-step .ah-step-n')?.textContent ?? ''), i + 2, `tour step ${i + 2}`);
  }
  const adv = await hev('return data.tours.find((t) => t.id === "first-steps").steps[arg].advanceOn;', evIdx);
  await hev('H.helpEvent("not-this-one");');
  await page.waitForTimeout(300);
  check(new RegExp(`· ${evIdx + 1} /`).test(await ev('return document.querySelector(".ah-pop .ah-step .ah-step-n")?.textContent ?? "";')), 'an unrelated event advanced the tour');
  await hev('H.helpEvent(arg);', adv.slice(6));
  await waitFor((n) => new RegExp(`· ${n} /`).test(document.querySelector('.ah-pop .ah-step .ah-step-n')?.textContent ?? ''), evIdx + 2, `tour to advance on ${adv}`);
  await page.keyboard.press('Escape');
  await waitFor(() => !document.querySelector('.ah-pop'), null, 'tour to end on Esc');

  step = 'F1 context';
  check((await hev('return data.context["[data-tool=\\"text\\"]"];')) === 'text-boxes', 'context key for [data-tool="text"] missing');
  await ev('document.activeElement?.blur?.();');
  const tr = await rect('[data-tool="text"]');
  await page.mouse.move((tr.l + tr.r) / 2, (tr.t + tr.b) / 2);
  await page.keyboard.press('F1');
  await waitFor(() => /text boxes/i.test(document.querySelector('.ah-body h1')?.textContent ?? ''), null, 'text-boxes topic from F1 over the Text tool');
  await page.keyboard.press('Escape'); // focus is in the panel: closes it
  await waitFor(() => document.querySelector('.ash-help')?.hidden, null, 'panel to close');

  step = 'dialog ?';
  const dTopic = await hev('return data.context["dialog:Author name"];');
  const dTitle = await hev('return data.topics.find((t) => t.id === arg).title;', dTopic);
  await page.click('.menu-btn[data-menu="Edit"]');
  await page.getByText('Author name…', { exact: true }).click();
  await waitFor(() => document.querySelector('.dialog[data-help] .ah-q'), null, 'dialog with data-help and a ? button');
  await page.click('.dialog .ah-q');
  await waitFor((t) => document.querySelector('.ash-help:not([hidden]) .ah-body h1')?.textContent?.trim() === t, dTitle, `panel to show "${dTitle}"`);
  await page.keyboard.press('Escape'); // closes the panel
  await ev('document.querySelector(".dialog [data-help]") ; for (const b of document.querySelectorAll(".dialog-buttons button")) if (/cancel/i.test(b.textContent)) b.click();');
  await waitFor(() => !document.querySelector('.dialog'), null, 'dialog to close');

  step = 'welcome card';
  await ev('await window.api.settingsSet("help.welcomeShown", false);');
  check(await hev('return await H.maybeWelcome();'), 'maybeWelcome() returned false with the pref cleared');
  await waitFor(() => document.querySelector('.ah-welcome'), null, 'welcome card');
  await page.click('.ah-welcome [data-welcome="no"]');
  await waitFor(() => !document.querySelector('.ah-welcome'), null, 'welcome card to go');
  await page.waitForTimeout(150);
  check(!(await hev('return await H.maybeWelcome();')), 'maybeWelcome() showed the card again after Not now');
  check(!(await page.$('.ah-welcome')), 'welcome card is back after Not now');

  step = 'external link';
  // window.api is frozen: the browser shim records openExternal URLs in __ashShim.opened instead of a stub.
  await ev('window.__ashShim.opened.length = 0;');
  await hev('H.openHelp("troubleshooting");');
  await waitFor(() => document.querySelector('.ah-content a.help-ext'), null, 'troubleshooting topic');
  await page.click('.ah-content a.help-ext');
  const opened = await ev('return [...window.__ashShim.opened];');
  check(opened.length === 1 && opened[0].startsWith('https'), `openExternal got ${JSON.stringify(opened)}`);

  step = 'page errors';
  check(!problems.length, `browser problems:\n${problems.join('\n')}`);
  console.log('HELP OK');
} catch (err) {
  console.error(`FAILED at step "${step}": ${err.message}`);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
