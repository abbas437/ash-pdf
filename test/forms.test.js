import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, degrees } from 'pdf-lib';
import { listFields, fillFields, flattenForm } from '../src/core/forms.js';
import { flattenObjects } from '../src/core/annotate.js';
import { getInfo } from '../src/core/pdfOps.js';
import { visibleText, near } from './helpers.js';

async function makeFormPdf({ rotation = 0 } = {}) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  if (rotation) page.setRotation(degrees(rotation));
  const form = doc.getForm();
  const name = form.createTextField('name');
  name.addToPage(page, { x: 50, y: 700, width: 200, height: 20, borderWidth: 0 }); // border would grow the widget Rect
  const notes = form.createTextField('notes');
  notes.enableMultiline();
  notes.setMaxLength(200);
  notes.addToPage(page, { x: 50, y: 600, width: 200, height: 60 });
  form.createCheckBox('approved').addToPage(page, { x: 50, y: 560, width: 15, height: 15 });
  const radio = form.createRadioGroup('code');
  radio.addOptionToPage('A', page, { x: 50, y: 520, width: 15, height: 15 });
  radio.addOptionToPage('B', page, { x: 80, y: 520, width: 15, height: 15 });
  radio.addOptionToPage('C', page, { x: 110, y: 520, width: 15, height: 15 });
  const dd = form.createDropdown('discipline');
  dd.addOptions(['HVAC', 'Plumbing', 'Electrical']);
  dd.addToPage(page, { x: 50, y: 480, width: 120, height: 20 });
  const ol = form.createOptionList('tags');
  ol.addOptions(['duct', 'fan', 'damper']);
  ol.enableMultiselect();
  ol.addToPage(page, { x: 200, y: 440, width: 120, height: 60 });
  return doc.save();
}

describe('forms', () => {
  test('listFields reports types, options, flags and visible rects', async () => {
    const fields = await listFields(await makeFormPdf());
    const by = Object.fromEntries(fields.map((f) => [f.name, f]));
    assert.deepEqual(Object.keys(by).sort(), ['approved', 'code', 'discipline', 'name', 'notes', 'tags']);
    assert.equal(by.name.type, 'text');
    assert.equal(by.name.value, '');
    assert.equal(by.notes.multiline, true);
    assert.equal(by.notes.maxLength, 200);
    assert.equal(by.approved.type, 'checkbox');
    assert.equal(by.approved.value, false);
    assert.equal(by.code.type, 'radio');
    assert.deepEqual(by.code.options, ['A', 'B', 'C']);
    assert.equal(by.discipline.type, 'dropdown');
    assert.deepEqual(by.discipline.options, ['HVAC', 'Plumbing', 'Electrical']);
    assert.equal(by.tags.type, 'optionlist');
    assert.equal(by.name.pageIndex, 0);
    assert.equal(by.name.readOnly, false);
    assert.deepEqual(by.name.rect, { x: 50, y: 72, w: 200, h: 20 });
  });

  test('listFields rect follows /Rotate 90 into visible space', async () => {
    const fields = await listFields(await makeFormPdf({ rotation: 90 }));
    const r = fields.find((f) => f.name === 'name').rect;
    // visible x = PDF y, visible y = PDF x for a rotation-90 page with origin 0,0
    assert.deepEqual(r, { x: 700, y: 50, w: 20, h: 200 });
  });

  test('fillFields then reload reads the values back', async () => {
    const out = await fillFields(await makeFormPdf(), {
      name: 'Ahmad',
      notes: 'Line 1\nLine 2',
      approved: true,
      code: 'B',
      discipline: 'HVAC',
      tags: ['duct', 'damper'],
    });
    const by = Object.fromEntries((await listFields(out)).map((f) => [f.name, f.value]));
    assert.equal(by.name, 'Ahmad');
    assert.equal(by.notes, 'Line 1\nLine 2');
    assert.equal(by.approved, true);
    assert.equal(by.code, 'B');
    assert.equal(by.discipline, 'HVAC');
    assert.deepEqual(by.tags, ['duct', 'damper']);
    assert.equal((await getInfo(out)).hasForm, true);
  });

  test('non-WinAnsi text keeps its exact value; appearance uses "?"', async () => {
    const out = await fillFields(await makeFormPdf(), { name: 'ΔP 50 Pa' });
    const f = (await listFields(out)).find((x) => x.name === 'name');
    assert.equal(f.value, 'ΔP 50 Pa');
  });

  test('fillFields with flatten:true removes the fields and keeps the text on the page', async () => {
    const out = await fillFields(await makeFormPdf(), { name: 'Flattened value' }, { flatten: true });
    assert.deepEqual(await listFields(out), []);
    const text = (await visibleText(out)).map((t) => t.str).join(' ');
    assert.match(text, /Flattened value/);
  });

  test('flattenForm leaves no fields', async () => {
    const filled = await fillFields(await makeFormPdf(), { name: 'X', approved: true });
    const out = await flattenForm(filled);
    assert.deepEqual(await listFields(out), []);
    assert.equal((await getInfo(out)).hasForm, false);
  });

  test('flattenForm on a PDF without a form is a no-op', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    const out = await flattenForm(await doc.save());
    assert.equal((await getInfo(out)).pageCount, 1);
  });

  test('unknown field name throws code FIELD_NOT_FOUND', async () => {
    await assert.rejects(fillFields(await makeFormPdf(), { nope: 'x' }), (e) => e.code === 'FIELD_NOT_FOUND');
  });

  test('invalid radio option is rejected', async () => {
    await assert.rejects(fillFields(await makeFormPdf(), { code: 'Z' }));
  });

  test('overlay text can be flattened onto a filled form page', async () => {
    const filled = await fillFields(await makeFormPdf(), { name: 'Ahmad' });
    const out = await flattenObjects(filled, [{ id: 1, page: 0, type: 'text', x: 300, y: 100, w: 200, h: 20, text: 'Reviewed', fontSize: 12 }]);
    const hit = (await visibleText(out)).find((t) => t.str === 'Reviewed');
    assert.ok(hit);
    near(hit.x, 300, 2, 'x');
    assert.equal((await listFields(out)).find((f) => f.name === 'name').value, 'Ahmad');
  });
});
