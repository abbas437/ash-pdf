// File > Export to Word, built-in engine (renderer/ui/docx-export.js): a pdf-lib PDF -> .docx in Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import JSZip from 'jszip';
import * as docx from 'docx';
import { pdfToDocx } from '../renderer/ui/docx-export.js';
import { rgbaPixels } from '../renderer/ui/table-extract.js';
import { pdfjsDoc } from './helpers.js';

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

// A small opaque PNG (40 x 30, red) made with @napi-rs/canvas.
function png() {
  const c = createCanvas(40, 30);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#c00'; ctx.fillRect(0, 0, 40, 30);
  return c.toBuffer('image/png');
}

const encode = async (img) => {
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  const id = ctx.createImageData(img.width, img.height);
  id.data.set(rgbaPixels(img));
  ctx.putImageData(id, 0, 0);
  return { data: new Uint8Array(c.toBuffer('image/png')), type: 'png' };
};

export async function fixture() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold), reg = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Pump Station Report', { x: 72, y: 720, size: 20, font: bold });
  const para = (lines, y) => lines.forEach((t, k) => page.drawText(t, { x: 72, y: y - k * 14, size: 11, font: reg }));
  para(['The first paragraph describes the scope of the works and the pumps', 'installed at the inlet works of the plant.'], 680);
  para(['The second paragraph lists the test results of each pump in the', 'table below, measured at the rated duty point.'], 630);
  const head = ['Tag', 'Flow', 'Head', 'Power', 'Speed', 'Eff', 'NPSH', 'Noise'];
  const data = [['P1', '120', '35', '18.5', '1480', '78', '4.2', '72'], ['P2', '125', '34', '18.5', '1475', '79', '4.1', '71']];
  [head, ...data].forEach((row, r) => row.forEach((cell, c) => page.drawText(cell, { x: 72 + c * 60, y: 570 - r * 18, size: 10, font: r ? reg : bold })));
  const img = await doc.embedPng(png());
  page.drawImage(img, { x: 72, y: 380, width: 120, height: 90 });
  page.drawRectangle({ x: 500, y: 60, width: 1, height: 1, color: rgb(1, 1, 1) });
  return doc.save();
}

test('pdfToDocx: heading, paragraphs, an 8-column table and an image -> document.xml', async () => {
  const pdf = await pdfjsDoc(await fixture());
  try {
    const bytes = await pdfToDocx(pdf, { OPS: pdfjs.OPS, encode, docxLib: docx });
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file('word/document.xml').async('string');
    const text = xml.replace(/<[^>]+>/g, '');
    assert.match(text, /Pump Station Report/);
    assert.match(xml, /<w:pStyle w:val="Heading1"\/>/);
    assert.match(text, /The first paragraph describes the scope of the works and the pumps installed at the inlet works of the plant\./);
    assert.match(text, /The second paragraph lists the test results of each pump in the table below, measured at the rated duty point\./);
    // The two paragraphs stay two paragraphs.
    assert.ok(!/pumps installed.*The second/.test(xml.match(/<w:p>.*?<\/w:p>|<w:p .*?<\/w:p>/gs).find((p) => /The first/.test(p))));
    const tbl = xml.match(/<w:tbl>.*?<\/w:tbl>/s)?.[0];
    assert.ok(tbl, 'a w:tbl');
    assert.equal(tbl.match(/<w:gridCol /g).length, 8);
    const cells = [...tbl.matchAll(/<w:tc>.*?<\/w:tc>/gs)].map((m) => m[0].replace(/<[^>]+>/g, ''));
    assert.deepEqual(cells.slice(0, 8), ['Tag', 'Flow', 'Head', 'Power', 'Speed', 'Eff', 'NPSH', 'Noise']);
    assert.deepEqual(cells.slice(8, 16), ['P1', '120', '35', '18.5', '1480', '78', '4.2', '72']);
    assert.match(tbl, /<w:tblHeader\/>/);
    assert.equal(xml.match(/<w:drawing>/g)?.length, 1);
    assert.ok(Object.keys(zip.files).some((f) => /^word\/media\/.+\.png$/.test(f)));
    // Reading order: heading, paragraphs, table, image.
    const at = (s) => xml.indexOf(s);
    assert.ok(at('Pump Station Report') < at('The first') && at('The second') < at('<w:tbl>') && at('</w:tbl>') < at('<w:drawing>'));
    // Page size from the PDF page (Letter, twips).
    assert.match(xml, /<w:pgSz w:w="12240" w:h="15840"/);
  } finally { pdf.close(); }
});
