// Compare revisions report: the overlay PDF of a Rev.00 / Rev.01 compare (renderer/ui/compare-lib.js
// makes the composite images and change regions). One output page per compared page:
//   1. the composite image, full page (unchanged ink grey, removed red, added green);
//   2. a legend strip, top-left, as page content: "Compare: <older> -> <newer> . <date>", the three
//      swatches, and a note for a page found in one revision only / text changes left unmarked;
//   3. one dashed Square annotation per change region (/BS /S /D /D [3 2], /C red, green or orange,
//      /Contents "Change 3: added and removed" plus the text that changed inside it, /AP /N drawn);
//   4. one small Square per added/removed text phrase outside every region (at most MAX_TEXT_MARKS
//      per page; the rest are counted in the legend).
// Plus /Title "Compare <older> to <newer>", /Producer ASH PDF Studio, and a flat outline with one
// bookmark per page that has changes, named by its source page ("Page 5 – 2 changes", "Page 5 (older 4)
// – …", "Older page 4 – …") when the page carries newerPage / olderPage, else by its output page.
//
// Fonts: like the rest of the core, no font file is embedded. The legend uses Helvetica (WinAnsi);
// file names go through sanitizeText, so a character it cannot encode (Arabic, CJK...) is drawn as
// "?". The arrow is the Symbol font's "→". /Title and /Contents are Unicode strings and keep the
// names as they are.
import { PDFName, PDFHexString, PDFString, StandardFonts, rgb } from 'pdf-lib';
import { createPdf } from './internal.js';
import { sanitizeText } from './annotate.js';

/** Swatch colours of the legend: the same RGB as COLORS in renderer/ui/compare-lib.js. */
export const LEGEND_COLORS = Object.freeze({ same: [160, 160, 160], removed: [220, 0, 0], added: [0, 160, 0] });
/** /C of a change rectangle by its kind. */
export const MARK_COLORS = Object.freeze({ removed: [0.86, 0, 0], added: [0, 0.63, 0], mixed: [1, 0.55, 0] });
export const MAX_TEXT_MARKS = 200;

const N = (s) => PDFName.of(s);
const BORDER_W = 1;
const DASH = [3, 2];
const PAD = 2; // points between a region's ink bounds and its rectangle
const LEGEND = { margin: 6, pad: 4, size: 7.5, lead: 10, swatch: 7 };
const PHRASES = 3; // phrases quoted per side in a region's /Contents
const PHRASE_LEN = 60;
const ERROR_LEN = 120; // characters of a failure reason kept on the legend

/** 'removed' when removed >= 2 x added, 'added' when added >= 2 x removed, else 'mixed'. */
export function changeKind({ added = 0, removed = 0 }) {
  if (removed > 0 && removed >= 2 * added) return 'removed';
  if (added > 0 && added >= 2 * removed) return 'added';
  return 'mixed';
}

const KIND_WORDS = { removed: 'removed', added: 'added', mixed: 'added and removed' };
const r3 = (n) => Math.round(n * 1000) / 1000;
const pad2 = (n) => String(n).padStart(2, '0');
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const quote = (list) => list.slice(0, PHRASES).map((t) => `"${clip(oneLine(t.text), PHRASE_LEN)}"`).join(', ') + (list.length > PHRASES ? `, and ${list.length - PHRASES} more` : '');

function toDate(d) {
  const v = d instanceof Date ? d : d === undefined ? new Date() : new Date(d);
  if (Number.isNaN(v.getTime())) throw new RangeError(`meta.date is not a date: ${d}`);
  return v;
}

/** Local calendar date and time, as the user reads it on the legend. */
const showDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

function checkPage(p, i) {
  if (!p || !(p.width > 0) || !(p.height > 0) || !Number.isFinite(p.width) || !Number.isFinite(p.height)) throw new RangeError(`pages[${i}]: width and height must be positive numbers`);
  if (p.status !== 'error' && (!p.image || !(p.image.bytes instanceof Uint8Array) || !['png', 'jpeg', 'jpg'].includes(p.image.type))) throw new TypeError(`pages[${i}].image must be {bytes: Uint8Array, type: 'png' | 'jpeg'}`);
  if (p.status !== undefined && !['compared', 'added', 'removed', 'error'].includes(p.status)) throw new RangeError(`pages[${i}].status must be 'compared', 'added', 'removed' or 'error'`);
  if (p.regions !== undefined && !Array.isArray(p.regions)) throw new TypeError(`pages[${i}].regions must be an array`);
}

const boxOf = (b) => ({ x: +b.x, y: +b.y, w: Math.max(0, +b.w || 0), h: Math.max(0, +b.h || 0) });
const isBox = (b) => b && [b.x, b.y, b.w, b.h].every(Number.isFinite);
/** A text box belongs to a region when its centre lies inside the region's rectangle (with PAD). */
const inside = (b, r) => {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  return cx >= r.x - PAD && cx <= r.x + r.w + PAD && cy >= r.y - PAD && cy <= r.y + r.h + PAD;
};

/**
 * A dashed Square annotation around the top-left box `b` (points) on a page of height `ph`, with
 * its /AP /N form. Returns the annotation's ref.
 */
function squareAnnot(doc, page, b, pw, ph, color, contents, nm, date) {
  const ctx = doc.context;
  const x0 = Math.max(0, b.x - PAD), x1 = Math.min(pw, b.x + b.w + PAD);
  const yTop = Math.max(0, b.y - PAD), yBot = Math.min(ph, b.y + b.h + PAD);
  // At least the border's own width plus a point, so a hairline change still gets a visible box.
  const w = Math.max(x1 - x0, BORDER_W + 1), h = Math.max(yBot - yTop, BORDER_W + 1);
  const rect = [r3(x0), r3(ph - yTop - h), r3(x0 + w), r3(ph - yTop)];
  const [rw, rh] = [r3(rect[2] - rect[0]), r3(rect[3] - rect[1])];
  const half = BORDER_W / 2;
  const ap = ctx.stream(
    `q ${BORDER_W} w [${DASH.join(' ')}] 0 d ${color.join(' ')} RG ${half} ${half} ${r3(rw - BORDER_W)} ${r3(rh - BORDER_W)} re S Q`,
    { Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: [0, 0, rw, rh], Resources: {} },
  );
  const pdfDate = PDFString.fromDate(date);
  const dict = ctx.obj({
    Type: 'Annot', Subtype: 'Square', Rect: rect, P: page.ref, F: 4,
    Border: [0, 0, BORDER_W], BS: { Type: 'Border', W: BORDER_W, S: 'D', D: DASH }, C: color,
  });
  dict.set(N('T'), PDFHexString.fromText('Compare'));
  dict.set(N('Contents'), PDFHexString.fromText(contents));
  dict.set(N('NM'), PDFHexString.fromText(nm));
  dict.set(N('M'), pdfDate);
  dict.set(N('CreationDate'), pdfDate);
  dict.set(N('AP'), ctx.obj({ N: ctx.register(ap) }));
  return ctx.register(dict);
}

/** Longest prefix of `s` (with "…") whose width at the legend size is <= max. */
function fit(font, s, max) {
  const width = (t) => font.widthOfTextAtSize(t, LEGEND.size);
  if (width(s) <= max) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (width(`${s.slice(0, mid)}…`) <= max) lo = mid; else hi = mid - 1;
  }
  return `${s.slice(0, lo)}…`;
}

function drawLegend(page, fonts, { older, newer, when, notes }) {
  const { helv, sym } = fonts;
  const { margin, pad, size, lead, swatch } = LEGEND;
  const { width: pw, height: ph } = page.getSize();
  const avail = Math.max(40, pw - 2 * margin - 2 * pad);
  const wH = (t) => helv.widthOfTextAtSize(t, size);
  const arrow = '→';
  const head = 'Compare: ', tail = ` · ${when}`;
  const fixed = wH(head) + wH(tail) + sym.widthOfTextAtSize(arrow, size) + 2 * wH(' ');
  // Names share what is left of the line; a short one leaves its unused half to the other.
  const room = Math.max(40, avail - fixed);
  const half = room / 2;
  const a = fit(helv, older, wH(newer) < half ? room - wH(newer) : half);
  const b = fit(helv, newer, room - wH(a));
  const keys = [['same', 'unchanged'], ['removed', 'removed'], ['added', 'added']];
  const notesFit = notes.map((n) => fit(helv, n, avail));
  const line1 = fixed + wH(a) + wH(b);
  const line2 = keys.reduce((s, [, t]) => s + swatch + 3 + wH(t) + 10, -10);
  const boxW = Math.min(avail, Math.max(line1, line2, ...notesFit.map(wH))) + 2 * pad;
  const lines = 2 + notesFit.length;
  const boxH = lines * lead + 2 * pad - (lead - size) + 2;
  const top = ph - margin;
  page.drawRectangle({ x: margin, y: top - boxH, width: boxW, height: boxH, color: rgb(1, 1, 1), borderColor: rgb(0.45, 0.45, 0.45), borderWidth: 0.5 });
  const black = rgb(0, 0, 0);
  let y = top - pad - size;
  let x = margin + pad;
  const text = (t, font = helv) => {
    page.drawText(t, { x, y, size, font, color: black });
    x += font.widthOfTextAtSize(t, size);
  };
  text(`${head}${a} `);
  text(arrow, sym);
  text(` ${b}${tail}`);
  y -= lead;
  x = margin + pad;
  for (const [k, label] of keys) {
    const [r, g, bl] = LEGEND_COLORS[k].map((c) => c / 255);
    page.drawRectangle({ x, y: y - 0.5, width: swatch, height: swatch, color: rgb(r, g, bl) });
    x += swatch + 3;
    text(label);
    x += 10;
  }
  for (const n of notesFit) {
    y -= lead;
    x = margin + pad;
    text(n);
  }
}

const pageNo = (v) => (Number.isInteger(v) && v > 0 ? v : null);

/** "Page 5", "Page 5 (older 4)" or "Older page 4" from the source pages; "Page <i + 1>" without them. */
function sourceLabel(p, i) {
  const n = pageNo(p.newerPage), o = pageNo(p.olderPage);
  if (n === null && o === null) return `Page ${i + 1}`;
  if (n === null) return `Older page ${o}`;
  return o === null || o === n ? `Page ${n}` : `Page ${n} (older ${o})`;
}

/** Flat /Outlines: one item per [title, page ref], each going to the whole page. */
function writeOutline(doc, items) {
  if (!items.length) return;
  const ctx = doc.context;
  const root = ctx.obj({ Type: 'Outlines', Count: items.length });
  const rootRef = ctx.register(root);
  const refs = items.map(([title, pageRef]) => {
    const d = ctx.obj({ Parent: rootRef, Dest: [pageRef, N('Fit')] });
    d.set(N('Title'), PDFHexString.fromText(title));
    return [ctx.register(d), d];
  });
  refs.forEach(([, d], k) => {
    if (k > 0) d.set(N('Prev'), refs[k - 1][0]);
    if (k < refs.length - 1) d.set(N('Next'), refs[k + 1][0]);
  });
  root.set(N('First'), refs[0][0]);
  root.set(N('Last'), refs[refs.length - 1][0]);
  doc.catalog.set(N('Outlines'), rootRef);
}

/**
 * The compare overlay PDF, built a page at a time so a large set is never held whole:
 *   const report = await createCompareReport(meta);
 *   await report.addPage(page);   // per page, in order: the image is embedded now
 *   const bytes = await report.finish();   // bookmarks, then the saved PDF
 * page = {width, height (points), image: {bytes, type: 'png'|'jpeg'}, regions?: [{x, y, w, h, added,
 *   removed}] (top-left points; added/removed = changed pixel counts), status?: 'compared'|'added'|'removed'|'error' (error: no image needed; `error` = short reason, the page is blank with the legend and a note),
 *   textChanges?: {added: [{text, box: {x, y, w, h}}], removed: [...]} (boxes in the same frame as regions),
 *   newerPage?, olderPage? (1-based source page numbers: legend line "Page 5 of <newer>" and bookmark names)}
 * meta = {older: {name}, newer: {name}, date?: Date | ISO string (default now)}
 * addPage embeds the image at once (a PNG is decoded and re-compressed there), so the report keeps only the
 * embedded stream and the caller need not keep page.image.bytes.
 */
export async function createCompareReport(meta = {}) {
  const olderName = oneLine(meta.older?.name) || 'older revision';
  const newerName = oneLine(meta.newer?.name) || 'newer revision';
  const date = toDate(meta.date);
  const stamp = date.getTime().toString(36);
  const doc = await createPdf();
  doc.setTitle(`Compare ${olderName} to ${newerName}`);
  doc.setSubject('Compare revisions: unchanged grey, removed red, added green');
  doc.setCreationDate(date);
  doc.setModificationDate(date);
  const fonts = { helv: await doc.embedFont(StandardFonts.Helvetica), sym: await doc.embedFont(StandardFonts.Symbol) };
  const legendNames = { older: sanitizeText(olderName), newer: sanitizeText(newerName), when: showDate(date) };
  const outline = [];
  let i = 0, done = false;

  async function addPage(p) {
    if (done) throw new Error('createCompareReport: addPage after finish');
    checkPage(p, i);
    const pw = p.width, ph = p.height;
    const page = doc.addPage([pw, ph]);
    const at = i++;
    if (p.status === 'error') {
      // A page that could not be compared: blank, with the legend and the reason only.
      const reason = clip(oneLine(sanitizeText(p.error)) || 'unknown error', ERROR_LEN);
      drawLegend(page, fonts, { ...legendNames, notes: [`${sourceLabel(p, at)} could not be compared: ${reason}`] });
      outline.push([`${sourceLabel(p, at)} – not compared`, page.ref]);
      return;
    }
    const img = p.image.type === 'png' ? await doc.embedPng(p.image.bytes) : await doc.embedJpg(p.image.bytes);
    await img.embed(); // now, not at save: pdf-lib then drops its decoded copy of the image
    page.drawImage(img, { x: 0, y: 0, width: pw, height: ph });

    const regions = (p.regions ?? []).filter(isBox).map((r) => ({ ...boxOf(r), added: +r.added || 0, removed: +r.removed || 0 }));
    const texts = ['added', 'removed'].flatMap((side) => (p.textChanges?.[side] ?? [])
      .filter((t) => t && isBox(t.box) && oneLine(t.text))
      .map((t) => ({ side, text: oneLine(t.text), box: boxOf(t.box) })));
    const annots = [];
    let n = 0;
    for (const r of regions) {
      const kind = changeKind(r);
      const mine = texts.filter((t) => inside(t.box, r));
      mine.forEach((t) => { t.placed = true; });
      const lines = [`Change ${++n}: ${KIND_WORDS[kind]}`];
      const add = mine.filter((t) => t.side === 'added'), rem = mine.filter((t) => t.side === 'removed');
      if (add.length || rem.length) {
        lines.push(`Text: ${[add.length ? `added ${quote(add)}` : '', rem.length ? `removed ${quote(rem)}` : ''].filter(Boolean).join('; ')}`);
      }
      annots.push(squareAnnot(doc, page, r, pw, ph, MARK_COLORS[kind], lines.join('\n'), `compare-${stamp}-${at + 1}-${n}`, date));
    }
    const loose = texts.filter((t) => !t.placed);
    for (const t of loose.slice(0, MAX_TEXT_MARKS)) {
      annots.push(squareAnnot(doc, page, t.box, pw, ph, MARK_COLORS[t.side], `Change ${++n}: text ${t.side}\nText: "${clip(t.text, 200)}"`, `compare-${stamp}-${at + 1}-${n}`, date));
    }
    if (annots.length) page.node.set(N('Annots'), doc.context.obj(annots));

    const notes = [];
    const np = pageNo(p.newerPage), op = pageNo(p.olderPage);
    if (np !== null || op !== null) {
      notes.push([np !== null ? `Page ${np} of ${legendNames.newer}` : '', op !== null && op !== np ? `page ${op} of ${legendNames.older}` : ''].filter(Boolean).join(', ').replace(/^p/, 'P'));
    }
    if (p.status === 'added') notes.push('Page only in the newer revision');
    else if (p.status === 'removed') notes.push('Page only in the older revision');
    const over = loose.length - MAX_TEXT_MARKS;
    if (over > 0) notes.push(`${over} more text change${over === 1 ? '' : 's'} on this page not marked`);
    drawLegend(page, fonts, { ...legendNames, notes });

    const what = p.status === 'added' ? 'only in the newer revision' : p.status === 'removed' ? 'only in the older revision' : null;
    const count = annots.length + Math.max(0, over);
    if (what || count) outline.push([`${sourceLabel(p, at)} – ${what ?? `${count} change${count === 1 ? '' : 's'}`}`, page.ref]);
  }

  async function finish() {
    if (done) throw new Error('createCompareReport: finish called twice');
    if (i === 0) throw new TypeError('createCompareReport: no pages added');
    done = true;
    writeOutline(doc, outline);
    return doc.save();
  }

  return { addPage, finish, get pageCount() { return i; } };
}

/** The whole report at once: createCompareReport + addPage for each of `pages` + finish. */
export async function buildCompareReport(pages, meta = {}) {
  if (!Array.isArray(pages) || pages.length === 0) throw new TypeError('buildCompareReport expects a non-empty pages array');
  pages.forEach(checkPage);
  const report = await createCompareReport(meta);
  for (const p of pages) await report.addPage(p);
  return report.finish();
}
