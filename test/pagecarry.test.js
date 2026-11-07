// Bookmarks and form fields across merge / extract / split / delete / insert / duplicate / replace.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFNumber, PDFHexString, PDFRef } from 'pdf-lib';
import * as ops from '../src/core/pdfOps.js';

const N = (s) => PDFName.of(s);

/**
 * 4 pages. Outline: "Intro" -> p1 (explicit), "Chapter" -> p3 (closed) with kids "Sub" -> p4
 * (/Names /Dests "sub") and "Back" -> p2 (catalog /Dests /back), "End" -> p2 (GoTo action).
 * Text field `prefix`.name on page 2, `prefix`.notes on page 4 (or plain names when prefix is '').
 */
async function fixture({ prefix = '', bookmarks = true, needAppearances = false } = {}) {
  const doc = await PDFDocument.create();
  const pages = [1, 2, 3, 4].map((i) => {
    const p = doc.addPage([300, 400]);
    p.drawText(`Page ${i}`, { x: 20, y: 20, size: 12 });
    return p;
  });
  const form = doc.getForm();
  form.createTextField(`${prefix}name`).addToPage(pages[1], { x: 20, y: 300, width: 200, height: 20 });
  form.createTextField(`${prefix}notes`).addToPage(pages[3], { x: 20, y: 300, width: 200, height: 20 });
  if (needAppearances) doc.catalog.lookup(N('AcroForm'), PDFDict).set(N('NeedAppearances'), doc.context.obj(true));
  if (bookmarks) {
    const ctx = doc.context;
    const xyz = (p) => ctx.obj([p.ref, 'XYZ', 0, 400, null]);
    doc.catalog.set(N('Names'), ctx.obj({ Dests: ctx.obj({ Names: [PDFHexString.fromText('sub'), xyz(pages[3])] }) }));
    doc.catalog.set(N('Dests'), ctx.obj({ back: ctx.obj({ D: xyz(pages[1]) }) }));
    const root = ctx.register(ctx.obj({ Type: 'Outlines' }));
    const mk = (title, extra) => ctx.register(ctx.obj({ Title: PDFHexString.fromText(title), ...extra }));
    const intro = mk('Intro', { Dest: xyz(pages[0]), C: [1, 0, 0], F: 2 });
    const chapter = mk('Chapter', { Dest: xyz(pages[2]) });
    const sub = mk('Sub', { Dest: PDFHexString.fromText('sub') });
    const back = mk('Back', { Dest: 'back' });
    const end = mk('End', { A: { S: 'GoTo', D: xyz(pages[1]) } });
    const L = (ref, o) => { const d = ctx.lookup(ref); for (const [k, v] of Object.entries(o)) d.set(N(k), v); };
    L(root, { First: intro, Last: end, Count: PDFNumber.of(3) });
    L(intro, { Parent: root, Next: chapter });
    L(chapter, { Parent: root, Prev: intro, Next: end, First: sub, Last: back, Count: PDFNumber.of(-2) });
    L(sub, { Parent: chapter, Next: back });
    L(back, { Parent: chapter, Prev: sub });
    L(end, { Parent: root, Prev: chapter });
    doc.catalog.set(N('Outlines'), root);
  }
  return doc.save();
}

/** Outline as [{title, page (1-based, 0 = no destination, -1 = page not in doc), depth}]; asserts the links. */
async function outline(bytes) {
  const doc = await PDFDocument.load(bytes);
  const ctx = doc.context;
  const index = new Map(doc.getPages().map((p, i) => [p.ref, i + 1]));
  const tree = new Map();
  const names = doc.catalog.lookup(N('Names'));
  const nt = names instanceof PDFDict ? names.lookup(N('Dests')) : undefined;
  const na = nt instanceof PDFDict ? nt.lookup(N('Names')) : undefined;
  for (let i = 0; na instanceof PDFArray && i < na.size(); i += 2) tree.set(na.lookup(i).decodeText(), na.lookup(i + 1));
  const dests = doc.catalog.lookup(N('Dests'));
  const pageOf = (item) => {
    let d = item.lookup(N('Dest'));
    if (d === undefined && item.lookup(N('A')) instanceof PDFDict) d = item.lookup(N('A')).lookup(N('D'));
    if (d === undefined) return 0;
    if (d instanceof PDFName) d = dests.lookup(d);
    else if (!(d instanceof PDFArray)) d = tree.get(d.decodeText());
    if (d instanceof PDFDict) d = d.lookup(N('D'));
    const r = d.get(0);
    return r instanceof PDFRef ? index.get(r) ?? -1 : -1;
  };
  const out = [];
  const walk = (parent, parentRef, depth) => {
    let ref = parent.get(N('First'));
    let prev;
    let visible = 0;
    let n = 0;
    while (ref) {
      const d = ctx.lookup(ref);
      assert.equal(d.get(N('Parent')), parentRef, 'Parent link');
      assert.equal(d.get(N('Prev')), prev, 'Prev link');
      out.push({ title: d.lookup(N('Title')).decodeText(), page: pageOf(d), depth });
      const sub = walk(d, ref, depth + 1);
      const c = d.lookup(N('Count'));
      if (sub.n) assert.equal(Math.abs(c.asNumber()), sub.visible, `Count of ${d.lookup(N('Title')).decodeText()}`);
      visible += 1 + (c && c.asNumber() > 0 ? sub.visible : 0);
      n++;
      prev = ref;
      ref = d.get(N('Next'));
    }
    assert.equal(parent.get(N('Last')), prev, 'Last link');
    return { visible, n };
  };
  const rootRef = doc.catalog.get(N('Outlines'));
  if (!rootRef) return out;
  const root = ctx.lookup(rootRef);
  const { visible } = walk(root, rootRef, 0);
  assert.equal(root.lookup(N('Count'))?.asNumber() ?? 0, visible, 'root Count');
  return out;
}
const flat = (o) => o.map((x) => `${'  '.repeat(x.depth)}${x.title}@${x.page}`);

async function fieldNames(bytes) {
  return (await PDFDocument.load(bytes)).getForm().getFields().map((f) => f.getName()).sort();
}

/** Fill text field `name`, save, reload: the value reads back. */
async function fills(bytes, name, value = 'filled') {
  const doc = await PDFDocument.load(bytes);
  doc.getForm().getTextField(name).setText(value);
  const again = await PDFDocument.load(await doc.save());
  return again.getForm().getTextField(name).getText() === value;
}

const FULL = ['Intro@1', 'Chapter@3', '  Sub@4', '  Back@2', 'End@2'];

describe('bookmarks and form fields follow page operations', () => {
  test('fixture reads as built', async () => {
    const src = await fixture();
    assert.deepEqual(flat(await outline(src)), FULL);
    assert.deepEqual(await fieldNames(src), ['name', 'notes']);
  });

  test('merge carries each source outline in order and keeps both forms fillable (name clash renamed)', async () => {
    const out = await ops.mergePdfs([await fixture(), await fixture()]);
    assert.deepEqual(flat(await outline(out)), [...FULL, 'Intro@5', 'Chapter@7', '  Sub@8', '  Back@6', 'End@6']);
    assert.deepEqual(await fieldNames(out), ['name', 'name_2', 'notes', 'notes_2']);
    assert.ok(await fills(out, 'name'));
    assert.ok(await fills(out, 'name_2'));
    const doc = await PDFDocument.load(out);
    const form = doc.getForm();
    form.getTextField('name_2').setText('second');
    assert.equal(form.getTextField('name').getText(), undefined, 'renamed copy is independent');
    // The renamed copy's widget is on page 6.
    const w = form.getTextField('name_2').acroField.getWidgets()[0];
    assert.equal(doc.getPages().findIndex((p) => p.ref === w.P()), 5);
  });

  test('merge keeps open/closed state, /C and /F', async () => {
    const doc = await PDFDocument.load(await ops.mergePdfs([await fixture()]));
    const root = doc.catalog.lookup(N('Outlines'), PDFDict);
    const intro = root.lookup(N('First'), PDFDict);
    assert.deepEqual(intro.lookup(N('C'), PDFArray).asArray().map((x) => x.asNumber()), [1, 0, 0]);
    assert.equal(intro.lookup(N('F'), PDFNumber).asNumber(), 2);
    assert.equal(intro.lookup(N('Next'), PDFDict).lookup(N('Count'), PDFNumber).asNumber(), -2);
    assert.equal(root.lookup(N('Count'), PDFNumber).asNumber(), 3);
  });

  test('merge sets NeedAppearances only when a source has it', async () => {
    const af = async (b) => (await PDFDocument.load(b)).catalog.lookup(N('AcroForm'), PDFDict);
    assert.equal((await af(await ops.mergePdfs([await fixture()]))).has(N('NeedAppearances')), false);
    assert.equal(String((await af(await ops.mergePdfs([await fixture({ needAppearances: true })]))).lookup(N('NeedAppearances'))), 'true');
  });

  test('extract keeps bookmarks to copied pages only, remapped; fields of copied pages only', async () => {
    const out = await ops.extractPages(await fixture(), [3, 1]);
    // Chapter's own page 3 is not copied but its kids are: kept as a container without destination.
    assert.deepEqual(flat(await outline(out)), ['Chapter@0', '  Sub@1', '  Back@2', 'End@2']);
    assert.deepEqual(await fieldNames(out), ['name', 'notes']);
    assert.ok(await fills(out, 'name'));
    assert.ok(await fills(out, 'notes'));
  });

  test('extract of pages without bookmarks or fields adds neither', async () => {
    const out = await ops.extractPages(await fixture(), [2]);
    assert.deepEqual(flat(await outline(out)), ['Chapter@1']);
    assert.deepEqual(await fieldNames(out), []);
  });

  test('split gives each part its own bookmarks and fields', async () => {
    const [a, b] = await ops.splitPdf(await fixture(), ['1-2', '3-4']);
    assert.deepEqual(flat(await outline(a.bytes)), ['Intro@1', 'Chapter@0', '  Back@2', 'End@2']);
    assert.deepEqual(flat(await outline(b.bytes)), ['Chapter@1', '  Sub@2']);
    assert.deepEqual(await fieldNames(a.bytes), ['name']);
    assert.deepEqual(await fieldNames(b.bytes), ['notes']);
    assert.ok(await fills(b.bytes, 'notes'));
  });

  test('delete removes bookmarks to the deleted page, siblings intact and Count consistent', async () => {
    const out = await ops.deletePages(await fixture(), [1]);
    assert.deepEqual(flat(await outline(out)), ['Intro@1', 'Chapter@2', '  Sub@3']);
    assert.deepEqual(await fieldNames(out), ['notes']);
    assert.ok(await fills(out, 'notes'));
  });

  test('delete of a page with a parent bookmark keeps it as a container for kept children', async () => {
    const out = await ops.deletePages(await fixture(), [2]);
    assert.deepEqual(flat(await outline(out)), ['Intro@1', 'Chapter@0', '  Sub@3', '  Back@2', 'End@2']);
    assert.deepEqual(await fieldNames(out), ['name', 'notes']);
  });

  test('delete removes emptied parent fields', async () => {
    const out = await ops.deletePages(await fixture({ prefix: 'grp.' }), [1, 3]);
    assert.deepEqual(await fieldNames(out), []);
    const af = (await PDFDocument.load(out)).catalog.lookup(N('AcroForm'), PDFDict);
    assert.equal(af.lookup(N('Fields'), PDFArray).size(), 0);
  });

  test('insert from PDF carries the source bookmarks before later ones and its fields, renamed on clash', async () => {
    const dest = await ops.mergePdfs([await fixture({ bookmarks: true })]);
    const out = await ops.insertPagesFrom(dest, await fixture({ prefix: 'b.' }), [1, 2], 1);
    assert.deepEqual(flat(await outline(out)), ['Intro@1', 'Chapter@3', '  Back@2', 'End@2', 'Chapter@5', '  Sub@6', '  Back@4', 'End@4']);
    assert.deepEqual(await fieldNames(out), ['b.name', 'name', 'notes']);
    assert.ok(await fills(out, 'b.name'));
    const clash = await ops.insertPagesFrom(dest, await fixture(), [1], 4);
    assert.deepEqual(await fieldNames(clash), ['name', 'name_2', 'notes']);
    assert.ok(await fills(clash, 'name_2'));
  });

  test('duplicate copies fields as independent renamed fields and leaves bookmarks as they were', async () => {
    const src = await fixture();
    const out = await ops.insertPagesFrom(src, src, [1], 2, { outline: false });
    assert.deepEqual(flat(await outline(out)), ['Intro@1', 'Chapter@4', '  Sub@5', '  Back@2', 'End@2']);
    assert.deepEqual(await fieldNames(out), ['name', 'name_2', 'notes']);
    assert.ok(await fills(out, 'name_2'));
    const doc = await PDFDocument.load(out);
    doc.getForm().getTextField('name_2').setText('copy');
    assert.equal(doc.getForm().getTextField('name').getText(), undefined);
  });

  test('replace retargets bookmarks to the replacement page and swaps the fields', async () => {
    const out = await ops.replacePages(await fixture(), await fixture({ prefix: 'r.', bookmarks: false }), [3], 1);
    assert.deepEqual(flat(await outline(out)), FULL);
    assert.deepEqual(await fieldNames(out), ['notes', 'r.notes']);
    assert.ok(await fills(out, 'r.notes'));
  });
});
