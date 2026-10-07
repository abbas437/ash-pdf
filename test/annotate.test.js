import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFDict } from 'pdf-lib';
import { flattenObjects, measureText, sanitizeText } from '../src/core/annotate.js';
import { getInfo } from '../src/core/pdfOps.js';
import { makePdf, makeGeometryFixture, visibleText, renderPage, pageContent, makeImage, near, isColor } from './helpers.js';

// Overridable so a deliberately broken copy of annotate.js can be checked (negative gate).
const flatten = process.env.ASH_ANNOTATE_MODULE
  ? (await import(process.env.ASH_ANNOTATE_MODULE)).flattenObjects
  : flattenObjects;

const ROTATIONS = [0, 90, 180, 270];
const RED = [255, 0, 0];
const WHITE = [255, 255, 255];
const BLUE = [0, 0, 255];

describe('flattenObjects geometry (non-zero MediaBox origin + CropBox)', () => {
  for (const rotation of ROTATIONS) {
    test(`text object lands at requested visible position, rotation ${rotation}`, async () => {
      const src = await makeGeometryFixture(rotation);
      const obj = { id: 't1', page: 0, type: 'text', x: 40, y: 60, w: 200, h: 40, text: 'Hello', fontSize: 14 };
      const out = await flatten(src, [obj]);
      const items = await visibleText(out);
      const hit = items.find((i) => i.str.includes('Hello'));
      assert.ok(hit, `text not extractable for rotation ${rotation}`);
      const m = measureText('Hello', { fontSize: 14, maxWidth: 200 });
      near(hit.x, 40, 2, `rotation ${rotation} x`);
      near(hit.y, 60 + m.firstBaseline, 2, `rotation ${rotation} baseline y`);
      assert.ok(hit.dirX > 0 && Math.abs(hit.dirY) < 1e-6, `rotation ${rotation}: text must read upright left-to-right`);
    });

    test(`rect object renders at the right pixels, rotation ${rotation}`, async () => {
      const src = await makeGeometryFixture(rotation);
      const out = await flatten(src, [{ id: 'r1', page: 0, type: 'rect', x: 100, y: 150, w: 80, h: 60, fill: '#ff0000', stroke: null }]);
      const { sample, width, height } = await renderPage(out);
      const info = await getInfo(src);
      near(width, info.pages[0].width, 1, 'rendered width = visible width');
      near(height, info.pages[0].height, 1, 'rendered height = visible height');
      assert.ok(isColor(sample(140, 180), RED), `centre should be red at rotation ${rotation}, got ${sample(140, 180)}`);
      assert.ok(isColor(sample(103, 153), RED), `inner top-left corner should be red at rotation ${rotation}`);
      assert.ok(isColor(sample(177, 207), RED), `inner bottom-right corner should be red at rotation ${rotation}`);
      for (const [x, y] of [[94, 180], [186, 180], [140, 144], [140, 216]]) {
        assert.ok(isColor(sample(x, y), WHITE), `(${x},${y}) just outside should be white at rotation ${rotation}, got ${sample(x, y)}`);
      }
    });
  }
});

describe('flattenObjects styles and object types', () => {
  test('dotted and dashed dash arrays are written to the content stream', async () => {
    const src = await makePdf(1);
    const out = await flatten(src, [
      { id: 'a', page: 0, type: 'rect', x: 10, y: 10, w: 50, h: 50, stroke: '#ff0000', strokeWidth: 2, dash: 'dotted' },
      { id: 'b', page: 0, type: 'ellipse', x: 100, y: 10, w: 50, h: 30, stroke: '#ff0000', strokeWidth: 1.5, dash: 'dashed' },
      { id: 'c', page: 0, type: 'line', x1: 10, y1: 100, x2: 200, y2: 100, stroke: '#0000ff', strokeWidth: 3, dash: 'dotted' },
    ]);
    const content = await pageContent(out);
    assert.match(content, /\[2 4\] 0 d/);
    assert.match(content, /\[7\.5 4\.5\] 0 d/);
    assert.match(content, /\[3 6\] 0 d/);
  });

  test('solid style writes no dash pattern', async () => {
    const out = await flatten(await makePdf(1), [{ id: 'a', page: 0, type: 'rect', x: 10, y: 10, w: 50, h: 50, dash: 'solid' }]);
    assert.doesNotMatch(await pageContent(out), /\[[0-9.][^\]]*\] 0 d/);
  });

  test('z-order follows array order (later object on top)', async () => {
    const src = await makePdf(1);
    const red = { id: 'r', page: 0, type: 'rect', x: 100, y: 100, w: 100, h: 100, fill: '#ff0000', stroke: null };
    const blue = { id: 'b', page: 0, type: 'rect', x: 150, y: 150, w: 100, h: 100, fill: '#0000ff', stroke: null };
    const a = await renderPage(await flatten(src, [red, blue]));
    assert.ok(isColor(a.sample(175, 175), BLUE));
    const b = await renderPage(await flatten(src, [blue, red]));
    assert.ok(isColor(b.sample(175, 175), RED));
  });

  test('every supported object type flattens and renders', async () => {
    const src = await makePdf(2);
    const objects = [
      { id: 1, page: 0, type: 'text', x: 20, y: 20, w: 150, h: 60, text: 'Line one\nLine two is long enough to wrap', fontSize: 10, font: 'Times', bold: true, italic: true, color: '#333333', align: 'center' },
      { id: 2, page: 0, type: 'rect', x: 20, y: 100, w: 60, h: 40, stroke: '#ff0000', strokeWidth: 1, fill: '#00ff00', opacity: 0.5, dash: 'dotted' },
      { id: 3, page: 0, type: 'ellipse', x: 100, y: 100, w: 60, h: 40, stroke: '#ff0000', dash: 'dotted' },
      { id: 4, page: 0, type: 'line', x1: 20, y1: 160, x2: 200, y2: 180, stroke: '#000000', strokeWidth: 2 },
      { id: 5, page: 0, type: 'arrow', x1: 20, y1: 200, x2: 200, y2: 220, stroke: '#0000ff', strokeWidth: 2, headSize: 12 },
      { id: 6, page: 0, type: 'polyline', points: [[20, 240], [60, 260], [100, 240], [140, 270]], stroke: '#ff00ff', strokeWidth: 2, smooth: true },
      { id: 7, page: 0, type: 'highlight', x: 20, y: 300, w: 100, h: 14, color: '#ffff00', opacity: 0.9 },
      { id: 8, page: 0, type: 'whiteout', x: 300, y: 300, w: 50, h: 20 },
      { id: 9, page: 1, type: 'image', x: 50, y: 50, w: 80, h: 40, bytes: makeImage('png'), mime: 'image/png', rotation: 30, opacity: 0.8 },
      { id: 10, page: 1, type: 'image', x: 200, y: 50, w: 80, h: 40, bytes: makeImage('jpg'), mime: 'image/jpeg' },
      { id: 11, page: 1, type: 'callout', x: 200, y: 200, w: 120, h: 40, text: 'Check duct size', tx: 150, ty: 300, stroke: '#ff0000', dash: 'dotted' },
      { id: 12, page: 1, type: 'stamp', x: 300, y: 400, w: 160, h: 50, text: 'APPROVED', color: '#008000', rotation: -15, borderWidth: 3 },
    ];
    const out = await flatten(src, objects);
    const t0 = (await visibleText(out, 0)).map((i) => i.str).join(' ');
    assert.match(t0, /Line one/);
    const t1 = (await visibleText(out, 1)).map((i) => i.str).join(' ');
    assert.match(t1, /Check duct size/);
    assert.match(t1, /APPROVED/);
    const r = await renderPage(out, 1);
    assert.ok(isColor(r.sample(240, 70), BLUE, 60), 'jpeg image pixels present');
  });

  test('callout leader ends in a filled arrowhead at the tip, matching the on-screen geometry', async () => {
    // Horizontal leader from the box's left edge (200,120) to the tip (100,120); strokeWidth 3 gives a
    // head 12pt long and 4.8pt half-wide (calloutArrowHead), wider than the 1.5pt half-width line.
    const obj = { id: 'c', page: 0, type: 'callout', x: 200, y: 100, w: 100, h: 40, text: 'x', tx: 100, ty: 120, stroke: '#ff0000', fill: null, strokeWidth: 3 };
    const r = await renderPage(await flatten(await makePdf(1), [obj]), 0, 4);
    assert.ok(isColor(r.sample(110.5, 123), RED), `head flank below the line should be red, got ${r.sample(110.5, 123)}`);
    assert.ok(isColor(r.sample(110.5, 117), RED), `head flank above the line should be red, got ${r.sample(110.5, 117)}`);
    assert.ok(isColor(r.sample(110.5, 125.5), WHITE), 'outside the head stays white');
    assert.ok(isColor(r.sample(150, 123), WHITE), 'the shaft itself is no wider than the stroke');
  });

  test('ink type is accepted as an alias of polyline', async () => {
    const out = await flatten(await makePdf(1), [{ id: 'i', page: 0, type: 'ink', points: [[10, 10], [50, 50]], stroke: '#000000' }]);
    assert.ok(out.length > 0);
  });

  test('highlight uses Multiply blend mode with opacity capped at 0.5', async () => {
    const out = await flatten(await makePdf(1), [{ id: 'h', page: 0, type: 'highlight', x: 10, y: 10, w: 50, h: 10, opacity: 0.9 }]);
    const doc = await PDFDocument.load(out);
    const gs = doc.getPage(0).node.Resources().lookup(PDFName.of('ExtGState'), PDFDict);
    const states = gs.keys().map((k) => gs.lookup(k, PDFDict));
    const hl = states.find((s) => String(s.get(PDFName.of('BM'))) === '/Multiply');
    assert.ok(hl, 'an ExtGState with /BM /Multiply exists');
    assert.ok(Number(String(hl.get(PDFName.of('ca')))) <= 0.5);
  });

  test('whiteout covers existing content in white', async () => {
    const src = await flatten(await makePdf(1), [{ id: 'r', page: 0, type: 'rect', x: 50, y: 50, w: 100, h: 100, fill: '#ff0000', stroke: null }]);
    const out = await flatten(src, [{ id: 'w', page: 0, type: 'whiteout', x: 60, y: 60, w: 40, h: 40 }]);
    const r = await renderPage(out);
    assert.ok(isColor(r.sample(80, 80), WHITE));
    assert.ok(isColor(r.sample(120, 120), RED));
  });

  test('unknown object type throws a TypeError naming the type', async () => {
    await assert.rejects(flatten(await makePdf(1), [{ id: 'x', page: 0, type: 'cloud', x: 0, y: 0, w: 1, h: 1 }]), (e) => e instanceof TypeError && /cloud/.test(e.message));
  });

  test('object on a non-existent page throws RangeError', async () => {
    await assert.rejects(flatten(await makePdf(1), [{ id: 'x', page: 3, type: 'rect', x: 0, y: 0, w: 1, h: 1 }]), RangeError);
  });

  test('invalid colour throws TypeError', async () => {
    await assert.rejects(flatten(await makePdf(1), [{ id: 'x', page: 0, type: 'rect', x: 0, y: 0, w: 1, h: 1, stroke: 'red' }]), TypeError);
  });

  test('does not mutate the input bytes', async () => {
    const src = await makePdf(1);
    const before = Buffer.from(src).toString('base64');
    await flatten(src, [{ id: 'r', page: 0, type: 'rect', x: 1, y: 1, w: 5, h: 5 }]);
    assert.equal(Buffer.from(src).toString('base64'), before);
  });

  test('non-WinAnsi characters are replaced with "?" in the output text', async () => {
    const out = await flatten(await makePdf(1), [{ id: 't', page: 0, type: 'text', x: 20, y: 20, w: 300, h: 20, text: 'Duct ΔP 中 ok', fontSize: 12 }]);
    const text = (await visibleText(out)).map((i) => i.str).join('');
    assert.match(text, /Duct \?P \? ok/);
  });
});

describe('measureText', () => {
  test('wraps to maxWidth and honours explicit newlines', () => {
    const m = measureText('alpha beta gamma delta\nepsilon', { fontSize: 10, maxWidth: 60 });
    assert.ok(m.lines.length >= 3);
    assert.equal(m.lines.at(-1), 'epsilon');
    assert.ok(m.lines.every((l) => measureText(l, { fontSize: 10 }).width <= 60 + 1e-6));
    near(m.height, m.lines.length * 12, 1e-9, 'height = lines * lineHeight');
  });

  test('hard-breaks a single word wider than the box', () => {
    const m = measureText('Supercalifragilistic', { fontSize: 12, maxWidth: 30 });
    assert.ok(m.lines.length > 1);
    assert.equal(m.lines.join(''), 'Supercalifragilistic');
  });

  test('bold is wider than regular; Courier is monospaced', () => {
    assert.ok(measureText('Hello', { bold: true }).width > measureText('Hello').width);
    near(measureText('iiii', { font: 'Courier', fontSize: 10 }).width, measureText('WWWW', { font: 'Courier', fontSize: 10 }).width, 1e-9, 'monospace');
  });

  test('sanitizeText maps CR/LF and tabs and replaces unencodable characters', () => {
    assert.equal(sanitizeText('a\r\nb\tc☃'), 'a\nb c?');
    assert.equal(sanitizeText('é€'), 'é€'); // WinAnsi has e-acute and euro
  });

  test('unknown font throws TypeError', () => {
    assert.throws(() => measureText('x', { font: 'Comic' }), TypeError);
  });
});

// Every overlay type the app can create (renderer/ui registerObjectType calls; tools-markup.js
// registers the TEXT_TYPES keys in a loop) must burn in: print and snapshot use flattenObjects.
async function registeredObjectTypes() {
  const { readdir, readFile } = await import('node:fs/promises');
  const dir = new URL('../renderer/ui/', import.meta.url);
  const types = new Set();
  for (const f of (await readdir(dir)).filter((n) => n.endsWith('.js'))) {
    const src = await readFile(new URL(f, dir), 'utf8');
    for (const m of src.matchAll(/registerObjectType\(\s*'([A-Za-z]+)'/g)) types.add(m[1]);
    if (/registerObjectType\(t,/.test(src)) {
      const body = src.match(/const TEXT_TYPES = \{([\s\S]*?)\n\};/)[1];
      for (const m of body.matchAll(/^\s+([A-Za-z]+):/gm)) types.add(m[1]);
    }
  }
  return types;
}

describe('flattenObjects draws every overlay type the app creates', () => {
  const img = makeImage('png');
  const quad = (y) => [[300, y, 400, y, 300, y + 14, 400, y + 14]];
  const SAMPLES = {
    text: { x: 40, y: 40, w: 150, h: 20, text: 'Text' },
    rect: { x: 40, y: 80, w: 60, h: 30, stroke: '#ff0000' },
    ellipse: { x: 120, y: 80, w: 60, h: 30, stroke: '#ff0000' },
    line: { x1: 40, y1: 130, x2: 140, y2: 130 },
    arrow: { x1: 40, y1: 150, x2: 140, y2: 150 },
    polyline: { points: [[40, 170], [90, 180], [140, 170]] },
    ink: { points: [[40, 190], [90, 200], [140, 190]] },
    highlight: { x: 40, y: 210, w: 100, h: 14, color: '#ffff00' },
    whiteout: { x: 40, y: 230, w: 50, h: 10 },
    image: { x: 40, y: 250, w: 40, h: 20, bytes: img, mime: 'image/png' },
    callout: { x: 40, y: 290, w: 120, h: 30, tx: 200, ty: 330, text: 'Callout' },
    stamp: { x: 40, y: 340, w: 120, h: 40, text: 'APPROVED', subtext: 'by A. Reviewer', color: '#c00000' },
    note: { x: 300, y: 40, color: '#ffd400', note: 'Sticky' },
    underline: { quads: quad(100), color: '#00a000', strokeWidth: 4 },
    strikeout: { quads: quad(130), color: '#e00000', strokeWidth: 4 },
    squiggly: { quads: quad(160), color: '#00a000' },
    textHighlight: { quads: quad(190), color: '#0000ff', opacity: 1 },
  };

  test('every registered type is accepted, and notes/markups are painted', async () => {
    const types = await registeredObjectTypes();
    for (const t of ['note', 'underline', 'strikeout', 'squiggly', 'textHighlight', 'stamp', 'image']) assert.ok(types.has(t), `registered types found: ${[...types]}`);
    const missing = [...types].filter((t) => !SAMPLES[t]);
    assert.deepEqual(missing, [], 'every registered type has a sample here');
    const objs = [...types].map((t, i) => ({ id: `o${i}`, page: 0, type: t, ...SAMPLES[t] }));
    const out = await flatten(await makePdf(1), objs);
    const r = await renderPage(out);
    assert.ok(isColor(r.sample(350, 197), BLUE, 60), 'textHighlight painted');
    assert.ok(isColor(r.sample(310, 46.5), [255, 212, 0], 60), 'note icon painted');
    assert.ok(isColor(r.sample(350, 112), [0, 160, 0], 70), 'underline painted');
    assert.ok(isColor(r.sample(350, 137), [224, 0, 0], 70), 'strikeout painted');
  });

  test('unknown type: throws by default, skipped with a warning when skipUnknown', async () => {
    const src = await makePdf(1);
    const objs = [{ id: 'a', page: 0, type: 'hologram', x: 1, y: 1, w: 5, h: 5 }, { id: 'b', page: 0, type: 'rect', x: 10, y: 10, w: 20, h: 20, fill: '#ff0000' }];
    await assert.rejects(flatten(src, objs), { name: 'TypeError', message: /Unknown overlay object type "hologram"/ });
    const warn = console.warn;
    const warned = [];
    console.warn = (...a) => warned.push(a.join(' '));
    try {
      const r = await renderPage(await flatten(src, objs, { skipUnknown: true }));
      assert.ok(isColor(r.sample(20, 20), RED), 'known objects still drawn');
    } finally {
      console.warn = warn;
    }
    assert.equal(warned.length, 1);
    assert.match(warned[0], /hologram/);
  });

  test('a text markup without quads is a TypeError', async () => {
    await assert.rejects(flatten(await makePdf(1), [{ id: 'u', page: 0, type: 'underline' }]), { name: 'TypeError', message: /needs quads/ });
  });
});
