// repairFromXref / loadPdfDoc: a pdf-lib load must follow the cross-reference data, not the last
// copy of an object in file order. Fixtures are assembled byte by byte below (no binary files).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { loadPdfDoc } from '../src/core/internal.js';
import { repairFromXref } from '../src/core/xref-repair.js';
import { listFields } from '../src/core/forms.js';
import { writeAnnotations } from '../src/core/annots.js';
import { makePdf, pdfjsDoc } from './helpers.js';

const OPTS = { author: 'Test', now: new Date('2026-01-02T03:04:05Z') };
const toBytes = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

const CATALOG = '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] /DA (/Helv 0 Tf 0 g) >> >>';
const PAGES = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
const PAGE = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Annots [4 0 R] >>';
const field = (v) => `<< /Type /Annot /Subtype /Widget /FT /Tx /T (Name) /V (${v}) /Rect [10 10 100 30] /P 3 0 R /F 4 /DA (/Helv 0 Tf 0 g) >>`;

/** Minimal PDF writer: tracks object offsets; the caller writes the xref data. */
class Writer {
  constructor() {
    this.s = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
    this.off = {};
  }
  obj(n, body) {
    this.off[n] = this.s.length;
    this.s += `${n} 0 obj\n${body}\nendobj\n`;
  }
  stream(n, dict, data) {
    this.obj(n, `<< ${dict} /Length ${data.length} >>\nstream\n${data}\nendstream`);
  }
  objStm(n, members) {
    let head = '';
    let data = '';
    for (const [m, body] of members) {
      head += `${m} ${data.length} `;
      data += `${body}\n`;
    }
    this.stream(n, `/Type /ObjStm /N ${members.length} /First ${head.length}`, head + data);
  }
  /** Cross-reference stream n; rows: [[objNum, type, a, b]] (contiguous runs become /Index pairs). */
  xrefStream(n, rows, extra = '') {
    const at = this.s.length;
    rows = [...rows, [n, 1, at, 0]].sort((x, y) => x[0] - y[0]);
    const index = [];
    for (const [m] of rows) {
      const last = index[index.length - 1];
      if (last && last[0] + last[1] === m) last[1]++;
      else index.push([m, 1]);
    }
    const be = (v, w) => Array.from({ length: w }, (_, k) => String.fromCharCode((v >>> (8 * (w - 1 - k))) & 0xff)).join('');
    const data = rows.map(([, t, a, b]) => be(t, 1) + be(a, 4) + be(b, 2)).join('');
    const size = Math.max(...rows.map((r) => r[0])) + 1;
    this.stream(n, `/Type /XRef /Size ${size} /W [1 4 2] /Index [${index.flat().join(' ')}] ${extra}`, data);
    return at;
  }
  /** Classic table; entries: [[objNum, offset|null(free)]]. Returns the table's offset. */
  table(entries, trailer) {
    const at = this.s.length;
    entries = [...entries].sort((x, y) => x[0] - y[0]);
    this.s += 'xref\n';
    for (let i = 0; i < entries.length; ) {
      let j = i;
      while (j + 1 < entries.length && entries[j + 1][0] === entries[j][0] + 1) j++;
      this.s += `${entries[i][0]} ${j - i + 1}\n`;
      for (let k = i; k <= j; k++) {
        const [m, o] = entries[k];
        this.s += o === null ? `${String(0).padStart(10, '0')} ${m === 0 ? 65535 : 1} f\r\n` : `${String(o).padStart(10, '0')} 00000 n\r\n`;
      }
      i = j + 1;
    }
    this.s += `trailer\n<< ${trailer} >>\n`;
    return at;
  }
  end(startxref) {
    this.s += `startxref\n${startxref}\n%%EOF\n`;
    return toBytes(this.s);
  }
}

/**
 * The bug's shape: field 4 lives in object stream 5 (V NEW, the xref's copy); object stream 6,
 * unreferenced (free in the xref) and AFTER 5 in the file, holds an old copy of 4 (V OLD).
 */
function bugShape({ startxref, prevLoop = false } = {}) {
  const w = new Writer();
  w.obj(1, CATALOG);
  w.obj(2, PAGES);
  w.obj(3, PAGE);
  w.objStm(5, [[4, field('NEW')]]);
  w.objStm(6, [[4, field('OLD')]]);
  const rows = [[0, 0, 0, 65535], [1, 1, w.off[1], 0], [2, 1, w.off[2], 0], [3, 1, w.off[3], 0], [4, 2, 5, 0], [5, 1, w.off[5], 0], [6, 0, 0, 1]];
  const at = w.s.length;
  w.xrefStream(7, rows, `/Root 1 0 R${prevLoop ? ` /Prev ${at}` : ''}`);
  return w.end(startxref ?? at);
}

async function pdfjsValue(bytes) {
  const doc = await pdfjsDoc(bytes);
  try {
    const annots = await (await doc.getPage(1)).getAnnotations();
    return annots.find((a) => a.fieldName === 'Name')?.fieldValue;
  } finally {
    await doc.close();
  }
}

const libValue = (doc) => doc.getForm().getTextField('Name').getText();
const objCount = (doc) => doc.context.enumerateIndirectObjects().length;

describe('xref repair: stale object stream after the current one', () => {
  test('fixture reproduces the bug: pdf.js reads NEW, plain pdf-lib reads OLD', async () => {
    const bytes = bugShape();
    assert.equal(await pdfjsValue(bytes), 'NEW');
    assert.equal(libValue(await PDFDocument.load(bytes, { updateMetadata: false })), 'OLD');
  });

  test('listFields and the shared loader read the current value', async () => {
    const bytes = bugShape();
    const fields = await listFields(bytes);
    assert.deepEqual(fields.map((f) => [f.name, f.value]), [['Name', 'NEW']]);
    assert.equal(fields[0].pageIndex, 0);
    assert.equal(libValue(await loadPdfDoc(bytes, { updateMetadata: false })), 'NEW');
  });

  test('a save through writeAnnotations keeps the current value', async () => {
    const out = await writeAnnotations(bugShape(), { add: [{ id: 'u', page: 0, type: 'underline', quads: [[40, 80, 140, 80, 40, 94, 140, 94]] }] }, OPTS);
    assert.equal(await pdfjsValue(out), 'NEW');
    assert.equal(libValue(await loadPdfDoc(out, { updateMetadata: false })), 'NEW');
    assert.equal(libValue(await PDFDocument.load(out, { updateMetadata: false })), 'NEW');
  });
});

describe('xref repair leaves other files as pdf-lib loaded them', () => {
  async function same(bytes) {
    const plain = await PDFDocument.load(bytes, { updateMetadata: false });
    const fixed = await PDFDocument.load(bytes, { updateMetadata: false });
    assert.equal(repairFromXref(fixed, bytes), 0);
    assert.equal(objCount(fixed), objCount(plain));
    assert.equal(fixed.getPageCount(), plain.getPageCount());
    return { plain, fixed };
  }

  test('classic xref table file', async () => {
    const w = new Writer();
    w.obj(1, CATALOG);
    w.obj(2, PAGES);
    w.obj(3, PAGE);
    w.obj(4, field('ONLY'));
    const at = w.table([[0, null], [1, w.off[1]], [2, w.off[2]], [3, w.off[3]], [4, w.off[4]]], '/Size 5 /Root 1 0 R');
    const bytes = w.end(at);
    const { plain, fixed } = await same(bytes);
    assert.equal(libValue(fixed), 'ONLY');
    assert.equal(libValue(plain), 'ONLY');
    assert.equal(libValue(await loadPdfDoc(bytes)), 'ONLY');
  });

  test('pdf-lib saved file with object streams and a form', async () => {
    const doc = await PDFDocument.load(await makePdf(3));
    doc.getForm().createTextField('Name').setText('SAVED');
    doc.getForm().getTextField('Name').addToPage(doc.getPage(1), { x: 10, y: 10 });
    const bytes = await doc.save({ useObjectStreams: true });
    const { plain, fixed } = await same(bytes);
    assert.equal(libValue(fixed), 'SAVED');
    assert.equal(libValue(plain), 'SAVED');
    assert.equal((await loadPdfDoc(bytes)).getPageCount(), 3);
  });
});

describe('xref repair never makes a damaged file worse', () => {
  const asLoaded = async (bytes) => {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const before = objCount(doc);
    assert.doesNotThrow(() => assert.equal(repairFromXref(doc, bytes), 0));
    assert.equal(objCount(doc), before);
    assert.equal(libValue(doc), 'OLD'); // exactly what pdf-lib loaded
    assert.equal(libValue(await loadPdfDoc(bytes, { updateMetadata: false })), 'OLD');
  };

  test('startxref pointing nowhere', async () => asLoaded(bugShape({ startxref: 999999 })));
  test('startxref pointing at a non-xref object', async () => asLoaded(bugShape({ startxref: 15 })));
  test('no startxref at all', async () => {
    const s = String.fromCharCode(...bugShape());
    await asLoaded(toBytes(s.slice(0, s.lastIndexOf('startxref'))));
  });
  test('/Prev loop', async () => asLoaded(bugShape({ prevLoop: true })));
  test('non-bytes input', async () => {
    const doc = await PDFDocument.load(bugShape(), { updateMetadata: false });
    assert.equal(repairFromXref(doc, null), 0);
  });
});

describe('xref repair follows /Prev and hybrid /XRefStm', () => {
  test('/Prev chain: the older section holds the object stream entry', async () => {
    const w = new Writer();
    w.obj(1, CATALOG);
    w.obj(2, PAGES);
    w.obj(3, PAGE);
    w.objStm(5, [[4, field('NEW')]]);
    w.objStm(6, [[4, field('OLD')]]);
    const rows = [[0, 0, 0, 65535], [1, 1, w.off[1], 0], [2, 1, w.off[2], 0], [3, 1, w.off[3], 0], [4, 2, 5, 0], [5, 1, w.off[5], 0], [6, 0, 0, 1]];
    const x1 = w.xrefStream(7, rows, '/Root 1 0 R');
    // incremental update: the catalog rewritten, a new xref stream with /Prev
    w.obj(1, CATALOG);
    const x2 = w.xrefStream(8, [[1, 1, w.off[1], 0]], `/Root 1 0 R /Prev ${x1}`);
    const bytes = w.end(x2);
    assert.equal(await pdfjsValue(bytes), 'NEW');
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    assert.equal(libValue(doc), 'OLD');
    assert.equal(repairFromXref(doc, bytes), 1);
    assert.equal(libValue(doc), 'NEW');
    assert.deepEqual((await listFields(bytes)).map((f) => f.value), ['NEW']);
  });

  test('hybrid file: classic table with /XRefStm', async () => {
    const w = new Writer();
    w.obj(1, CATALOG);
    w.obj(2, PAGES);
    w.obj(3, PAGE);
    w.objStm(5, [[4, field('NEW')]]);
    w.objStm(6, [[4, field('OLD')]]);
    const xs = w.xrefStream(7, [[4, 2, 5, 0], [5, 1, w.off[5], 0]]);
    // the table leaves out the compressed object 4; only the /XRefStm stream lists it
    const at = w.table([[0, null], [1, w.off[1]], [2, w.off[2]], [3, w.off[3]], [5, w.off[5]], [6, null], [7, xs]], `/Size 8 /Root 1 0 R /XRefStm ${xs}`);
    const bytes = w.end(at);
    assert.equal(await pdfjsValue(bytes), 'NEW');
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    assert.equal(libValue(doc), 'OLD');
    assert.equal(repairFromXref(doc, bytes), 1);
    assert.equal(libValue(doc), 'NEW');
  });

  test('a top-level object whose stale copy sits in a later object stream', async () => {
    const w = new Writer();
    w.obj(1, CATALOG);
    w.obj(2, PAGES);
    w.obj(3, PAGE);
    w.obj(4, field('NEW'));
    w.objStm(6, [[4, field('OLD')]]);
    const at = w.table([[0, null], [1, w.off[1]], [2, w.off[2]], [3, w.off[3]], [4, w.off[4]], [6, null]], '/Size 7 /Root 1 0 R');
    const bytes = w.end(at);
    assert.equal(await pdfjsValue(bytes), 'NEW');
    assert.equal(libValue(await loadPdfDoc(bytes, { updateMetadata: false })), 'NEW');
  });
});
