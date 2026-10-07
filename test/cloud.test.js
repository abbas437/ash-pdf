import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFDict } from 'pdf-lib';
import { cloudPath, cloudPathOf, cloudPolygon, cloudArc } from '../src/core/cloud.js';
import { writeAnnotations, readAnnotations } from '../src/core/annots.js';
import { flattenObjects } from '../src/core/annotate.js';
import { makePdf, near } from './helpers.js';

const curves = (d) => [...d.matchAll(/C([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)/g)].map((m) => m.slice(1).map(Number));

describe('cloud geometry', () => {
  test('a box gets scallops of about arcSize on an inset polygon, closed', () => {
    const o = { x: 10, y: 20, w: 100, h: 60, arcSize: 10 };
    assert.deepEqual(cloudPolygon(o), [[15, 25], [105, 25], [105, 75], [15, 75]]);
    const d = cloudPath(o);
    assert.match(d, /^M15 25C/);
    assert.match(d, /Z$/);
    assert.equal(curves(d).length, 9 + 5 + 9 + 5); // 90/10 and 50/10 chords per edge
    const last = curves(d).at(-1);
    assert.deepEqual(last.slice(4), [15, 25], 'ends where it started');
  });

  test('bumps bulge outward and peak half a chord off the edge, staying inside the box', () => {
    const o = { x: 0, y: 0, w: 100, h: 100, arcSize: 20 };
    const cs = curves(cloudPath(o));
    // first chord on the top edge (y = 10) goes up: controls at y < 10, cubic peak at y = 0
    const [c1x, c1y, c2x, c2y, ex, ey] = cs[0];
    assert.ok(c1y < 10 && c2y < 10);
    const peak = 0.125 * 10 + 0.375 * c1y + 0.375 * c2y + 0.125 * ey;
    near(peak, 0, 1e-3, 'peak');
    near(ex, 30, 1e-6, 'chord end');
    // every control point stays within the original box + 1/3 bump overshoot of the control polygon
    for (const c of cs) for (let i = 0; i < 6; i += 2) assert.ok(c[i] >= -4 && c[i] <= 104 && c[i + 1] >= -4 && c[i + 1] <= 104);
  });

  test('polygon orientation does not flip the bumps inward', () => {
    const cw = cloudPathOf([[0, 0], [40, 0], [40, 40], [0, 40]], 10);
    const ccw = cloudPathOf([[0, 0], [0, 40], [40, 40], [40, 0]], 10);
    assert.ok(curves(cw)[0][1] < 0, 'top edge bumps go up (clockwise)');
    assert.ok(curves(ccw)[0][0] < 0, 'left edge bumps go left (counter-clockwise)');
    assert.equal(cloudPathOf([[0, 0], [1, 1]], 5), '');
  });

  test('arc size is clamped to the box', () => {
    assert.equal(cloudArc({ w: 100, h: 100 }), 12);
    assert.equal(cloudArc({ w: 100, h: 8, arcSize: 30 }), 4);
  });
});

describe('cloud annotation', () => {
  const obj = { id: 'cl', page: 0, type: 'cloud', x: 60, y: 80, w: 160, h: 90, stroke: '#d62828', strokeWidth: 1.5, arcSize: 14, opacity: 1 };

  test('saved as /Square with a cloudy border effect and read back as a cloud', async () => {
    const out = await writeAnnotations(await makePdf(1), { add: [obj] }, { author: 'Ahmad', now: '2026-10-08T00:00:00Z' });
    const doc = await PDFDocument.load(out);
    const annot = doc.getPage(0).node.Annots().lookup(0, PDFDict);
    assert.equal(annot.lookup(PDFName.of('Subtype')).asString(), '/Square');
    const be = annot.lookup(PDFName.of('BE'), PDFDict);
    assert.equal(be.lookup(PDFName.of('S')).asString(), '/C');
    assert.ok(annot.lookup(PDFName.of('RD')), '/RD present');
    const { objects, skipped } = await readAnnotations(out);
    assert.deepEqual(skipped, []);
    const got = objects.find((o) => o.id === 'cl');
    assert.equal(got.type, 'cloud');
    for (const k of ['x', 'y', 'w', 'h', 'arcSize', 'strokeWidth']) near(got[k], obj[k], 0.01, k);
    assert.equal(got.stroke, '#d62828');
  });

  test('flattenObjects burns the cloud in', async () => {
    const out = await flattenObjects(await makePdf(1), [{ ...obj, fill: '#ffff00', dash: 'dotted' }]);
    assert.ok(out.length > 0);
    await PDFDocument.load(out);
  });
});
