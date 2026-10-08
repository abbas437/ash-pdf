#!/usr/bin/env node
// End-to-end test of ui/tools-markup.js: text highlight on a normal and a /Rotate 90 page (quads vs the
// text-layer box of a word), underline, strikeout, sticky note, comment on a rectangle, save -> pdf.js
// annotations, light + dark popup legibility. Prints "MARKUP OK".
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument, PDFName, StandardFonts, degrees } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = join(root, 'test', 'e2e', 'out');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };
import { pdfjsDoc } from '../helpers.js';

const PARA = ['Supply air ducts shall be insulated with mineral wool', 'and sealed at every joint before the pressure test of', 'each zone is witnessed by the engineer on site today.'];
async function makePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let k = 0; k < 2; k++) {
    const p = doc.addPage([612, 792]);
    p.drawText('Markup target words', { x: 72, y: 600, size: 20, font });
    if (k === 1) p.setRotation(degrees(90));
  }
  // Page 3: a 3-line paragraph, 11 pt Helvetica at 1.2 line spacing (text-selection highlight).
  doc.addPage([612, 792]).drawText(PARA.join('\n'), { x: 72, y: 700, size: 11, lineHeight: 13.2, font });
  return Buffer.from(await doc.save());
}

const server = createServer(async (req, res) => {
  const file = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file)); } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
await mkdir(OUT, { recursive: true });

const problems = [];
const check = (cond, msg) => { if (!cond) throw new Error(msg); };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let step = 'start';
try {
  const pdf = await makePdf();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
  page.on('console', (m) => { if (m.type() === 'error' || /\[bus\]/.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

  const S = 'const app = window.ashStudio, v = app.viewer, bus = app.bus, an = app.annotations, tab = app.state.tabs.find((t) => t.id === app.state.activeId);';
  const AsyncFunction = (async () => {}).constructor;
  const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const objs = () => ev('return tab.objects.map((o) => ({ ...o }));');
  const near = (a, b, msg, tol = 2) => check(Math.abs(a - b) <= tol, `${msg}: got ${a}, expected ${b} (±${tol})`);

  step = 'boot';
  await page.goto(`${base}/renderer/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 10_000 });
  const chooser = page.waitForEvent('filechooser');
  await page.click('#btn-open');
  await (await chooser).setFiles({ name: 'markup.pdf', mimeType: 'application/pdf', buffer: pdf });
  await page.waitForFunction(() => window.ashStudio.state.tabs[0]?.numPages === 3, null, { timeout: 10_000 });
  await ev('v.setZoom(tab, 1);');

  // Word `w` on page i: its text-layer box in page space, its direction, and drag end points.
  const word = (i, w) => ev(`
    v.scrollToPage(tab, arg[0]);
    for (let t = 0; t < 100 && !v.getPageEl(tab, arg[0]).querySelector('.textLayer span'); t++) await new Promise((r) => setTimeout(r, 50));
    const span = [...v.getPageEl(tab, arg[0]).querySelectorAll('.textLayer span')].find((s) => s.textContent.includes(arg[1]));
    const node = span.firstChild, at = node.data.indexOf(arg[1]);
    const rr = (a, b) => { const r = document.createRange(); r.setStart(node, a); r.setEnd(node, b); return r.getBoundingClientRect(); };
    const all = rr(at, at + arg[1].length), f = rr(at, at + 1), l = rr(at + arg[1].length - 1, at + arg[1].length);
    const c = (r) => [r.left + r.width / 2, r.top + r.height / 2];
    const [fx, fy] = c(f), [lx, ly] = c(l), len = Math.hypot(lx - fx, ly - fy), dx = (lx - fx) / len, dy = (ly - fy) / len;
    const ext = (r) => Math.abs(dx) * r.width + Math.abs(dy) * r.height;
    const pts = [[all.left, all.top], [all.right, all.bottom]].map(([x, y]) => v.clientToPage(tab, x, y));
    const p0 = v.clientToPage(tab, fx, fy), p1 = v.clientToPage(tab, lx, ly);
    const tc = await v.getTextContent(tab, arg[0]), it = tc.items.find((t) => t.str.includes(arg[1])), st = tc.styles[it.fontName];
    const [, , tc2, td2, te, tf] = it.transform, vp1 = tab.pages[arg[0]].getViewport({ scale: 1 });
    const ip = [st.ascent, st.descent].map((hh) => vp1.convertToViewportPoint(te + tc2 * hh, tf + td2 * hh));
    return { item: { x0: Math.min(ip[0][0], ip[1][0]), x1: Math.max(ip[0][0], ip[1][0]), y0: Math.min(ip[0][1], ip[1][1]), y1: Math.max(ip[0][1], ip[1][1]) }, box: { x0: Math.min(pts[0].x, pts[1].x), y0: Math.min(pts[0].y, pts[1].y), x1: Math.max(pts[0].x, pts[1].x), y1: Math.max(pts[0].y, pts[1].y) },
      dir: [p1.x - p0.x, p1.y - p0.y], from: [fx - dx * (ext(f) / 2 - 1), fy - dy * (ext(f) / 2 - 1)], to: [lx + dx * (ext(l) / 2 - 1), ly + dy * (ext(l) / 2 - 1)] };`, [i, w]);
  const markWord = async (tool, i, w) => {
    // A second click on the active tool turns it off (back to Select), so click only when it is not active.
    if (!(await page.$(`[data-tool="${tool}"][aria-pressed="true"]`))) await page.click(`[data-tool="${tool}"]`);
    const W = await word(i, w);
    await page.mouse.move(...W.from); await page.mouse.down(); await page.mouse.move(...W.to, { steps: 8 }); await page.mouse.up();
    await page.waitForTimeout(50);
    return { W, o: (await objs()).at(-1) };
  };

  for (const i of [0, 1]) {
    step = `highlight page ${i}`;
    const { W, o } = await markWord('text-highlight', i, 'target');
    check(o?.type === 'textHighlight' && o.page === i && o.quads.length === 1, `page ${i}: highlight object ${JSON.stringify(o)}`);
    const q = o.quads[0], xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
    // Along the text the quad spans the word's characters; across it, the text item's font ascent..descent.
    const [qa0, qa1, qc0, qc1] = i === 0 ? [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)] : [Math.min(...ys), Math.max(...ys), Math.min(...xs), Math.max(...xs)];
    const [wa0, wa1] = i === 0 ? [W.box.x0, W.box.x1] : [W.box.y0, W.box.y1], [ic0, ic1] = i === 0 ? [W.item.y0, W.item.y1] : [W.item.x0, W.item.x1];
    near(qa0, wa0, `page ${i} start`); near(qa1, wa1, `page ${i} end`);
    near(qc0, ic0, `page ${i} glyph top/side`, 0.5); near(qc1, ic1, `page ${i} glyph bottom/side`, 0.5);
    // TL -> TR must run along the text (down the page on /Rotate 90), or underlines land on the wrong edge.
    const tx = q[2] - q[0], ty = q[3] - q[1];
    check((tx * W.dir[0] + ty * W.dir[1]) / (Math.hypot(tx, ty) * Math.hypot(...W.dir)) > 0.99, `page ${i}: quad TL->TR (${tx},${ty}) not along text ${W.dir}`);
    check(o.color === '#ffd400' && o.opacity === 0.4, `page ${i}: highlight style ${o.color}/${o.opacity}`);
  }
  for (const [tool, type, w] of [['underline', 'underline', 'Markup'], ['strikeout', 'strikeout', 'words']]) {
    step = tool;
    const { o } = await markWord(tool, 0, w);
    check(o?.type === type && o.quads?.length === 1, `${tool}: ${JSON.stringify(o)}`);
  }

  step = 'sticky note';
  await ev('v.scrollToPage(tab, 0);'); await frames();
  await page.click('[data-tool="note"]');
  const nc = await ev('const c = v.pageToClient(tab, 0, 300, 300); return [c.clientX, c.clientY];');
  await page.mouse.click(...nc);
  await page.waitForSelector('.mk-popup textarea');
  await page.keyboard.type('Check duct size');
  const legible = () => page.evaluate(() => {
    const lum = (c) => { const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ta = getComputedStyle(document.querySelector('.mk-popup textarea')), au = getComputedStyle(document.querySelector('.mk-popup-author')), pop = getComputedStyle(document.querySelector('.mk-popup'));
    const cr = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
    return Math.min(cr(ta.color, ta.backgroundColor), cr(au.color, pop.backgroundColor));
  });
  const shot = async (name) => { const b = await page.$eval('.mk-popup', (e) => { const r = e.getBoundingClientRect(); return { x: r.x - 40, y: r.y - 40, width: r.width + 80, height: r.height + 80 }; }); await page.screenshot({ path: join(OUT, name), clip: b }); };
  check(await legible() >= 4.5, `light popup contrast ${await legible()}`);
  check(await page.textContent('.mk-popup-author') === 'ASH PDF Studio', 'popup author');
  await shot('markup-note-light.png');
  await page.click('.mk-popup-btn.primary');
  let note = (await objs()).at(-1);
  check(note.type === 'note' && note.note === 'Check duct size' && !(await page.$('.mk-popup')), `note: ${JSON.stringify(note)}`);
  await ev('return app.setTheme("dark", false);');
  await page.click('[data-tool="select"]'); await frames();
  // Re-measure: the options bar differs per tool, so the page may have moved since the note was placed.
  const nc2 = await ev('const c = v.pageToClient(tab, 0, 300, 300); return [c.clientX, c.clientY];');
  await page.mouse.dblclick(nc2[0], nc2[1]);
  await page.waitForSelector('.mk-popup textarea');
  check(await page.inputValue('.mk-popup textarea') === 'Check duct size', 'reopened note text');
  check(await legible() >= 4.5, `dark popup contrast ${await legible()}`);
  await shot('markup-note-dark.png');
  await page.keyboard.press('Escape');
  await ev('return app.setTheme("light", false);');

  step = 'comment on rectangle';
  await page.keyboard.press('r');
  const r0 = await ev('const c = v.pageToClient(tab, 0, 100, 400); return [c.clientX, c.clientY];'), r1 = await ev('const c = v.pageToClient(tab, 0, 200, 470); return [c.clientX, c.clientY];');
  await page.mouse.move(...r0); await page.mouse.down(); await page.mouse.move(...r1, { steps: 5 }); await page.mouse.up();
  const rect = (await objs()).at(-1);
  check(rect.type === 'rect', 'rectangle not drawn');
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('Enter');
  await page.waitForSelector('.mk-popup textarea');
  await page.keyboard.type('Clash with cable tray');
  await page.keyboard.press('Control+Enter');
  check((await objs()).find((o) => o.id === rect.id).note === 'Clash with cable tray', 'rectangle comment not set');

  step = 'save';
  check(await ev('return await app.saveTab(tab, true);'), 'saveTab returned false');
  const out = Uint8Array.from(await ev('return Array.from(await window.api.readFile(tab.path));'));
  const doc = await pdfjsDoc(out);
  const an = [...await (await doc.getPage(1)).getAnnotations(), ...await (await doc.getPage(2)).getAnnotations()];
  const sub = (s) => an.filter((a) => a.subtype === s);
  check(sub('Highlight').length === 2 && sub('Highlight').every((a) => a.quadPoints?.length >= 8), `Highlight: ${JSON.stringify(sub('Highlight').map((a) => a.quadPoints))}`);
  check(sub('Underline').length === 1 && sub('StrikeOut').length === 1, `Underline/StrikeOut: ${an.map((a) => a.subtype)}`);
  check(sub('Text').some((a) => a.contentsObj?.str === 'Check duct size'), 'Text note contents');
  check(sub('Square').some((a) => a.contentsObj?.str === 'Clash with cable tray'), 'rectangle /Contents');
  doc.close();

  step = 'edit after save';
  // Saved objects mirror the file's annotations: still editable, and a second save updates them in place.
  const kindsOf = (list) => list.map((o) => o.type).sort().join();
  check(kindsOf(await objs()) === 'note,rect,strikeout,textHighlight,textHighlight,underline' && !(await ev('return tab.dirty;')), `objects after save: ${kindsOf(await objs())}`);
  await ev('an.update(tab, arg, { note: "Check duct size (revised)" });', note.id);
  check(await ev('return await app.saveTab(tab, true);'), 'second saveTab returned false');
  const doc2 = await pdfjsDoc(Uint8Array.from(await ev('return Array.from(await window.api.readFile(tab.path));')));
  const an2 = [...await (await doc2.getPage(1)).getAnnotations(), ...await (await doc2.getPage(2)).getAnnotations()].filter((a) => a.subtype !== 'Popup');
  doc2.close();
  check(an2.map((a) => a.subtype).sort().join() === 'Highlight,Highlight,Square,StrikeOut,Text,Underline', `second save annotations: ${an2.map((a) => a.subtype)}`);
  check(an2.find((a) => a.subtype === 'Text').contentsObj?.str === 'Check duct size (revised)', 'edited note not saved');
  check(kindsOf(await objs()) === 'note,rect,strikeout,textHighlight,textHighlight,underline', `objects after second save: ${kindsOf(await objs())}`);

  step = 'squiggly (G) + note icon';
  await page.keyboard.press('g');
  check(await ev('return app.state.tool;') === 'squiggly', 'G does not arm the squiggly tool');
  const { o: sq } = await markWord('squiggly', 1, 'words');
  check(sq?.type === 'squiggly' && sq.quads?.length === 1 && (await page.$(`.ann-squiggly polyline`)), `squiggly: ${JSON.stringify(sq)}`);
  await page.mouse.dblclick(...await ev('v.scrollToPage(tab, 0); const c = v.pageToClient(tab, 0, 300, 300); return [c.clientX, c.clientY];'));
  await page.waitForSelector('.mk-popup .mk-popup-icon');
  await page.selectOption('.mk-popup-icon', 'Key');
  await page.click('.mk-popup-btn.primary');
  check((await objs()).find((o) => o.id === note.id).icon === 'Key' && await page.$('.ann-note[data-icon="Key"]'), 'note icon not changed to Key');
  check(await ev('return await app.saveTab(tab, true);'), 'third saveTab returned false');
  const out3 = Uint8Array.from(await ev('return Array.from(await window.api.readFile(tab.path));'));
  const doc3 = await pdfjsDoc(out3);
  const an3 = [...await (await doc3.getPage(1)).getAnnotations(), ...await (await doc3.getPage(2)).getAnnotations()];
  doc3.close();
  check(an3.some((a) => a.subtype === 'Squiggly' && a.quadPoints?.length >= 8), `Squiggly not saved: ${an3.map((a) => a.subtype)}`);
  // pdf.js reports name "NoIcon" for a note with an appearance stream, so read /Name with pdf-lib.
  const pl = await PDFDocument.load(out3), names = pl.getPages()[0].node.Annots().asArray().map((r) => pl.context.lookup(r))
    .filter((d) => d.get(PDFName.of('Subtype')) === PDFName.of('Text')).map((d) => d.get(PDFName.of('Name'))?.decodeText?.() ?? String(d.get(PDFName.of('Name'))));
  check(names.length === 1 && names[0] === 'Key', `note /Name: ${names}`);

  step = 'text selection highlight (3-line paragraph)';
  // Char k of paragraph line L: client rect and page-space x edges (from the text layer).
  const ch = (L, k) => ev(`
    v.scrollToPage(tab, 2);
    for (let t = 0; t < 100 && !v.getPageEl(tab, 2).querySelector('.textLayer span'); t++) await new Promise((r) => setTimeout(r, 50));
    const span = [...v.getPageEl(tab, 2).querySelectorAll('.textLayer span')].find((s) => s.textContent === arg[0]);
    const r = document.createRange(); r.setStart(span.firstChild, arg[1]); r.setEnd(span.firstChild, arg[1] + 1);
    const cr = r.getBoundingClientRect();
    return { cr: { left: cr.left, right: cr.right, top: cr.top, bottom: cr.bottom, w: cr.width }, x0: v.clientToPage(tab, cr.left, cr.top).x, x1: v.clientToPage(tab, cr.right, cr.top).x };`, [PARA[L], k]);
  const pt = (c, f) => [c.cr.left + f * c.cr.w, (c.cr.top + c.cr.bottom) / 2];
  const kA = PARA[0].indexOf('insulated') + 1, kB = PARA[2].indexOf('witnessed') + 2, kW = PARA[1].indexOf('pressure');
  await page.click('[data-tool="select"]');
  await page.click('[data-tool="text-highlight"]');
  const cA = await ch(0, kA), cB = await ch(2, kB);
  const before = (await objs()).length;
  await page.mouse.click(...pt(cA, 0.3));
  await page.waitForTimeout(100);
  check((await objs()).length === before, 'a click without drag created a markup');
  await page.mouse.move(...pt(cA, 0.3)); await page.mouse.down(); await page.mouse.move(...pt(cB, 0.7), { steps: 10 }); await page.mouse.up();
  await page.waitForTimeout(100);
  const th = (await objs()).at(-1);
  check((await objs()).length === before + 1 && th.type === 'textHighlight' && th.page === 2 && th.quads.length === 3, `paragraph highlight: ${JSON.stringify(th)}`);
  const qb = th.quads.map((q) => { const b = { x0: Math.min(q[0], q[2], q[4], q[6]), x1: Math.max(q[0], q[2], q[4], q[6]), y0: Math.min(q[1], q[3], q[5], q[7]), y1: Math.max(q[1], q[3], q[5], q[7]) }; return b; });
  const end = async (L) => (await ch(L, PARA[L].length - 1)).x1, start = async (L) => (await ch(L, 0)).x0;
  // Starts/ends on character boundaries (the pointer was 30 % / 70 % into a character), lines in between in full.
  near(qb[0].x0, cA.x0, 'line 1 start = left edge of the pressed char', 0.6); near(qb[0].x1, await end(0), 'line 1 runs to its last char', 0.6);
  near(qb[1].x0, await start(1), 'line 2 start', 0.6); near(qb[1].x1, await end(1), 'line 2 end', 0.6);
  near(qb[2].x0, await start(2), 'line 3 start', 0.6); near(qb[2].x1, cB.x1, 'line 3 end = right edge of the released char', 0.6);
  // Vertically each quad sits on its own line: >= 80 % of the line's em box (baseline - 0.8 em .. + 0.2 em), no other line.
  const em = [0, 1, 2].map((L) => { const base = 792 - (700 - 13.2 * L); return [base - 0.8 * 11, base + 0.2 * 11]; });
  const ov = (q, [a, b]) => Math.max(0, Math.min(q.y1, b) - Math.max(q.y0, a));
  qb.forEach((q, L) => {
    check(ov(q, em[L]) >= 0.8 * 11, `quad ${L + 1} covers ${ov(q, em[L]).toFixed(2)} pt of its line (${q.y0.toFixed(2)}..${q.y1.toFixed(2)})`);
    check(em.every((r, M) => M === L || ov(q, r) === 0), `quad ${L + 1} overlaps another line`);
  });

  step = 'text highlight is not movable';
  await page.click('[data-tool="select"]'); await frames();
  const mid = await ev('const c = v.pageToClient(tab, 2, arg[0], arg[1]); return [c.clientX, c.clientY];', [(qb[1].x0 + qb[1].x1) / 2, (qb[1].y0 + qb[1].y1) / 2]);
  await page.mouse.click(...mid);
  check((await ev('return an.getSelection(tab);')).join() === th.id, 'click does not select the text highlight');
  check(await page.$('.ann-selection path.ann-bbox') && !(await page.$('.ann-selection rect.ann-bbox')), 'selection outline is not drawn along the quads');
  await page.mouse.move(...mid); await page.mouse.down(); await page.mouse.move(mid[0] + 60, mid[1] + 40, { steps: 6 }); await page.mouse.up();
  await page.keyboard.press('ArrowRight');
  check(JSON.stringify((await objs()).find((o) => o.id === th.id).quads) === JSON.stringify(th.quads), 'text highlight moved by a drag / arrow key');

  step = 'double-click highlights a word';
  await page.click('[data-tool="text-highlight"]');
  const w0 = await ch(1, kW), w1 = await ch(1, kW + 'pressure'.length - 1);
  await page.waitForTimeout(600);
  await page.mouse.dblclick(...pt(await ch(1, kW + 3), 0.5));
  await page.waitForTimeout(100);
  const wh = (await objs()).at(-1);
  check(wh.id !== th.id && wh.type === 'textHighlight' && wh.quads.length === 1, `double-click word: ${JSON.stringify(wh)}`);
  const wq = wh.quads[0];
  near(Math.min(wq[0], wq[4]), w0.x0, 'word start', 0.6); near(Math.max(wq[2], wq[6]), w1.x1, 'word end', 0.6);

  check(!problems.length, `browser problems:\n${problems.join('\n')}`);
  console.log('MARKUP OK');
} catch (err) {
  console.error(`FAILED at step "${step}": ${err.message}`);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
