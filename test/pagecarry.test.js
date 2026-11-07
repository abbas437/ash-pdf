// Bookmarks and form fields across merge / extract / split / delete / insert / duplicate / replace.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFNumber, PDFHexString, PDFRef, PDFString } from 'pdf-lib';
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

  test('merge and extract keep a URI bookmark beside a page bookmark', async () => {
    const doc = await PDFDocument.load(await fixture());
    const ctx = doc.context;
    const root = doc.catalog.lookup(N('Outlines'), PDFDict);
    const rootRef = doc.catalog.get(N('Outlines'));
    const last = root.get(N('Last'));
    const web = ctx.register(ctx.obj({
      Title: PDFHexString.fromText('Website'), Parent: rootRef, Prev: last,
      A: { S: 'URI', URI: PDFString.of('https://example.com/x') },
    }));
    ctx.lookup(last).set(N('Next'), web);
    root.set(N('Last'), web);
    root.set(N('Count'), PDFNumber.of(4));
    const src = await doc.save();
    const uri = async (bytes) => {
      const d = await PDFDocument.load(bytes);
      const items = [];
      for (let r = d.catalog.lookup(N('Outlines'), PDFDict).get(N('First')); r; r = d.context.lookup(r).get(N('Next'))) items.push(d.context.lookup(r));
      const w = items.find((i) => i.lookup(N('Title')).decodeText() === 'Website');
      return w && [String(w.lookup(N('A'), PDFDict).lookup(N('S'))), w.lookup(N('A'), PDFDict).lookup(N('URI')).decodeText()];
    };
    const want = ['/URI', 'https://example.com/x'];
    const merged = await ops.mergePdfs([src, src]);
    assert.deepEqual(flat(await outline(merged)).filter((x) => /Website|Intro/.test(x)), ['Intro@1', 'Website@0', 'Intro@5', 'Website@0']);
    assert.deepEqual(await uri(merged), want);
    const ext = await ops.extractPages(src, [0]);
    assert.deepEqual(flat(await outline(ext)), ['Intro@1', 'Website@0']);
    assert.deepEqual(await uri(ext), want);
    // Deleting a page leaves it alone.
    assert.deepEqual(await uri(await ops.deletePages(src, [0])), want);
  });

  test('a field whose /T is on its widget (no Kids) is carried, fillable and deleted with its page', async () => {
    const doc = await PDFDocument.create();
    const pages = [doc.addPage([300, 400]), doc.addPage([300, 400])];
    const ctx = doc.context;
    const widget = (page, name) => {
      const ref = ctx.register(ctx.obj({
        Type: 'Annot', Subtype: 'Widget', FT: 'Tx', T: PDFHexString.fromText(name),
        Rect: [20, 300, 220, 320], F: 4, P: page.ref, DA: PDFString.of('/Helv 0 Tf 0 g'),
      }));
      page.node.set(N('Annots'), ctx.obj([ref]));
      return ref;
    };
    const refs = [widget(pages[0], 'solo1'), widget(pages[1], 'solo2')];
    doc.catalog.set(N('AcroForm'), ctx.obj({ Fields: refs }));
    const src = await doc.save();
    assert.deepEqual(await fieldNames(src), ['solo1', 'solo2']);
    const out = await ops.extractPages(src, [1]);
    assert.deepEqual(await fieldNames(out), ['solo2']);
    assert.ok(await fills(out, 'solo2'));
    const merged = await ops.mergePdfs([src, src]);
    assert.deepEqual(await fieldNames(merged), ['solo1', 'solo1_2', 'solo2', 'solo2_2']);
    assert.ok(await fills(merged, 'solo2_2'));
    const del = await ops.deletePages(src, [0]);
    assert.deepEqual(await fieldNames(del), ['solo2']);
    assert.ok(await fills(del, 'solo2'));
  });

  test('a radio group with kids on two pages: extract keeps that kid, delete keeps the other', async () => {
    const doc = await PDFDocument.create();
    const pages = [doc.addPage([300, 400]), doc.addPage([300, 400])];
    const group = doc.getForm().createRadioGroup('choice');
    group.addOptionToPage('one', pages[0], { x: 20, y: 300, width: 20, height: 20 });
    group.addOptionToPage('two', pages[1], { x: 20, y: 300, width: 20, height: 20 });
    const src = await doc.save();
    const kidsOf = async (bytes) => (await PDFDocument.load(bytes)).getForm().getRadioGroup('choice');
    const ext = await kidsOf(await ops.extractPages(src, [1]));
    assert.equal(ext.acroField.getWidgets().length, 1);
    ext.select('two');
    assert.equal(ext.getSelected(), 'two');
    const del = await kidsOf(await ops.deletePages(src, [0]));
    assert.equal(del.acroField.getWidgets().length, 1);
    del.select('two');
    assert.equal(del.getSelected(), 'two');
  });

  test('a radio group pruned to one kid renumbers its state so /AS indexes /Opt; a removed selection clears', async () => {
    const doc = await PDFDocument.create();
    const pages = [doc.addPage([300, 400]), doc.addPage([300, 400])];
    const group = doc.getForm().createRadioGroup('choice');
    group.addOptionToPage('one', pages[0], { x: 20, y: 300, width: 20, height: 20 });
    group.addOptionToPage('two', pages[1], { x: 20, y: 300, width: 20, height: 20 });
    group.select('one');
    const src = await doc.save();
    for (const out of [await ops.deletePages(src, [0]), await ops.extractPages(src, [1])]) {
      const g = (await PDFDocument.load(out)).getForm().getRadioGroup('choice');
      assert.deepEqual(g.getOptions(), ['two']);
      assert.equal(g.getSelected(), undefined, 'the selected option went with its page');
      g.select('two');
      const again = (await PDFDocument.load(await g.doc.save())).getForm().getRadioGroup('choice');
      assert.equal(again.getSelected(), 'two');
      const w = again.acroField.getWidgets()[0];
      const opt = again.acroField.dict.lookup(N('Opt'), PDFArray);
      const k = Number(w.getAppearanceState().decodeText());
      assert.ok(Number.isInteger(k) && k < opt.size(), `/AS ${w.getAppearanceState()} indexes /Opt`);
      assert.equal(opt.lookup(k).decodeText(), 'two');
    }
    const kept = (await PDFDocument.load(await ops.deletePages(src, [1]))).getForm().getRadioGroup('choice');
    assert.equal(kept.getSelected(), 'one');
  });

  test('a dropdown with a widget on each of two pages keeps all its options', async () => {
    const doc = await PDFDocument.create();
    const pages = [doc.addPage([300, 400]), doc.addPage([300, 400])];
    const dd = doc.getForm().createDropdown('pick');
    dd.addOptions(['Yes', 'No']);
    dd.addToPage(pages[0], { x: 20, y: 300, width: 100, height: 20 });
    dd.addToPage(pages[1], { x: 20, y: 300, width: 100, height: 20 });
    // A choice field under a parent that holds /FT: the type is inherited.
    const ctx = doc.context;
    const ref = doc.catalog.lookup(N('AcroForm'), PDFDict).lookup(N('Fields'), PDFArray).get(0);
    const field = ctx.lookup(ref);
    const parent = ctx.register(ctx.obj({ T: PDFHexString.fromText('grp'), FT: 'Ch', Kids: [ref] }));
    field.delete(N('FT'));
    field.set(N('Parent'), parent);
    doc.catalog.lookup(N('AcroForm'), PDFDict).set(N('Fields'), ctx.obj([parent]));
    const src = await doc.save();
    const opts = async (bytes) => {
      const f = (await PDFDocument.load(bytes)).getForm().getFields().find((x) => x.getName() === 'grp.pick');
      return f.getOptions();
    };
    assert.deepEqual(await opts(src), ['Yes', 'No']);
    assert.deepEqual(await opts(await ops.deletePages(src, [0])), ['Yes', 'No']);
    assert.deepEqual(await opts(await ops.extractPages(src, [1])), ['Yes', 'No']);
  });

  test('a carried bookmark action does not bring its /Next chain or the pages it names', async () => {
    const doc = await PDFDocument.load(await fixture());
    // No form: pdf-lib's copyPages itself leaves an orphan copy of a page that a widget's /P names.
    doc.catalog.delete(N('AcroForm'));
    doc.getPages().forEach((p) => p.node.delete(N('Annots')));
    const ctx = doc.context;
    const root = doc.catalog.lookup(N('Outlines'), PDFDict);
    const rootRef = doc.catalog.get(N('Outlines'));
    const p3 = doc.getPage(2).ref;
    const last = root.get(N('Last'));
    const web = ctx.register(ctx.obj({
      Title: PDFHexString.fromText('Website'), Parent: rootRef, Prev: last,
      A: { S: 'URI', URI: PDFString.of('https://example.com/x'), Next: { S: 'GoTo', D: [p3, 'Fit'] } },
    }));
    const annot = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [0, 0, 20, 20], P: doc.getPage(3).ref }));
    const hide = ctx.register(ctx.obj({ Title: PDFHexString.fromText('Hide'), Parent: rootRef, Prev: web, A: { S: 'Hide', T: annot } }));
    ctx.lookup(last).set(N('Next'), web);
    ctx.lookup(web).set(N('Next'), hide);
    root.set(N('Last'), hide);
    root.set(N('Count'), PDFNumber.of(5));
    const src = await doc.save();
    const pageObjects = async (bytes) => {
      const d = await PDFDocument.load(bytes);
      const n = d.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFDict && o.lookup(N('Type')) === N('Page')).length;
      return [n, d.getPageCount()];
    };
    const ext = await ops.extractPages(src, [0]);
    assert.deepEqual(await pageObjects(ext), [1, 1]);
    assert.deepEqual(flat(await outline(ext)), ['Intro@1', 'Website@0', 'Hide@0']);
    const merged = await ops.mergePdfs([src, src]);
    assert.deepEqual(await pageObjects(merged), [8, 8]);
    const d = await PDFDocument.load(merged);
    const items = [];
    for (let r = d.catalog.lookup(N('Outlines'), PDFDict).get(N('First')); r; r = d.context.lookup(r).get(N('Next'))) items.push(d.context.lookup(r));
    const w = items.find((i) => i.lookup(N('Title')).decodeText() === 'Website').lookup(N('A'), PDFDict);
    assert.equal(w.lookup(N('URI')).decodeText(), 'https://example.com/x');
    assert.equal(w.has(N('Next')), false);
    assert.equal(items.find((i) => i.lookup(N('Title')).decodeText() === 'Hide').has(N('A')), false, 'a Hide action is not carried');
  });

  test('a heading whose children all stay behind is not carried; a childless title-only item is', async () => {
    const doc = await PDFDocument.create();
    const pages = [1, 2, 3].map(() => doc.addPage([300, 400]));
    const ctx = doc.context;
    const rootRef = ctx.register(ctx.obj({ Type: 'Outlines' }));
    const mk = (title, extra = {}) => ctx.register(ctx.obj({ Title: PDFHexString.fromText(title), ...extra }));
    const dest = (i) => ({ Dest: ctx.obj([pages[i].ref, 'Fit']) });
    const [p1, c1, p2, c2, c3, note] = [mk('Part I'), mk('Ch1', dest(0)), mk('Part II'), mk('Ch2', dest(1)), mk('Ch3', dest(2)), mk('Note')];
    const L = (ref, o) => { const d = ctx.lookup(ref); for (const [k, v] of Object.entries(o)) if (v) d.set(N(k), v); };
    L(rootRef, { First: p1, Last: note, Count: PDFNumber.of(3) });
    L(p1, { Parent: rootRef, Next: p2, First: c1, Last: c1, Count: PDFNumber.of(-1) });
    L(c1, { Parent: p1 });
    L(p2, { Parent: rootRef, Prev: p1, Next: note, First: c2, Last: c3, Count: PDFNumber.of(-2) });
    L(c2, { Parent: p2, Next: c3 });
    L(c3, { Parent: p2, Prev: c2 });
    L(note, { Parent: rootRef, Prev: p2 });
    doc.catalog.set(N('Outlines'), rootRef);
    const src = await doc.save();
    assert.deepEqual(flat(await outline(await ops.extractPages(src, [0]))), ['Part I@0', '  Ch1@1', 'Note@0']);
    const [a, b] = await ops.splitPdf(src, ['1', '2-3']);
    assert.deepEqual(flat(await outline(a.bytes)), ['Part I@0', '  Ch1@1', 'Note@0']);
    assert.deepEqual(flat(await outline(b.bytes)), ['Part II@0', '  Ch2@1', '  Ch3@2', 'Note@0']);
  });

  test('deleting many pages keeps the right pages, fields and bookmarks', async () => {
    const doc = await PDFDocument.create();
    const ctx = doc.context;
    const form = doc.getForm();
    const rootRef = ctx.register(ctx.obj({ Type: 'Outlines' }));
    const items = [];
    for (let i = 0; i < 60; i++) {
      const p = doc.addPage([300, 400]);
      form.createTextField(`f${i}`).addToPage(p, { x: 20, y: 300, width: 100, height: 20 });
      items.push(ctx.register(ctx.obj({ Title: PDFHexString.fromText(`b${i}`), Parent: rootRef, Dest: [p.ref, 'Fit'] })));
    }
    items.forEach((r, i) => { if (i) ctx.lookup(r).set(N('Prev'), items[i - 1]); if (i < 59) ctx.lookup(r).set(N('Next'), items[i + 1]); });
    ctx.lookup(rootRef).set(N('First'), items[0]);
    ctx.lookup(rootRef).set(N('Last'), items[59]);
    ctx.lookup(rootRef).set(N('Count'), PDFNumber.of(60));
    doc.catalog.set(N('Outlines'), rootRef);
    const gone = Array.from({ length: 60 }, (_, i) => i).filter((i) => i % 3 !== 1).reverse();
    const out = await ops.deletePages(await doc.save(), [...gone, 0, 2]);
    const keep = Array.from({ length: 20 }, (_, k) => 3 * k + 1);
    assert.equal((await PDFDocument.load(out)).getPageCount(), 20);
    assert.deepEqual(flat(await outline(out)), keep.map((i, k) => `b${i}@${k + 1}`));
    assert.deepEqual(await fieldNames(out), keep.map((i) => `f${i}`).sort());
    const d = await PDFDocument.load(out);
    const pageOf = (name) => d.getPages().findIndex((p) => p.ref === d.getForm().getTextField(name).acroField.getWidgets()[0].P());
    assert.deepEqual(keep.map((i) => pageOf(`f${i}`)), keep.map((_, k) => k));
  });
});
