// FreeText rich text: runs survive write -> read (private copy + /RC), and /RC from other programs is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFHexString, PDFString } from 'pdf-lib';
import { DOMParser } from '@xmldom/xmldom';
import { writeAnnotations, readAnnotations } from '../src/core/annots.js';
import { makePdf } from './helpers.js';

const RICH = {
  id: 'r', page: 0, type: 'text', x: 40, y: 50, w: 260, h: 80, font: 'Times', fontSize: 12, color: '#333333', align: 'center',
  text: 'A bold & under gone BIG\nline <2>',
  runs: [
    { text: 'A ' }, { text: 'bold', bold: true, color: '#ff0000' }, { text: ' & ' }, { text: 'under', underline: true },
    { text: ' ' }, { text: 'gone', strike: true }, { text: ' ' }, { text: 'BIG', fontSize: 20 }, { text: '\nline <2>' },
  ],
};
const STYLE = ['text', 'font', 'fontSize', 'bold', 'italic', 'underline', 'strike', 'color', 'align', 'runs'];
const pickStyle = (o) => Object.fromEntries(STYLE.filter((k) => o[k] !== undefined && o[k] !== false).map((k) => [k, o[k]]));

async function annotDict(bytes) {
  const doc = await PDFDocument.load(bytes);
  return { doc, dict: doc.context.lookup(doc.getPage(0).node.Annots().asArray()[0]) };
}
const str = (v) => (v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : undefined);

test('G1: a text box with runs round-trips text, box style and runs; /RC is valid XHTML; /Contents and /DA kept', async () => {
  const out = await writeAnnotations(await makePdf(1, [400, 400]), { add: [RICH] }, { author: 'A', now: '2026-10-07T10:00:00.000Z' });
  const { objects } = await readAnnotations(out);
  assert.equal(objects.length, 1);
  assert.deepEqual(pickStyle(objects[0]), pickStyle(RICH));
  const { dict } = await annotDict(out);
  assert.equal(str(dict.lookup(PDFName.of('Contents'))), RICH.text);
  assert.match(str(dict.lookup(PDFName.of('DA'))), /\/Times-Roman 12 Tf/);
  const rc = str(dict.lookup(PDFName.of('RC')));
  assert.ok(rc.startsWith('<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml"'), rc);
  const errors = [];
  const xml = new DOMParser({ onError: (level, msg) => errors.push(`${level}: ${msg}`) }).parseFromString(rc, 'application/xml');
  assert.deepEqual(errors, [], 'well-formed XML');
  const ps = xml.getElementsByTagName('p');
  assert.equal(ps.length, 2, 'one <p> per paragraph');
  assert.equal([ps[0].textContent, ps[1].textContent].join('\n'), RICH.text);
  assert.match(rc, /font-weight:bold;font-style:normal;color:#ff0000;text-decoration:none">bold</);
  assert.match(rc, /text-decoration:underline">under</);
  assert.match(rc, /text-decoration:line-through">gone</);
  assert.match(rc, /font-size:20pt;[^"]*">BIG</);
  assert.match(rc, /&amp;/);
});

test('G1: box-level underline / strike round-trip and are written to /RC; a plain box writes no /RC', async () => {
  const box = { id: 'u', page: 0, type: 'callout', x: 40, y: 50, w: 200, h: 40, text: 'all of it', underline: true, strike: true, stroke: '#ff0000' };
  const plain = { ...box, id: 'p', y: 200, underline: undefined, strike: undefined };
  const out = await writeAnnotations(await makePdf(1, [400, 400]), { add: [box, plain] }, { author: 'A', now: '2026-10-07T10:00:00.000Z' });
  const { objects } = await readAnnotations(out);
  const u = objects.find((o) => o.id === 'u');
  const p = objects.find((o) => o.id === 'p');
  assert.equal(u.underline, true);
  assert.equal(u.strike, true);
  assert.equal(u.runs, undefined);
  assert.equal(p.underline, undefined);
  assert.equal(p.runs, undefined);
  const doc = await PDFDocument.load(out);
  const dicts = doc.getPage(0).node.Annots().asArray().map((r) => doc.context.lookup(r)).filter((d) => d.lookup(PDFName.of('Subtype')).decodeText() === 'FreeText');
  const rcs = dicts.map((d) => str(d.lookup(PDFName.of('RC'))));
  assert.equal(rcs.filter(Boolean).length, 1);
  assert.match(rcs.find(Boolean), /text-decoration:underline line-through/);
});

test('G1: our /RC alone (private data removed) reads back the same runs', async () => {
  const out = await writeAnnotations(await makePdf(1, [400, 400]), { add: [RICH] }, { author: 'A', now: '2026-10-07T10:00:00.000Z' });
  const { doc, dict } = await annotDict(out);
  const extra = JSON.parse(str(dict.lookup(PDFName.of('ASHStudio'))));
  assert.ok(Array.isArray(extra.runs), 'runs kept in the private data');
  delete extra.runs;
  dict.set(PDFName.of('ASHStudio'), PDFHexString.fromText(JSON.stringify(extra)));
  const { objects } = await readAnnotations(await doc.save());
  assert.deepEqual(pickStyle(objects[0]), pickStyle(RICH));
});

/** A FreeText written by another program: /Contents, /DA, /RC and no private data. */
async function foreign(contents, rc) {
  const doc = await PDFDocument.load(await makePdf(1, [400, 400]));
  const page = doc.getPage(0);
  const annot = doc.context.register(doc.context.obj({
    Type: 'Annot', Subtype: 'FreeText', Rect: [50, 250, 300, 350], NM: PDFHexString.fromText('ft'),
    Contents: PDFHexString.fromText(contents), DA: PDFString.of('/Helv 12 Tf 0 0 0 rg'), RC: PDFHexString.fromText(rc),
  }));
  page.node.addAnnot(annot);
  return (await readAnnotations(await doc.save())).objects[0];
}

const ACROBAT = '<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml" xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/" xfa:APIVersion="Acrobat:11.0.0" xfa:spec="2.0.2" style="font-size:12.0pt;text-align:left;color:#000000;font-weight:normal;font-style:normal;font-family:Helvetica,sans-serif;font-stretch:normal">'
  + '<p dir="ltr"><span style="font-family:Helvetica">Plain <span style="font-size:18pt;color:#0000FF">big blue</span> </span><b>bold</b> <font color="red">red</font> '
  + '<span style="text-decoration:underline line-through">both</span></p>'
  + '<p dir="ltr"><span style="font-family:\'Times New Roman\';font-style:italic;font-size:16px">Fish &amp; chips &#x627;</span></p></body>';

test('G2: an Acrobat-style /RC gives the expected runs', async () => {
  const text = 'Plain big blue bold red both\nFish & chips ا';
  const o = await foreign(text, ACROBAT);
  assert.equal(o.text, text);
  assert.equal(o.font, 'Helvetica');
  assert.equal(o.fontSize, 12);
  assert.deepEqual(o.runs, [
    { text: 'Plain ' }, { text: 'big blue', fontSize: 18, color: '#0000ff' }, { text: ' ' }, { text: 'bold', bold: true }, { text: ' ' },
    { text: 'red', color: '#ff0000' }, { text: ' ' }, { text: 'both', underline: true, strike: true }, { text: '\n' },
    { text: 'Fish & chips ا', font: 'Times', italic: true, fontSize: 12 },
  ].map((r) => (r.fontSize === 12 ? (({ fontSize, ...x }) => x)(r) : r)));
});

test('G2: uniform /RC styles the box without runs; /RC whose text differs from /Contents falls back', async () => {
  const uni = await foreign('all bold', '<body xmlns="http://www.w3.org/1999/xhtml"><p><b style="color:rgb(255,0,0)">all bold</b></p></body>');
  assert.equal(uni.runs, undefined);
  assert.equal(uni.bold, true);
  assert.equal(uni.color, '#ff0000');
  const off = await foreign('the real text', '<body xmlns="http://www.w3.org/1999/xhtml"><p><b>stale text</b></p></body>');
  assert.equal(off.text, 'the real text');
  assert.equal(off.runs, undefined);
  assert.ok(!off.bold, 'box style from /DA');
  assert.equal(off.font, 'Helvetica');
  const broken = await foreign('x y', 'not xhtml at all');
  assert.equal(broken.text, 'x y');
  assert.equal(broken.runs, undefined);
});
