import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stampSubtext, stampLayout, STANDARD_STAMPS, DYNAMIC_STAMPS } from '../src/core/stamps.js';
import { flattenObjects } from '../src/core/annotate.js';
import { writeAnnotations, readAnnotations } from '../src/core/annots.js';
import { PDFDocument } from 'pdf-lib';

const D = new Date(2026, 9, 7, 9, 5);
test('stampSubtext formats author, date and time per the options', () => {
  assert.equal(stampSubtext(D, { author: 'A. Example' }), 'by A. Example · 2026-10-07');
  assert.equal(stampSubtext(D, { author: 'A. Example', dateFormat: 'DD/MM/YYYY', showTime: true }), 'by A. Example · 07/10/2026 09:05');
  assert.equal(stampSubtext(D, { author: 'X', showAuthor: false, dateFormat: 'D MMMM YYYY' }), '7 October 2026');
  assert.equal(stampSubtext(D, { author: '  ', showTime: true, showDate: false }), '09:05');
  assert.equal(stampSubtext(D, { author: 'X', showDate: false }), 'by X');
});
test('stamp catalogue: unique ids, the required standard set, dynamic subset', () => {
  const texts = STANDARD_STAMPS.map((s) => s.text);
  for (const t of ['APPROVED', 'NOT APPROVED', 'REJECTED', 'DRAFT', 'FINAL', 'CONFIDENTIAL', 'FOR COMMENT', 'FOR INFORMATION', 'RECEIVED', 'REVIEWED', 'REVISED', 'VOID', 'COMPLETED', 'PAID', 'COPY', 'ORIGINAL', 'SIGN HERE', 'WITNESS']) assert.ok(texts.includes(t), t);
  const ids = [...STANDARD_STAMPS, ...DYNAMIC_STAMPS].map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(DYNAMIC_STAMPS.every((s) => s.dynamic && /^#[0-9a-f]{6}$/.test(s.color)));
});
test('stampLayout: two lines stacked inside the box, subtext smaller', () => {
  const o = { x: 10, y: 20, w: 200, h: 60, borderWidth: 2, subtext: 'by X · 2026-10-07' };
  const L = stampLayout(o, 5, 9, 0.718);
  assert.ok(L.subSize < L.size && L.base < L.subBase && L.subBase <= o.y + o.h && L.base - 0.718 * L.size >= o.y);
  assert.equal(stampLayout({ ...o, subtext: '' }, 5, 0, 0.718).subSize, undefined);
});
test('a stamp with subtext draws both lines and round-trips through annotations', async () => {
  const doc = await PDFDocument.create(); doc.addPage([400, 400]);
  const pdf = await doc.save();
  const o = { id: 's1', type: 'stamp', page: 0, x: 50, y: 50, w: 220, h: 70, text: 'APPROVED', subtext: 'by X · 2026-10-07', color: '#1b7f3b', borderWidth: 2 };
  const flat = await flattenObjects(pdf, [o]);
  assert.ok(flat.length > pdf.length);
  const { objects } = await readAnnotations(await writeAnnotations(pdf, { add: [o] }));
  assert.equal(objects[0].type, 'stamp'); assert.equal(objects[0].text, 'APPROVED'); assert.equal(objects[0].subtext, 'by X · 2026-10-07');
});
test('stampLayout circle: double ring centred in the box, text block corners inside the inner ring', () => {
  const capH = 0.718;
  for (const sub of ['', 'by X · 2026-10-07']) {
    const o = { x: 10, y: 20, w: 140, h: 120, borderWidth: 2, shape: 'circle', subtext: sub };
    const w1 = 5, sw1 = 9;
    const L = stampLayout(o, w1, sw1, capH);
    assert.equal(L.shape, 'circle'); assert.equal(L.cx, 80); assert.equal(L.cy, 80);
    assert.equal(L.rings.length, 2);
    assert.equal(L.rings[0].rx, L.rings[0].ry, 'circle, not ellipse');
    assert.ok(L.rings[0].rx === 60 - 1 && L.rings[1].rx < L.rings[0].rx - 2, 'outer ring on the box edge, inner ring inside it');
    // Text block: top line's cap top to the last baseline, widest line width.
    const top = L.base - capH * L.size, bottom = sub ? L.subBase : L.base;
    const halfW = Math.max(w1 * L.size, sub ? sw1 * L.subSize : 0) / 2;
    const inner = L.rings[1].rx - L.rings[1].width / 2;
    for (const y of [top, bottom]) assert.ok(Math.hypot(halfW, y - L.cy) < inner, `corner at y=${y} outside the inner ring`);
    assert.ok(L.size > 8, `text not needlessly small: ${L.size}`);
    if (sub) assert.ok(L.subSize < L.size && L.base < L.subBase);
  }
  const E = stampLayout({ x: 0, y: 0, w: 200, h: 100, borderWidth: 2, shape: 'ellipse' }, 5, 0, capH);
  assert.ok(E.rings[0].rx === 99 && E.rings[0].ry === 49);
  assert.equal(stampLayout({ x: 0, y: 0, w: 200, h: 100, borderWidth: 2, shape: 'bogus' }, 5, 0, capH).shape, 'rect');
});
test('a circle stamp writes its shape and reads it back; a stamp without one reads as rect', async () => {
  const doc = await PDFDocument.create(); doc.addPage([400, 400]);
  const pdf = await doc.save();
  const c = { id: 'c1', type: 'stamp', page: 0, x: 50, y: 50, w: 120, h: 120, text: 'APPROVED', subtext: 'by X', color: '#1b7f3b', borderWidth: 2, shape: 'circle' };
  const r = { id: 'r1', type: 'stamp', page: 0, x: 200, y: 200, w: 120, h: 40, text: 'DRAFT', color: '#4b5563', borderWidth: 2 };
  const { objects } = await readAnnotations(await writeAnnotations(pdf, { add: [c, r] }));
  const byId = Object.fromEntries(objects.map((o) => [o.id, o]));
  assert.equal(byId.c1.shape, 'circle');
  assert.equal(byId.c1.subtext, 'by X');
  assert.equal(byId.r1.shape, 'rect');
});
