import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFArray, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import * as m from '../src/core/pagemarks.js';
import { makePdf, makeGeometryFixture, visibleText, renderPage, makeImage, pageContent, isColor } from './helpers.js';

/** Contents of page i as [{ref, tag, text}] (decoded), plus the raw /Contents entry as a string. */
async function contents(bytes, i = 0) {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(i);
  const raw = page.node.get(PDFName.Contents);
  const v = doc.context.lookup(raw);
  const refs = v instanceof PDFArray ? v.asArray() : [raw];
  return {
    raw: raw.toString(),
    streams: refs.map((r) => {
      const s = doc.context.lookup(r);
      const t = s.dict.get(PDFName.of('ASH_Mark'));
      const data = s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents();
      return { ref: r.toString(), tag: t ? t.decodeText() : null, text: Buffer.from(data).toString('latin1') };
    }),
  };
}

const texts = async (bytes, i) => (await visibleText(bytes, i)).map((t) => t.str);

describe('tokens and number formats', () => {
  test('formatNumber: arabic, roman, letters', () => {
    assert.equal(m.formatNumber(4, '1'), '4');
    assert.equal(m.formatNumber(14, 'i'), 'xiv');
    assert.equal(m.formatNumber(1994, 'I'), 'MCMXCIV');
    assert.equal(m.formatNumber(3, 'a'), 'c');
    assert.equal(m.formatNumber(28, 'a'), 'bb');
    assert.throws(() => m.formatNumber(1, 'x'), TypeError);
  });
  test('expandTokens: page, pages, file, dates', () => {
    const date = new Date(2026, 9, 7);
    const ctx = { page: 'ii', pages: 'v', date, fileName: 'a.pdf' };
    assert.equal(m.expandTokens('<<page>>/<<pages>> <<file>>', ctx), 'ii/v a.pdf');
    assert.equal(m.expandTokens('<<date>>', ctx), '2026-10-07');
    assert.equal(m.expandTokens('<<date:DD/MM/YYYY>>', ctx), '07/10/2026');
    assert.equal(m.expandTokens('<<date:D MMM YY>>', ctx), '7 Oct 26');
  });
  test('header/footer: "Page 2 of 3" extracted by pdf.js on page 2; start number and roman format', async () => {
    const out = await m.addHeaderFooter(await makePdf(3), { footer: { center: 'Page <<page>> of <<pages>>' }, header: { right: '<<file>>' }, fileName: 'plan.pdf' });
    assert.ok((await texts(out, 1)).includes('Page 2 of 3'));
    assert.ok((await texts(out, 0)).includes('plan.pdf'));
    const roman = await m.addHeaderFooter(await makePdf(3), { footer: { left: '<<page>>' }, startNumber: 3, numberFormat: 'I' });
    assert.ok((await texts(roman, 2)).includes('V'));
  });
  test('page range and even/odd only', async () => {
    const out = await m.addHeaderFooter(await makePdf(5), { header: { center: 'N<<page>>' }, pages: '2-5', subset: 'even' });
    assert.deepEqual((await m.listMarks(out)), [{ kind: 'headerFooter', pages: [1, 3] }]);
    assert.ok((await texts(out, 3)).includes('N3')); // numbering counts from the start of the range
  });
});

describe('rotated pages', () => {
  for (const rot of [90, 270]) {
    test(`/Rotate ${rot}: header sits at the visible top and reads upright`, async () => {
      const out = await m.addHeaderFooter(await makeGeometryFixture(rot), { header: { left: 'HEAD' }, footer: { right: 'FOOT' }, margins: { top: 20, bottom: 20, left: 30, right: 30 } });
      const items = await visibleText(out, 0);
      const head = items.find((t) => t.str === 'HEAD');
      const foot = items.find((t) => t.str === 'FOOT');
      assert.ok(head && foot, 'both texts found');
      assert.ok(head.y > 20 && head.y < 40, `header baseline near the visible top, got ${head.y}`);
      assert.ok(Math.abs(head.x - 30) < 1, `header at the left margin, got ${head.x}`);
      assert.ok(foot.y > 330, `footer near the visible bottom (360), got ${foot.y}`);
      assert.ok(head.dirX > 0 && Math.abs(head.dirY) < 1e-6, 'upright text');
    });
  }
});

describe('content stream structure', () => {
  test('behind marks are prepended, over marks appended, page content wrapped in q/Q', async () => {
    const base = await makePdf(1);
    const before = await contents(base);
    let out = await m.addWatermark(base, { text: 'UNDER', layer: 'behind' });
    out = await m.addWatermark(out, { text: 'OVER', layer: 'over' });
    out = await m.addBackground(out, { color: '#eeeeee' });
    const c = await contents(out);
    const tags = c.streams.map((s) => s.tag);
    assert.deepEqual(tags, ['background', 'watermark', 'wrapBegin', ...before.streams.map(() => null), 'wrapEnd', 'watermark']);
    assert.match(c.streams[1].text, /\/Artifact <<\/Type \/Pagination \/Subtype \/Watermark \/ASH_Mark \(watermark\)>> BDC/);
    assert.match(c.streams[0].text, /\/Subtype \/Background/);
    assert.equal(c.streams[2].text.trim(), 'q');
    assert.equal(c.streams.at(-2).text.trim(), 'Q');
  });
  test('removeMarks restores the original /Contents and streams exactly, and drops the resources', async () => {
    const base = await makePdf(2);
    const orig = [await contents(base, 0), await contents(base, 1)];
    let out = await m.addHeaderFooter(base, { footer: { center: '<<page>>' } });
    out = await m.addWatermark(out, { text: 'DRAFT', layer: 'behind' });
    out = (await m.addBates(out, { prefix: 'X' })).bytes;
    out = await m.addBackground(out, { image: makeImage('png') });
    assert.equal((await m.listMarks(out)).length, 4);
    // Removing one kind leaves the others.
    const noWm = await m.removeMarks(out, 'watermark');
    assert.deepEqual((await m.listMarks(noWm)).map((x) => x.kind), ['headerFooter', 'background', 'bates']);
    const back = await m.removeMarks(noWm, ['headerFooter', 'background', 'bates']);
    assert.deepEqual(await m.listMarks(back), []);
    for (const i of [0, 1]) assert.deepEqual(await contents(back, i), orig[i]);
    const doc = await PDFDocument.load(back);
    const res = doc.getPage(0).node.Resources();
    for (const sub of ['Font', 'XObject', 'ExtGState']) {
      const d = res.lookup(PDFName.of(sub));
      for (const k of d?.keys() ?? []) assert.doesNotMatch(k.decodeText(), /^ASH_/);
    }
  });
  test('replace swaps a mark kind; update = remove + add', async () => {
    const one = await m.addWatermark(await makePdf(1), { text: 'FIRST' });
    const two = await m.addWatermark(one, { text: 'SECOND', replace: true });
    const t = await texts(two, 0);
    assert.ok(t.includes('SECOND') && !t.includes('FIRST'));
  });
});

describe('watermark and background', () => {
  test('text watermark is visible in a rendered page; image watermark and tiling work', async () => {
    const out = await m.addWatermark(await makePdf(1, [300, 300]), { text: 'WWWW', color: '#ff0000', opacity: 1, rotation: 0, fontSize: 60 });
    const r = await renderPage(out);
    let red = 0;
    for (let x = 80; x < 220; x += 2) if (isColor(r.sample(x, 150), [255, 0, 0], 60)) red++;
    assert.ok(red > 10, `red pixels across the centre: ${red}`);
    const img = await m.addWatermark(await makePdf(1, [300, 300]), { image: makeImage('png', 40, 20, '#00ff00'), opacity: 1, rotation: 0, scale: 0.5 });
    assert.ok(isColor((await renderPage(img)).sample(150, 150), [0, 255, 0]));
    const tiled = await m.addWatermark(await makePdf(1), { text: 'T', tile: true, fontSize: 20 });
    assert.ok((await texts(tiled, 0)).filter((s) => s === 'T').length > 4);
  });
  test('background colour sits behind the page text', async () => {
    const out = await m.addBackground(await makePdf(1, [200, 200]), { color: '#0000ff' });
    const r = await renderPage(out);
    assert.ok(isColor(r.sample(150, 20), [0, 0, 255]));
    assert.ok((await pageContent(out)).includes('re f'));
  });
});

describe('Bates numbering', () => {
  test('zero padding, prefix/suffix and the last number used', async () => {
    const { bytes, lastNumber } = await m.addBates(await makePdf(3), { prefix: 'ASH-', suffix: '-R', startNumber: 98, digits: 6 });
    assert.equal(lastNumber, 100);
    assert.ok((await texts(bytes, 0)).includes('ASH-000098-R'));
    assert.ok((await texts(bytes, 2)).includes('ASH-000100-R'));
  });
});

describe('unsupported text', () => {
  test('Arabic text is refused with a clear error', async () => {
    const pdf = await makePdf(1);
    await assert.rejects(m.addHeaderFooter(pdf, { header: { center: 'صفحة <<page>>' } }), (e) => e.code === 'UNSUPPORTED_TEXT' && /Arabic/.test(e.message));
    await assert.rejects(m.addWatermark(pdf, { text: 'مسودة' }), (e) => e.code === 'UNSUPPORTED_TEXT');
    await assert.rejects(m.addBates(pdf, { prefix: 'ب' }), (e) => e.code === 'UNSUPPORTED_TEXT');
  });
});
