import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeMammoth from 'mammoth';

// mammoth's Node build reads {buffer}; its browser build (vendored, what the app runs) reads {arrayBuffer}.
const mammoth = { ...nodeMammoth, convertToHtml: (input, opts) => nodeMammoth.convertToHtml({ buffer: Buffer.from(input.arrayBuffer) }, opts) };
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow } from 'docx';
import { docxToHtml, htmlPage, sheetsToHtml } from '../renderer/ui/office-html.js';

test('docxToHtml: a .docx built with docx becomes a printable page with its heading and table', async () => {
  const cell = (t) => new TableCell({ children: [new Paragraph(t)] });
  const doc = new Document({ sections: [{ children: [
    new Paragraph({ text: 'Pump Schedule <A&B>', heading: HeadingLevel.HEADING_1 }),
    new Paragraph('Body text'),
    new Table({ rows: [new TableRow({ children: [cell('Tag'), cell('Flow')] }), new TableRow({ children: [cell('P-101'), cell('42 l/s')] })] }),
  ] }] });
  const bytes = new Uint8Array(await Packer.toBuffer(doc));
  const { html, landscape } = await docxToHtml(bytes, mammoth, 'Pumps & "co"');
  assert.equal(landscape, false);
  assert.match(html, /<h1>Pump Schedule &lt;A&amp;B&gt;<\/h1>/);
  assert.match(html, /<table>[\s\S]*P-101[\s\S]*42 l\/s[\s\S]*<\/table>/);
  assert.match(html, /<title>Pumps &amp; &quot;co&quot;<\/title>/);
  assert.match(html, /@page \{ size: A4 portrait; margin: 15mm; \}/);
  assert.match(html, /default-src 'none'; img-src data:/);
});

test('htmlPage: landscape pages and bordered tables', () => {
  const html = htmlPage({ title: 't', body: '<p>x</p>', landscape: true });
  assert.match(html, /size: A4 landscape/);
  assert.match(html, /td, th \{ border: 1px solid/);
  assert.match(html, /<body><p>x<\/p><\/body>/);
});

test('sheetsToHtml: two sheets -> two headings, cell values, escaping, numbers right-aligned, ISO dates', () => {
  const { html, landscape } = sheetsToHtml([
    { sheet: 'Pumps <A&B>', data: [['Tag', 'Flow'], ['P-101 <x>', 42.5], ['Start', new Date(Date.UTC(2026, 0, 5))]] },
    { sheet: 'Empty', data: [] },
  ], 'Book & "co"');
  assert.equal(landscape, false);
  assert.equal([...html.matchAll(/<h2>/g)].length, 2);
  assert.match(html, /<h2>Pumps &lt;A&amp;B&gt;<\/h2>/);
  assert.match(html, /<h2>Empty<\/h2>/);
  assert.match(html, /<td>P-101 &lt;x&gt;<\/td>/);
  assert.match(html, /<td style="text-align:right">42\.5<\/td>/);
  assert.match(html, /<td>2026-01-05<\/td>/);
  assert.match(html, /<section style="page-break-before:always"><h2>Empty/);
  assert.doesNotMatch(html, /<section style[^>]*><h2>Pumps/);
  assert.match(html, /<title>Book &amp; &quot;co&quot;<\/title>/);
});

test('sheetsToHtml: landscape only above 8 columns', () => {
  const row = (n) => Array.from({ length: n }, (_, i) => `c${i}`);
  assert.equal(sheetsToHtml([{ sheet: 'S', data: [row(8)] }]).landscape, false);
  const wide = sheetsToHtml([{ sheet: 'A', data: [row(2)] }, { sheet: 'B', data: [row(9)] }]);
  assert.equal(wide.landscape, true);
  assert.match(wide.html, /size: A4 landscape/);
});
