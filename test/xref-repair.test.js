// repairFromXref / loadPdfDoc: a pdf-lib load must follow the cross-reference data, not the last
// copy of an object in file order. Fixtures are assembled byte by byte below (no binary files).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, deflateRawSync, constants as zlibConstants } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { PDFDocument, PDFDict, PDFName, PDFRef } from 'pdf-lib';
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
  /**
   * Cross-reference stream n; rows: [[objNum, type, a, b]] (contiguous runs become /Index pairs).
   * png: Flate-compressed with PNG predictor 12, every row filtered Up.
   */
  xrefStream(n, rows, extra = '', { png = false } = {}) {
    const at = this.s.length;
    rows = [...rows, [n, 1, at, 0]].sort((x, y) => x[0] - y[0]);
    const index = [];
    for (const [m] of rows) {
      const last = index[index.length - 1];
      if (last && last[0] + last[1] === m) last[1]++;
      else index.push([m, 1]);
    }
    const be = (v, w) => Array.from({ length: w }, (_, k) => String.fromCharCode((v >>> (8 * (w - 1 - k))) & 0xff)).join('');
    let data = rows.map(([, t, a, b]) => be(t, 1) + be(a, 4) + be(b, 2)).join('');
    const size = Math.max(...rows.map((r) => r[0])) + 1;
    if (png) {
      const raw = toBytes(data);
      const up = [];
      for (let r = 0; r < rows.length; r++) {
        up.push(2); // PNG filter type Up: each byte minus the one above it
        for (let i = 0; i < 7; i++) up.push((raw[r * 7 + i] - (r ? raw[(r - 1) * 7 + i] : 0)) & 0xff);
      }
      data = deflateSync(Uint8Array.from(up)).toString('latin1');
      extra += ' /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 7 >>';
    }
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
function bugShape({ startxref, prevLoop = false, extra = '', png = false, after } = {}) {
  const w = new Writer();
  w.obj(1, CATALOG);
  w.obj(2, PAGES);
  w.obj(3, PAGE);
  w.objStm(5, [[4, field('NEW')]]);
  w.objStm(6, [[4, field('OLD')]]);
  const rows = [[0, 0, 0, 65535], [1, 1, w.off[1], 0], [2, 1, w.off[2], 0], [3, 1, w.off[3], 0], [4, 2, 5, 0], [5, 1, w.off[5], 0], [6, 0, 0, 1]];
  const at = w.s.length;
  w.xrefStream(7, rows, `/Root 1 0 R${prevLoop ? ` /Prev ${at}` : ''} ${extra}`, { png });
  return w.end(startxref ?? after?.(w) ?? at);
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
    assert.equal(await repairFromXref(fixed, bytes), 0);
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
    assert.equal(await repairFromXref(doc, bytes), 0);
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
    assert.equal(await repairFromXref(doc, null), 0);
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
    assert.equal(await repairFromXref(doc, bytes), 1);
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
    assert.equal(await repairFromXref(doc, bytes), 1);
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

describe('xref repair on hostile files', () => {
  /** bugShape, startxref pointing at an xref stream with /Index `index`, hidden in stream 8's data so pdf-lib's own parser skips it. */
  const hiddenXref = (index) => bugShape({
    after: (w) => {
      w.stream(8, '', `9 0 obj\n<< /Type /XRef /Size 10 /W [0 4 2] /Index [${index}] /Length 12 >>\nstream\n${'\0'.repeat(12)}\nendstream\nendobj`);
      return w.s.indexOf('9 0 obj', w.off[8]);
    },
  });

  for (const index of ['0 3000000000 0 -2999999999', '0 -1', '0 3000000000', '0 1.5', '9007199254740991 1']) {
    test(`/Index [${index}]: gives up at once`, async () => {
      const bytes = hiddenXref(index);
      const plain = await PDFDocument.load(bytes, { updateMetadata: false });
      const t0 = performance.now();
      const doc = await loadPdfDoc(bytes, { updateMetadata: false });
      assert.ok(performance.now() - t0 < 1000, 'loadPdfDoc took over 1 s');
      assert.equal(libValue(doc), 'OLD'); // exactly what pdf-lib loaded
      assert.equal(objCount(doc), objCount(plain));
    });
  }

  test('a classic table with a negative subsection count gives up (not skipped to read /Prev)', async () => {
    // `0 -1` is a well-formed pair of integers; read as a count it would be skipped and the rest of
    // the table, then /Prev (the good xref stream), followed as if the table were sound. Hidden in
    // stream 8's data, where pdf-lib's own parser does not look.
    const bytes = bugShape({
      after: (w) => {
        w.stream(8, '', `xref\n0 -1\n1 1\n${String(w.off[1]).padStart(10, '0')} 00000 n\r\ntrailer\n<< /Size 8 /Root 1 0 R /Prev ${w.off[7]} >>\n`);
        return w.s.indexOf('xref', w.off[8]);
      },
    });
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    assert.equal(libValue(doc), 'OLD');
    assert.equal(await repairFromXref(doc, bytes), 0);
    assert.equal(libValue(doc), 'OLD');
  });

  /** Asserts `run` leaves the doc as pdf-lib loaded it within `ms`, with an RSS growth under 200 MB. */
  async function cheaply(bytes, { ms = 1500, value = 'OLD', fixed = 0 } = {}) {
    const plain = await PDFDocument.load(bytes, { updateMetadata: false });
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const rss0 = process.memoryUsage().rss;
    const t0 = performance.now();
    assert.equal(await repairFromXref(doc, bytes), fixed);
    const took = performance.now() - t0;
    const grew = process.memoryUsage().rss - rss0;
    assert.ok(took < ms, `repair took ${took.toFixed(0)} ms`);
    assert.ok(grew < 200 * 2 ** 20, `RSS grew by ${(grew / 2 ** 20).toFixed(0)} MB`);
    assert.equal(libValue(doc), value);
    if (!fixed) assert.equal(objCount(doc), objCount(plain));
  }

  /** zlib data inflating to `mib` MiB of zeros, built without holding them: one sync-flushed 1 MiB chunk repeated, then an empty final block. */
  const zeros = (mib) => {
    const chunk = deflateRawSync(Buffer.alloc(1 << 20), { finishFlush: zlibConstants.Z_SYNC_FLUSH });
    return Buffer.concat([Buffer.from([0x78, 0x9c]), ...Array(mib).fill(chunk), Buffer.from([0x03, 0x00, 0, 0, 0, 0])]);
  };
  /** ~5 KB that inflate, through two Flate filters, to 512 MiB. */
  const bomb = () => deflateSync(zeros(512)).toString('latin1');

  test('a hidden xref stream that inflates to 512 MB (double Flate): gives up fast, no memory growth', async () => {
    const data = bomb();
    const bytes = bugShape({
      after: (w) => {
        w.stream(8, '', `9 0 obj\n<< /Type /XRef /Size 10 /W [1 4 2] /Filter [/FlateDecode /FlateDecode] /Length ${data.length} >>\nstream\n${data}\nendstream\nendobj`);
        return w.s.indexOf('9 0 obj', w.off[8]);
      },
    });
    assert.ok(bytes.length < 20000);
    await cheaply(bytes);
  });

  test('a hidden object stream that inflates to 512 MB (double Flate): no memory growth, the repair still works', async () => {
    const data = bomb();
    const bytes = bugShape({
      after: (w) => {
        w.stream(8, '', `9 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter [/FlateDecode /FlateDecode] /Length ${data.length} >>\nstream\n${data}\nendstream\nendobj`);
        return undefined;
      },
    });
    await cheaply(bytes, { value: 'NEW', fixed: 1 });
  });

  test('chained hidden xref streams of millions of entries each: gives up fast', async () => {
    // each section: ~4 KB of Flate data, 4M one-byte rows; /Prev chains them, all hidden in stream 8
    const rows = deflateSync(Buffer.alloc(4_000_000)).toString('latin1');
    const bytes = bugShape({
      after: (w) => {
        let body = '';
        const at = [];
        for (let k = 0; k < 3; k++) {
          at.push(body.length);
          const prev = k < 2 ? ` /Prev @${k + 1}@` : '';
          body += `${20 + k} 0 obj\n<< /Type /XRef /Size 4000000 /W [0 1 0]${prev} /Filter /FlateDecode /Length ${rows.length} >>\nstream\n${rows}\nendstream\nendobj\n`;
        }
        const base = w.s.length + `8 0 obj\n<<  /Length ${body.length} >>\nstream\n`.length;
        body = body.replace(/@(\d)@/g, (_, k) => String(base + at[k]).padStart(3, '0'));
        w.stream(8, '', body);
        assert.equal(w.s.slice(base, base + 6), '20 0 o');
        return base;
      },
    });
    assert.ok(bytes.length < 40000);
    await cheaply(bytes);
  });

  test('megabytes of /Type /ObjStm tokens in a content stream: the scan stays fast', async () => {
    const unit = `/Type /ObjStm ${'x'.repeat(17)}\n`; // 32 bytes: ~98k tokens, under the give-up cap
    const bytes = bugShape({
      after: (w) => {
        w.stream(8, '', unit.repeat((3 << 20) / unit.length));
        return undefined;
      },
    });
    assert.ok(bytes.length > 3e6);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    assert.equal(libValue(doc), 'OLD');
    const t0 = performance.now();
    const fixed = await repairFromXref(doc, bytes);
    const ms = performance.now() - t0;
    assert.ok(ms < 1500, `repair took ${ms.toFixed(0)} ms`);
    assert.equal(fixed, 1);
    assert.equal(libValue(doc), 'NEW');
  });
});

describe('xref repair: entry kinds and stream shapes', () => {
  test('a referenced object stream that also holds a stale copy of another object', async () => {
    const w = new Writer();
    w.obj(1, CATALOG);
    w.obj(2, PAGES);
    w.obj(3, PAGE);
    w.objStm(5, [[4, field('NEW')]]);
    w.objStm(6, [[8, '<< /Live true >>'], [4, field('OLD')]]); // 8 is live here, 4 is not
    const rows = [[0, 0, 0, 65535], [1, 1, w.off[1], 0], [2, 1, w.off[2], 0], [3, 1, w.off[3], 0], [4, 2, 5, 0], [5, 1, w.off[5], 0], [6, 1, w.off[6], 0], [8, 2, 6, 0]];
    const bytes = w.end(w.xrefStream(7, rows, '/Root 1 0 R'));
    assert.equal(await pdfjsValue(bytes), 'NEW');
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    assert.equal(libValue(doc), 'OLD');
    assert.equal(await repairFromXref(doc, bytes), 1);
    assert.equal(libValue(doc), 'NEW');
    const live = doc.context.lookup(PDFRef.of(8, 0));
    assert.ok(live instanceof PDFDict && live.has(PDFName.of('Live')));
  });

  test('an xref stream entry of type 3 is a null reference: an older section does not win', async () => {
    const w = new Writer();
    w.obj(1, CATALOG);
    w.obj(2, PAGES);
    w.obj(3, PAGE);
    w.objStm(5, [[4, field('NEW')]]);
    w.objStm(6, [[4, field('OLD')]]);
    const rows = [[0, 0, 0, 65535], [1, 1, w.off[1], 0], [2, 1, w.off[2], 0], [3, 1, w.off[3], 0], [4, 2, 5, 0], [5, 1, w.off[5], 0], [6, 0, 0, 1]];
    const x1 = w.xrefStream(7, rows, '/Root 1 0 R');
    const x2 = w.xrefStream(8, [[4, 3, 0, 0]], `/Root 1 0 R /Prev ${x1}`);
    const bytes = w.end(x2);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const before = objCount(doc);
    assert.equal(await repairFromXref(doc, bytes), 0);
    assert.equal(libValue(doc), 'OLD'); // left alone
    assert.equal(objCount(doc), before);
  });

  test('a PNG-predicted (Up rows) compressed xref stream', async () => {
    const bytes = bugShape({ png: true });
    assert.equal(await pdfjsValue(bytes), 'NEW');
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    assert.equal(libValue(doc), 'OLD');
    assert.equal(await repairFromXref(doc, bytes), 1);
    assert.equal(libValue(doc), 'NEW');
  });

  test('an object with generation 1: its stale generation-0 copy is a different object', async () => {
    const w = new Writer();
    const gen1 = (s) => s.replace(/4 0 R/g, '4 1 R');
    w.obj(1, gen1(CATALOG));
    w.obj(2, PAGES);
    w.obj(3, gen1(PAGE));
    w.off[4] = w.s.length;
    w.s += `4 1 obj\n${field('NEW')}\nendobj\n`;
    w.objStm(6, [[4, field('OLD')]]);
    const rows = [[0, 0, 0, 65535], [1, 1, w.off[1], 0], [2, 1, w.off[2], 0], [3, 1, w.off[3], 0], [4, 1, w.off[4], 1], [6, 0, 0, 1]];
    const bytes = w.end(w.xrefStream(7, rows, '/Root 1 0 R'));
    assert.equal(await pdfjsValue(bytes), 'NEW');
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const before = objCount(doc);
    assert.equal(libValue(doc), 'NEW');
    assert.equal(await repairFromXref(doc, bytes), 0);
    assert.equal(libValue(doc), 'NEW');
    assert.equal(objCount(doc), before);
  });

  test('an encrypted file is left as pdf-lib loaded it', async () => {
    const bytes = bugShape({ extra: '/Encrypt 9 0 R' });
    const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
    assert.equal(libValue(doc), 'OLD');
    assert.equal(await repairFromXref(doc, bytes), 0);
    assert.equal(libValue(doc), 'OLD');
  });
});

describe('xref repair: incremental updates load the newest definition, and the repair changes nothing', () => {
  async function newest(bytes) {
    assert.equal(await pdfjsValue(bytes), 'NEW');
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const before = objCount(doc);
    assert.equal(libValue(doc), 'NEW');
    assert.equal(await repairFromXref(doc, bytes), 0);
    assert.equal(libValue(doc), 'NEW');
    assert.equal(objCount(doc), before);
    assert.equal(libValue(await loadPdfDoc(bytes, { updateMetadata: false })), 'NEW');
  }
  const base = (w) => {
    w.obj(1, CATALOG);
    w.obj(2, PAGES);
    w.obj(3, PAGE);
  };
  const rows = (w) => [[0, 0, 0, 65535], [1, 1, w.off[1], 0], [2, 1, w.off[2], 0], [3, 1, w.off[3], 0]];

  test('an object in an object stream, redefined at top level by an update', async () => {
    const w = new Writer();
    base(w);
    w.objStm(5, [[4, field('OLD')]]);
    const x1 = w.xrefStream(7, [...rows(w), [4, 2, 5, 0], [5, 1, w.off[5], 0]], '/Root 1 0 R');
    w.obj(4, field('NEW'));
    await newest(w.end(w.xrefStream(8, [[4, 1, w.off[4], 0]], `/Root 1 0 R /Prev ${x1}`)));
  });

  test('a top-level object moved into a new object stream by an update', async () => {
    const w = new Writer();
    base(w);
    w.obj(4, field('OLD'));
    const x1 = w.xrefStream(7, [...rows(w), [4, 1, w.off[4], 0]], '/Root 1 0 R');
    w.objStm(9, [[4, field('NEW')]]);
    await newest(w.end(w.xrefStream(10, [[4, 2, 9, 0], [9, 1, w.off[9], 0]], `/Root 1 0 R /Prev ${x1}`)));
  });

  test('an object moved from object stream S1 to S2 by an update', async () => {
    const w = new Writer();
    base(w);
    w.objStm(5, [[4, field('OLD')], [6, '<< /Kept true >>']]);
    const x1 = w.xrefStream(7, [...rows(w), [4, 2, 5, 0], [5, 1, w.off[5], 0], [6, 2, 5, 1]], '/Root 1 0 R');
    w.objStm(9, [[4, field('NEW')]]);
    await newest(w.end(w.xrefStream(10, [[4, 2, 9, 0], [9, 1, w.off[9], 0]], `/Root 1 0 R /Prev ${x1}`)));
  });
});
