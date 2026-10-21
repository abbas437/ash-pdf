// Inline images in a rich-text box ("in line with text"): image runs, layout, drawing, save -> read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFDict, PDFRawStream, PDFString, decodePDFRawStream } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import { normalizeRuns, insertText, insertImage, deleteRange, isImageRun, OBJ_CHAR } from '../src/core/richtext.js';
import { layoutRich, flattenObjects } from '../src/core/annotate.js';
import { toRichContents } from '../src/core/richxhtml.js';
import { writeAnnotations, readAnnotations } from '../src/core/annots.js';
import { makePdf, pageContent } from './helpers.js';

const PNG_1x1 = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
const IMG = (key, w = 50, h = 40) => ({ text: OBJ_CHAR, img: key, imgW: w, imgH: h });
const BOX = { id: 't', page: 0, type: 'text', x: 40, y: 50, w: 200, h: 60, fontSize: 12, color: '#000000' };
const withImage = (over = {}) => ({
  ...BOX,
  text: `Hi ${OBJ_CHAR} there`,
  runs: [{ text: 'Hi ' }, IMG('pic-1'), { text: ' there' }],
  images: { 'pic-1': { bytes: PNG_1x1, mime: 'image/png' } },
  ...over,
});

/** A PNG of random pixels (incompressible): > 20 kB. */
function noisyPng(w = 100, h = 70) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  const data = ctx.createImageData(w, h);
  let seed = 12345;
  for (let i = 0; i < data.data.length; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    data.data[i] = i % 4 === 3 ? 255 : seed >>> 24;
  }
  ctx.putImageData(data, 0, 0);
  return new Uint8Array(c.toBuffer('image/png'));
}

const readOne = async (bytes) => { const r = await readAnnotations(bytes); return (r.objects ?? r)[0]; };
const firstAnnot = (doc) => doc.context.lookup(doc.getPage(0).node.Annots().asArray()[0]);

// ---------------------------------------------------------------- runs

test('normalizeRuns keeps image runs (style keys dropped), never merges two adjacent images or an image with text', () => {
  const obj = { type: 'text', text: `a${OBJ_CHAR}${OBJ_CHAR}b` };
  const runs = normalizeRuns([{ text: 'a' }, { ...IMG('k1'), bold: true }, IMG('k2', 10, 8), { text: 'b' }], obj);
  assert.deepEqual(runs, [{ text: 'a' }, IMG('k1'), IMG('k2', 10, 8), { text: 'b' }]);
  // the same image key twice in a row: still two runs (one character each)
  assert.equal(normalizeRuns([IMG('k1'), IMG('k1')], { type: 'text', text: OBJ_CHAR + OBJ_CHAR }).length, 2);
  // a lone image run is not "uniform": the runs are kept
  assert.deepEqual(normalizeRuns([IMG('k1')], { type: 'text', text: OBJ_CHAR }), [IMG('k1')]);
});

test('normalizeRuns keeps an image run whose key has no image (runs still add up to the text); layout keeps its space', () => {
  const obj = { ...BOX, text: `a${OBJ_CHAR}`, runs: [{ text: 'a' }, IMG('missing', 30, 10)], images: {} };
  assert.deepEqual(normalizeRuns(obj.runs, obj), obj.runs);
  const fr = layoutRich(obj, 200).lines[0].fragments;
  assert.equal(fr[1].img, 'missing');
  assert.equal(fr[1].width, 30);
});

test('a U+FFFC in an ordinary run (no img key) stays text', () => {
  const runs = normalizeRuns([{ text: `x${OBJ_CHAR}`, bold: true }], { type: 'text', text: `x${OBJ_CHAR}` });
  assert.deepEqual(runs, [{ text: `x${OBJ_CHAR}`, bold: true }]);
  assert.equal(isImageRun(runs[0]), false);
});

test('insertImage adds one U+FFFC image run; text typed after it is a text run with the style before the image', () => {
  const obj = { type: 'text', text: 'ab', runs: [{ text: 'ab', bold: true }] };
  const r1 = insertImage(obj, 1, 'k', 20, 10);
  assert.equal(r1.text, `a${OBJ_CHAR}b`);
  assert.deepEqual(r1.runs, [{ text: 'a', bold: true }, IMG('k', 20, 10), { text: 'b', bold: true }]);
  const r2 = insertText({ ...obj, ...r1 }, 2, 'XY');
  assert.equal(r2.text, `a${OBJ_CHAR}XYb`);
  assert.deepEqual(r2.runs, [{ text: 'a', bold: true }, IMG('k', 20, 10), { text: 'XYb', bold: true }]);
  // an image at the very start: typed text after it takes the first text character's style
  const r3 = insertText({ type: 'text', text: `${OBJ_CHAR}b`, runs: [IMG('k'), { text: 'b', italic: true }] }, 1, 'Z');
  assert.deepEqual(r3.runs, [IMG('k'), { text: 'Zb', italic: true }]);
});

test('deleteRange removes an image run cleanly and the neighbours merge again', () => {
  const obj = { type: 'text', text: `ab${OBJ_CHAR}cd`, runs: [{ text: 'ab' }, IMG('k'), { text: 'cd' }] };
  const r = deleteRange(obj, 2, 3);
  assert.equal(r.text, 'abcd');
  assert.equal(r.runs, undefined); // uniform again
  const r2 = deleteRange(obj, 1, 4);
  assert.equal(r2.text, 'ad');
  assert.equal(r2.runs, undefined);
});

test('toRichContents leaves inline images out of /RC', () => {
  const rc = toRichContents(withImage());
  assert.ok(!rc.includes(OBJ_CHAR));
  assert.match(rc, />Hi <\/span>/);
});

// ---------------------------------------------------------------- layout

test('layoutRich: a 50x40 image in a 12pt line raises the line; its bottom sits on the baseline', () => {
  const plain = layoutRich({ ...BOX, text: 'Hi there' }, 200).lines[0];
  const L = layoutRich(withImage(), 200);
  assert.equal(L.lines.length, 1);
  const line = L.lines[0];
  const img = line.fragments.find((f) => f.img);
  assert.equal(img.img, 'pic-1');
  assert.equal(img.width, 50);
  assert.equal(img.height, 40);
  assert.equal(img.top + img.height, line.baseline); // bottom on the baseline
  const descent = plain.top + plain.height - plain.baseline - (plain.height - 12 * 1.2) / 2; // >= the font descent
  assert.ok(line.height >= 40 + descent - 1e-9, `line height ${line.height}`);
  assert.ok(line.height > plain.height);
  assert.ok(img.top >= line.top - 1e-9, 'the image fits in its line');
  // the image advances the pen by its width
  const [a, , c] = line.fragments;
  assert.equal(img.x, a.x + a.width);
  assert.equal(c.x, img.x + img.width);
  assert.equal(L.height, line.height);
});

test('layoutRich: an image wider than the rest of the line wraps (a break opportunity even without a space)', () => {
  const obj = { ...BOX, text: `Hello${OBJ_CHAR}`, runs: [{ text: 'Hello' }, IMG('k', 80, 10)] };
  const L = layoutRich(obj, 100);
  assert.equal(L.lines.length, 2);
  assert.deepEqual(L.lines[0].fragments.map((f) => f.text), ['Hello']);
  assert.equal(L.lines[1].fragments[0].img, 'k');
  assert.equal(L.lines[1].fragments[0].x, 0);
});

test('layoutRich: an image wider than the box is never split (one fragment, one line)', () => {
  const obj = { ...BOX, text: OBJ_CHAR, runs: [IMG('k', 150, 10)] };
  const L = layoutRich(obj, 100);
  assert.equal(L.lines.length, 1);
  assert.equal(L.lines[0].fragments.length, 1);
  assert.equal(L.lines[0].fragments[0].width, 150);
});

// ---------------------------------------------------------------- drawing

test('flattenObjects draws an inline image with Do; a key without an image draws nothing', async () => {
  const out = await flattenObjects(await makePdf(1), [withImage()]);
  assert.match(await pageContent(out), / Do\b/);
  const blank = await flattenObjects(await makePdf(1), [withImage({ images: {} })]);
  assert.doesNotMatch(await pageContent(blank), / Do\b/);
});

test('a text box with a PNG gets an appearance with an Image XObject and a Do', async () => {
  const out = await writeAnnotations(await makePdf(1), { add: [withImage()] });
  const doc = await PDFDocument.load(out);
  const ap = firstAnnot(doc).lookup(PDFName.of('AP')).lookup(PDFName.of('N'));
  const xo = ap.dict.lookup(PDFName.of('Resources')).lookup(PDFName.of('XObject'));
  assert.ok(xo instanceof PDFDict);
  const subtypes = xo.entries().map(([, v]) => doc.context.lookup(v).dict.lookup(PDFName.of('Subtype')).decodeText());
  assert.ok(subtypes.includes('Image'), `XObjects: ${subtypes}`);
  const content = Buffer.from(ap instanceof PDFRawStream ? decodePDFRawStream(ap).decode() : ap.getContents()).toString('latin1');
  assert.match(content, / Do\b/);
});

// ---------------------------------------------------------------- save -> read

test('save -> read restores text, image runs and image bytes; the private JSON stays small', async () => {
  const big = noisyPng();
  assert.ok(big.length > 20000, `test image is ${big.length} bytes`);
  const o = withImage({
    text: `A ${OBJ_CHAR}${OBJ_CHAR} B`,
    runs: [{ text: 'A ', bold: true }, IMG('pic-1', 50, 40), IMG('big', 30, 20), { text: ' B' }],
    images: { 'pic-1': { bytes: PNG_1x1, mime: 'image/png' }, big: { bytes: big, mime: 'image/png' }, unused: { bytes: PNG_1x1, mime: 'image/png' } },
  });
  const out = await writeAnnotations(await makePdf(1), { add: [o] });
  const d = firstAnnot(await PDFDocument.load(out));
  const extra = d.lookup(PDFName.of('ASHStudio')).decodeText();
  assert.ok(extra.length < 2000, `ASHStudio is ${extra.length} chars`);
  assert.equal(d.lookup(PDFName.of('Contents')).decodeText(), 'A  B'); // other viewers: the text without placeholders
  const back = await readOne(out);
  assert.equal(back.text, o.text);
  assert.deepEqual(back.runs, normalizeRuns(o.runs, o));
  assert.deepEqual(Object.keys(back.images).sort(), ['big', 'pic-1']); // only the images in use are saved
  assert.deepEqual(back.images.big.bytes, big);
  assert.equal(back.images.big.mime, 'image/png');
  assert.deepEqual(back.images['pic-1'].bytes, PNG_1x1);
  // and it saves again unchanged
  const again = await readOne(await writeAnnotations(await makePdf(1), { add: [{ ...back, id: 't2' }] }));
  assert.equal(again.text, o.text);
  assert.deepEqual(again.runs, back.runs);
  assert.deepEqual(again.images.big.bytes, big);
});

test('a box without images keeps /Contents = text and no ASHImages', async () => {
  const out = await writeAnnotations(await makePdf(1), { add: [{ ...BOX, text: 'plain' }] });
  const d = firstAnnot(await PDFDocument.load(out));
  assert.equal(d.lookup(PDFName.of('ASHImages')), undefined);
  const back = await readOne(out);
  assert.equal(back.text, 'plain');
  assert.equal(back.images, undefined);
});

// ---------------------------------------------------------------- damaged / recompressed private streams

/** `bytes` with the first annotation's private stream (`get(dict)` -> its ref) replaced by `make(doc)`. */
async function rewriteStream(bytes, get, make) {
  const doc = await PDFDocument.load(bytes);
  doc.context.assign(get(firstAnnot(doc)), make(doc));
  return doc.save();
}
const picRef = (key) => (d) => d.lookup(PDFName.of('ASHImages')).get(PDFName.of(key));

test('a damaged picture stream is dropped on read; moving the box and saving again does not throw', async () => {
  const out = await writeAnnotations(await makePdf(1), { add: [withImage()] });
  const bad = await rewriteStream(out, picRef('pic-1'), (doc) => doc.context.stream(new Uint8Array([1, 2, 3]), { Mime: PDFString.of('image/svg+xml') }));
  const back = await readOne(bad);
  assert.deepEqual(back.images, {});
  assert.equal(back.text, `Hi ${OBJ_CHAR} there`); // the run (and its blank slot) stays
  const moved = await writeAnnotations(bad, { update: [{ ...back, x: back.x + 10 }] });
  assert.equal((await readOne(moved)).x, back.x + 10);
  // PNG bytes declared as JPEG: also dropped (pdf-lib would refuse them)
  const lie = await rewriteStream(out, picRef('pic-1'), (doc) => doc.context.stream(PNG_1x1, { Mime: PDFString.of('image/jpeg') }));
  assert.deepEqual((await readOne(lie)).images, {});
});

test('flattenObjects and writeAnnotations skip a picture that cannot be embedded (slot left blank)', async () => {
  for (const im of [{ bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' }, { bytes: new Uint8Array([1, 2, 3]), mime: 'image/svg+xml' }]) {
    const o = withImage({ images: { 'pic-1': im } });
    const out = await flattenObjects(await makePdf(1), [o]);
    assert.doesNotMatch(await pageContent(out), / Do\b/);
    await writeAnnotations(await makePdf(1), { add: [o] });
  }
});

test('a FlateDecode-recompressed picture stream reads back as the original PNG', async () => {
  const out = await writeAnnotations(await makePdf(1), { add: [withImage()] });
  const flate = await rewriteStream(out, picRef('pic-1'), (doc) => doc.context.flateStream(PNG_1x1, { Mime: PDFString.of('image/png') }));
  const d = firstAnnot(await PDFDocument.load(flate));
  assert.equal(d.lookup(PDFName.of('ASHImages')).lookup(PDFName.of('pic-1')).dict.lookup(PDFName.of('Filter')).decodeText(), 'FlateDecode');
  const back = await readOne(flate);
  assert.deepEqual(back.images['pic-1'], { bytes: PNG_1x1, mime: 'image/png' });
});

test('a FlateDecode-recompressed image stamp stream reads back as the original PNG', async () => {
  const stamp = { id: 's', page: 0, type: 'image', x: 40, y: 50, w: 40, h: 40, bytes: PNG_1x1, mime: 'image/png' };
  const out = await writeAnnotations(await makePdf(1), { add: [stamp] });
  const flate = await rewriteStream(out, (d) => d.get(PDFName.of('ASHImage')), (doc) => doc.context.flateStream(PNG_1x1, { Mime: PDFString.of('image/png') }));
  const back = await readOne(flate);
  assert.equal(back.type, 'image');
  assert.deepEqual(back.bytes, PNG_1x1);
});

test('a literal U+FFFC in a box without pictures saves exactly as before (in /Contents, no private copy)', async () => {
  const o = { ...BOX, text: `a${OBJ_CHAR}b` };
  const out = await writeAnnotations(await makePdf(1), { add: [o] });
  const d = firstAnnot(await PDFDocument.load(out));
  assert.equal(d.lookup(PDFName.of('Contents')).decodeText(), `a${OBJ_CHAR}b`);
  assert.equal(d.lookup(PDFName.of('ASHStudio')), undefined);
  assert.equal((await readOne(out)).text, `a${OBJ_CHAR}b`);
});
