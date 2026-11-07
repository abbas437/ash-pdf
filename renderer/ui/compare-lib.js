// Compare revisions: pixel compare of two rendered pages (an older and a newer revision of a
// submittal). Pure: no DOM, no pdf.js, so test/compare-lib.test.js runs it in Node.
//
//   comparePages(a, b, width, height, opts?) -> {composite, regions, stats, shift, capped}
//       a, b: RGBA Uint8ClampedArray / Uint8Array of the same pixel size, rendered opaque on white
//       at the same scale; a = older revision, b = newer. Output is in b's frame (the newer page).
//   inkMask(rgba, w, h, opts?)        -> Uint8Array 0/1 per pixel
//   dilate(mask, w, h, r)             -> Uint8Array: max filter over a (2r+1)^2 square, O(n) in r
//   shiftMask(mask, w, h, dx, dy)     -> Uint8Array m'(x, y) = m(x - dx, y - dy) (outside: 0)
//   estimateShift(mA, mB, w, h, opts?) -> {dx, dy}: b's content is a's moved by (dx, dy)
//   findRegions(grid, opts?)          -> {regions, capped} from the changed-cell grid
//   onlyPage(rgba, w, h, side, opts?) -> composite of a page present in one revision only
//   regionsToPoints(regions, scale)   -> the regions with x/y/w/h divided by the render scale
//
// Ink: a pixel is ink when its luminance (0.299 R + 0.587 G + 0.114 B) is below inkThreshold
// (default 200 of 255), or when it is coloured: max(R,G,B) - min(R,G,B) >= chroma (default 48). The
// chroma rule catches light colours (a yellow line, a cyan hatch) without treating anti-aliasing
// greys or JPEG noise near white as ink.
//
// Classification (after the shift is applied to a): same = ink in a with ink in b within
// tolerancePx (or the reverse); removed = ink in a with no ink in b within tolerancePx; added =
// ink in b with no ink in a within tolerancePx. Tolerance uses dilated masks (separable max filter).
//
// Regions: changed pixels are binned into cell x cell squares (default 4 px); occupied cells are
// grouped by 8-connected components of the occupancy grid dilated by mergeGap / (2 cell) cells, then
// boxes within mergeGap px of each other merge, and regions with fewer than minArea changed pixels
// (added + removed) are dropped. Boxes are exact pixel bounds of their changed pixels. More than
// maxRegions (500) regions: regrouped with a doubling gap; still too many -> one box around every
// change with capped: true ("many changes").
//
// Alignment: the integer translation within +-maxShift (fraction of the page width / height, default
// 0.02) that maximises ink overlap. Exhaustive search on 1/8-scale masks (OR-pooled), then +-2 px
// refinement at 1/4, 1/2 and full scale; overlaps are counted on bit-packed rows (32 px per AND +
// popcount). Ties go to the smaller shift, so an unshifted page stays at (0, 0).

export const DEFAULTS = Object.freeze({
  inkThreshold: 200, chroma: 48, tolerancePx: 1, minArea: 8, mergeGap: 16, cell: 4, maxRegions: 500,
  maxShift: 0.02, align: true,
});

export const COLORS = Object.freeze({ same: [160, 160, 160], removed: [220, 0, 0], added: [0, 160, 0] });

const LITTLE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const pack32 = ([r, g, b]) => (LITTLE ? ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0 : ((r << 24) | (g << 16) | (b << 8) | 255) >>> 0);
const WHITE32 = 0xffffffff;

function checkSize(rgba, width, height, name) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new RangeError('width and height must be positive integers');
  if (!rgba || rgba.length !== width * height * 4) throw new RangeError(`${name}: expected ${width * height * 4} RGBA bytes, got ${rgba?.length}`);
}

/** 0/1 ink mask of an RGBA page (see the header for the rule). */
export function inkMask(rgba, width, height, { inkThreshold = DEFAULTS.inkThreshold, chroma = DEFAULTS.chroma } = {}) {
  const n = width * height;
  const out = new Uint8Array(n);
  const t = inkThreshold * 256; // 77 R + 150 G + 29 B = 256 x luminance
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = rgba[j], g = rgba[j + 1], b = rgba[j + 2];
    if ((r & g & b) === 255) continue; // white: the common case
    let mx = r > g ? r : g, mn = r < g ? r : g;
    if (b > mx) mx = b; else if (b < mn) mn = b;
    if (77 * r + 150 * g + 29 * b < t || mx - mn >= chroma) out[i] = 1;
  }
  return out;
}

/** Max filter with a (2r+1) x (2r+1) square window: two sliding-count passes, O(n) for any r. */
export function dilate(mask, width, height, r) {
  if (!(r > 0)) return mask;
  const tmp = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    const o = y * width;
    let c = 0;
    for (let x = 0; x < r && x < width; x++) c += mask[o + x];
    for (let x = 0; x < width; x++) {
      if (x + r < width) c += mask[o + x + r];
      if (x - r - 1 >= 0) c -= mask[o + x - r - 1];
      tmp[o + x] = c > 0 ? 1 : 0;
    }
  }
  const out = new Uint8Array(mask.length);
  const cnt = new Uint32Array(width);
  const addRow = (y, s) => { const o = y * width; for (let x = 0; x < width; x++) cnt[x] += s * tmp[o + x]; };
  for (let y = 0; y < r && y < height; y++) addRow(y, 1);
  for (let y = 0; y < height; y++) {
    if (y + r < height) addRow(y + r, 1);
    if (y - r - 1 >= 0) addRow(y - r - 1, -1);
    const o = y * width;
    for (let x = 0; x < width; x++) out[o + x] = cnt[x] > 0 ? 1 : 0;
  }
  return out;
}

/** m'(x, y) = m(x - dx, y - dy); pixels moved in from outside are 0. */
export function shiftMask(mask, width, height, dx, dy) {
  if (!dx && !dy) return mask;
  const out = new Uint8Array(mask.length);
  const x0 = Math.max(0, dx), x1 = Math.min(width, width + dx); // destination columns
  if (x1 <= x0) return out;
  for (let y = Math.max(0, dy); y < Math.min(height, height + dy); y++) {
    const src = (y - dy) * width;
    out.set(mask.subarray(src + x0 - dx, src + x1 - dx), y * width + x0);
  }
  return out;
}

// ---------------------------------------------------------------- alignment

function poolOr(mask, w, h) {
  const W = (w + 1) >> 1, H = (h + 1) >> 1;
  const out = new Uint8Array(W * H);
  for (let y = 0; y < h; y++) {
    const o = y * w, p = (y >> 1) * W;
    for (let x = 0; x < w; x++) if (mask[o + x]) out[p + (x >> 1)] = 1;
  }
  return { mask: out, w: W, h: H };
}

function packBits(mask, w, h) {
  const W = (w + 31) >> 5;
  const words = new Uint32Array(W * h);
  for (let y = 0; y < h; y++) {
    const o = y * w, p = y * W;
    for (let x = 0; x < w; x++) if (mask[o + x]) words[p + (x >> 5)] |= 1 << (x & 31);
  }
  return { words, W, h };
}

function popcnt(v) {
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

/** Number of pixels with ink in A at (x, y) and in B at (x + dx, y + dy). */
function overlap(A, B, dx, dy) {
  const { W, h } = A, aw = A.words, bw = B.words;
  const k0 = dx >> 5, s = dx & 31;
  let total = 0;
  for (let y = Math.max(0, -dy), y1 = Math.min(h, h - dy); y < y1; y++) {
    const ao = y * W, bo = (y + dy) * W;
    for (let i = 0; i < W; i++) {
      const a = aw[ao + i];
      if (a === 0) continue;
      const k = i + k0;
      const lo = k >= 0 && k < W ? bw[bo + k] : 0;
      const v = s === 0 ? lo : (lo >>> s) | ((k + 1 >= 0 && k + 1 < W ? bw[bo + k + 1] : 0) << (32 - s));
      if (v !== 0) total += popcnt(a & v);
    }
  }
  return total;
}

function bestShift(A, B, cx, cy, rx, ry) {
  let best = { dx: cx, dy: cy, score: -1 };
  for (let dy = cy - ry; dy <= cy + ry; dy++) {
    for (let dx = cx - rx; dx <= cx + rx; dx++) {
      const score = overlap(A, B, dx, dy);
      if (score > best.score || (score === best.score && Math.abs(dx) + Math.abs(dy) < Math.abs(best.dx) + Math.abs(best.dy))) best = { dx, dy, score };
    }
  }
  return best;
}

/** Translation (dx, dy) of b's ink relative to a's, within +-maxShift x the page size (see the header). */
export function estimateShift(maskA, maskB, width, height, { maxShift = DEFAULTS.maxShift } = {}) {
  const mx = Math.round(maxShift * width), my = Math.round(maxShift * height);
  if (mx < 1 && my < 1) return { dx: 0, dy: 0 };
  const levels = [{ a: maskA, b: maskB, w: width, h: height }];
  for (let i = 0; i < 3; i++) {
    const l = levels[i];
    const pa = poolOr(l.a, l.w, l.h), pb = poolOr(l.b, l.w, l.h);
    levels.push({ a: pa.mask, b: pb.mask, w: pa.w, h: pa.h });
  }
  const packed = levels.map((l) => [packBits(l.a, l.w, l.h), packBits(l.b, l.w, l.h)]);
  let k = levels.length - 1;
  const f = 1 << k;
  let best = bestShift(packed[k][0], packed[k][1], 0, 0, Math.ceil(mx / f), Math.ceil(my / f));
  for (k--; k >= 0; k--) best = bestShift(packed[k][0], packed[k][1], best.dx * 2, best.dy * 2, 2, 2);
  const dx = Math.max(-mx, Math.min(mx, best.dx)), dy = Math.max(-my, Math.min(my, best.dy));
  if (best.score <= 0 || overlap(packed[0][0], packed[0][1], dx, dy) <= overlap(packed[0][0], packed[0][1], 0, 0)) return { dx: 0, dy: 0 };
  return { dx, dy };
}

// ---------------------------------------------------------------- regions

/** Changed-pixel grid: per cell the added / removed counts and the changed pixels' bounds inside it. */
function makeGrid(width, height, cell) {
  const cw = Math.ceil(width / cell), ch = Math.ceil(height / cell), n = cw * ch;
  const minX = new Uint8Array(n).fill(255), minY = new Uint8Array(n).fill(255);
  return { width, height, cell, cw, ch, add: new Uint32Array(n), rem: new Uint32Array(n), minX, minY, maxX: new Uint8Array(n), maxY: new Uint8Array(n) };
}

function mark(g, x, y, removed) {
  const c = g.cell, cx = (x / c) | 0, cy = (y / c) | 0, i = cy * g.cw + cx;
  if (removed) g.rem[i]++; else g.add[i]++;
  const ox = x - cx * c, oy = y - cy * c;
  if (ox < g.minX[i]) g.minX[i] = ox;
  if (ox > g.maxX[i]) g.maxX[i] = ox;
  if (oy < g.minY[i]) g.minY[i] = oy;
  if (oy > g.maxY[i]) g.maxY[i] = oy;
}

function cluster(g, R) {
  const { cw, ch, cell } = g, n = cw * ch;
  const occ = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (g.add[i] || g.rem[i]) occ[i] = 1;
  const link = dilate(occ, cw, ch, R);
  const label = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const comps = [];
  for (let s = 0; s < n; s++) {
    if (!link[s] || label[s] >= 0) continue;
    const id = comps.length;
    const box = { x0: Infinity, y0: Infinity, x1: -1, y1: -1, added: 0, removed: 0 };
    comps.push(box);
    let sp = 0;
    stack[sp++] = s;
    label[s] = id;
    while (sp) {
      const i = stack[--sp], cx = i % cw, cy = (i - cx) / cw;
      if (occ[i]) {
        box.added += g.add[i];
        box.removed += g.rem[i];
        box.x0 = Math.min(box.x0, cx * cell + g.minX[i]);
        box.x1 = Math.max(box.x1, cx * cell + g.maxX[i]);
        box.y0 = Math.min(box.y0, cy * cell + g.minY[i]);
        box.y1 = Math.max(box.y1, cy * cell + g.maxY[i]);
      }
      for (let yy = Math.max(0, cy - 1); yy <= Math.min(ch - 1, cy + 1); yy++) {
        for (let xx = Math.max(0, cx - 1); xx <= Math.min(cw - 1, cx + 1); xx++) {
          const j = yy * cw + xx;
          if (link[j] && label[j] < 0) { label[j] = id; stack[sp++] = j; }
        }
      }
    }
  }
  return comps.filter((b) => b.x1 >= 0);
}

const gapOf = (a, b) => Math.max(b.x0 - a.x1, a.x0 - b.x1, b.y0 - a.y1, a.y0 - b.y1) - 1;

/** Merge boxes whose gap is at most `gap` px, until none are. */
function mergeNear(boxes, gap) {
  const out = boxes.slice();
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i], b = out[j];
        if (gapOf(a, b) > gap) continue;
        out[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), added: a.added + b.added, removed: a.removed + b.removed };
        out.splice(j, 1);
        changed = true;
        j = i; // re-test the grown box against everything after it
      }
    }
  }
  return out;
}

const toRegion = (b) => ({ x: b.x0, y: b.y0, w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1, added: b.added, removed: b.removed });

/** Regions of a changed-cell grid (see the header). */
export function findRegions(grid, { mergeGap = DEFAULTS.mergeGap, minArea = DEFAULTS.minArea, maxRegions = DEFAULTS.maxRegions } = {}) {
  const R0 = Math.max(0, Math.round(mergeGap / (2 * grid.cell)));
  const pass = (R, gap) => {
    const boxes = cluster(grid, R).filter((b) => b.added + b.removed >= minArea);
    return boxes.length <= 4 * maxRegions ? mergeNear(boxes, gap) : boxes;
  };
  let boxes = pass(R0, mergeGap);
  for (let k = 1; boxes.length > maxRegions && k <= 6; k++) boxes = pass((R0 + 1) << k, mergeGap << k);
  if (boxes.length > maxRegions) {
    const all = boxes.reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), added: a.added + b.added, removed: a.removed + b.removed }));
    return { regions: [toRegion(all)], capped: true };
  }
  boxes.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  return { regions: boxes.map(toRegion), capped: false };
}

// ---------------------------------------------------------------- compare

/** Compare two rendered pages (see the header). opts: DEFAULTS keys. */
export function comparePages(a, b, width, height, opts = {}) {
  checkSize(a, width, height, 'a');
  checkSize(b, width, height, 'b');
  const o = { ...DEFAULTS, ...opts };
  const mA = inkMask(a, width, height, o), mB = inkMask(b, width, height, o);
  const shift = o.align ? estimateShift(mA, mB, width, height, o) : { dx: 0, dy: 0 };
  const sA = shiftMask(mA, width, height, shift.dx, shift.dy);
  const r = Math.max(0, Math.round(o.tolerancePx));
  const dA = dilate(sA, width, height, r), dB = dilate(mB, width, height, r);
  const n = width * height;
  const composite = new Uint8ClampedArray(n * 4);
  const px = new Uint32Array(composite.buffer);
  px.fill(WHITE32);
  const SAME = pack32(COLORS.same), REM = pack32(COLORS.removed), ADD = pack32(COLORS.added);
  const grid = makeGrid(width, height, Math.max(1, Math.min(255, o.cell | 0)));
  let same = 0, added = 0, removed = 0;
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i++) {
      const ia = sA[i], ib = mB[i];
      if (!(ia | ib)) continue;
      if (ia && !dB[i]) { px[i] = REM; removed++; mark(grid, x, y, true); }
      else if (ib && !dA[i]) { px[i] = ADD; added++; mark(grid, x, y, false); }
      else { px[i] = SAME; same++; }
    }
  }
  const { regions, capped } = findRegions(grid, o);
  return { composite, regions, stats: { same, added, removed }, shift, capped };
}

/** Composite of a page that exists in one revision only: all ink red ('older' = removed page) or green ('newer'). */
export function onlyPage(rgba, width, height, side, opts = {}) {
  checkSize(rgba, width, height, 'rgba');
  const m = inkMask(rgba, width, height, { ...DEFAULTS, ...opts });
  const composite = new Uint8ClampedArray(width * height * 4);
  const px = new Uint32Array(composite.buffer);
  px.fill(WHITE32);
  const c = pack32(side === 'older' ? COLORS.removed : COLORS.added);
  for (let i = 0; i < m.length; i++) if (m[i]) px[i] = c;
  return composite;
}

/** Pixel regions -> PDF points (top-left origin) for a page rendered at `scale` px per point. */
export function regionsToPoints(regions, scale) {
  return regions.map((r) => ({ ...r, x: r.x / scale, y: r.y / scale, w: r.w / scale, h: r.h / scale }));
}
