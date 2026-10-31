import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { detectImage, isSvgText, unsupportedImage, svgRasterSize, fileKind, textToHtml } from '../renderer/ui/image-import-lib.js';
import { imagesToPdf } from '../src/core/pdfOps.js';

const enc = (s) => new TextEncoder().encode(s);
const PNG_1x1 = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'));

test('detectImage: magic bytes win over the name', () => {
  assert.equal(detectImage(PNG_1x1, 'x.jpg'), 'png');
  assert.equal(detectImage(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0), 'x.png'), 'jpeg');
  assert.equal(detectImage(enc('GIF89a\x01\x00\x01\x00'), 'a.bin'), 'gif');
  assert.equal(detectImage(enc('RIFF\x10\x00\x00\x00WEBPVP8 '), ''), 'webp');
  assert.equal(detectImage(enc('BM\x3a\x00\x00\x00\x00\x00\x00\x00\x36\x00\x00\x00'), ''), 'bmp');
});

test('detectImage: SVG with BOM, XML declaration, comments and doctype', () => {
  assert.equal(detectImage(enc('<svg xmlns="http://www.w3.org/2000/svg"/>')), 'svg');
  assert.equal(detectImage(enc('﻿  <?xml version="1.0" encoding="UTF-8"?>\n<!-- made by hand -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">\n<svg width="10" height="10"></svg>')), 'svg');
  assert.equal(isSvgText('<?xml version="1.0"?><html></html>'), false);
  assert.equal(isSvgText('<svgfoo/>'), false);
  assert.equal(isSvgText('hello <svg>'), false);
});

test('detectImage: extension only as a fallback; unknown is null with a user message', () => {
  assert.equal(detectImage(enc('????'), 'Logo.WEBP'), 'webp');
  assert.equal(detectImage(enc('????'), 'pic.jpg'), 'jpeg');
  assert.equal(detectImage(enc('PK\x03\x04'), 'a.zip'), null);
  assert.equal(unsupportedImage('a.zip'), 'a.zip is not a supported image (PNG, JPEG, GIF, WebP, BMP or SVG)');
});

test('svgRasterSize: ×2, longest side capped at 4000, 1000 px without a size', () => {
  assert.deepEqual(svgRasterSize(100, 50), { width: 200, height: 100 });
  assert.deepEqual(svgRasterSize(3000, 1500), { width: 4000, height: 2000 });
  assert.deepEqual(svgRasterSize(0, 0), { width: 1000, height: 1000 });
});

test('fileKind: by extension or MIME type', () => {
  assert.equal(fileKind({ name: 'a.PDF' }), 'pdf');
  assert.equal(fileKind({ name: 'x', type: 'application/pdf' }), 'pdf');
  assert.equal(fileKind({ name: 'p.svg' }), 'image');
  assert.equal(fileKind({ name: '', type: 'image/gif' }), 'image');
  assert.equal(fileKind({ name: 'r.docx' }), 'doc');
  assert.equal(fileKind({ name: 'notes.md' }), 'doc');
  assert.equal(fileKind({ name: 'a.zip', type: 'application/zip' }), null);
});

test('textToHtml: escapes markup, keeps Arabic, a dir=auto paragraph per line', () => {
  const html = textToHtml('a < b && c\r\nمرحبا بالعالم\n\n<script>', 'Notes & co');
  assert.match(html, /<p dir="auto"[^>]*>a &lt; b &amp;&amp; c<\/p>/);
  assert.match(html, /<p dir="auto"[^>]*>مرحبا بالعالم<\/p>/);
  assert.match(html, /<p dir="auto"[^>]*>&lt;script&gt;<\/p>/);
  assert.equal((html.match(/<p dir="auto"/g) ?? []).length, 4);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /<title>Notes &amp; co<\/title>/);
  assert.match(html, /white-space:pre-wrap/);
});

test('imagesToPdf: [w, h] page size, orientation follows the image, centred, never scaled up', async () => {
  const out = await imagesToPdf([{ bytes: PNG_1x1, type: 'png' }], { pageSize: [595, 842], margin: 18 });
  const doc = await PDFDocument.load(out);
  const [page] = doc.getPages();
  assert.deepEqual([page.getWidth(), page.getHeight()], [595, 842]);
  // The 1×1 image is drawn at its own size (never scaled up), centred on the page.
  assert.match(contentOps(doc, page), /^1 0 0 1 297 420\.5 cm$/m);
  const wide = await imagesToPdf([{ bytes: makeWide(), type: 'png' }], { pageSize: [595, 842], margin: 18 });
  const p2 = (await PDFDocument.load(wide)).getPages()[0];
  assert.deepEqual([p2.getWidth(), p2.getHeight()], [842, 595]);
  await assert.rejects(imagesToPdf([{ bytes: PNG_1x1, type: 'png' }], { pageSize: [0, 10] }), RangeError);
  await assert.rejects(imagesToPdf([{ bytes: PNG_1x1, type: 'png' }], { pageSize: 'A9' }), RangeError);
});

function contentOps(doc, page) {
  const zlib = globalThis.process.getBuiltinModule('node:zlib');
  const c = page.node.Contents(), refs = c.asArray ? c.asArray() : [c];
  return refs.map((r) => { const st = doc.context.lookup(r) ?? r; const raw = Buffer.from(st.contents ?? st.getContents?.() ?? []); try { return zlib.inflateSync(raw).toString('latin1'); } catch { return raw.toString('latin1'); } }).join('\n');
}
// A 2×1 PNG (wider than tall), built with pdf-lib's PNG-free path: zlib from Node.
function makeWide() {
  const zlib = globalThis.process.getBuiltinModule('node:zlib');
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.from([0, 0, 255]);
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
