// Crop pages: pure geometry and page choice for the Crop dialog and its "Draw on page" box.
// Rectangles are {x0, y0, x1, y1} in points on the page as displayed (top-left origin, y down,
// /Rotate applied), the same space as viewer.clientToPage and pdfOps.cropPagesToRect.

export const MM = 72 / 25.4;
export const unitFactor = (unit) => (unit === 'mm' ? MM : 1);
export const MIN_SIZE = 1; // points

/** Margins (points) on a page of `size` -> the box they leave. */
export function marginsToRect({ top = 0, right = 0, bottom = 0, left = 0 }, { width, height }) {
  return { x0: left, y0: top, x1: width - right, y1: height - bottom };
}

/** Box on a page of `size` -> the margins (points) that leave it. */
export function rectToMargins({ x0, y0, x1, y1 }, { width, height }) {
  return { top: y0, right: width - x1, bottom: height - y1, left: x0 };
}

/** Box intersected with the page; null when less than MIN_SIZE is left either way. */
export function clampRect({ x0, y0, x1, y1 }, { width, height }) {
  const r = { x0: Math.max(0, Math.min(x0, x1)), y0: Math.max(0, Math.min(y0, y1)), x1: Math.min(width, Math.max(x0, x1)), y1: Math.min(height, Math.max(y0, y1)) };
  return r.x1 - r.x0 < MIN_SIZE || r.y1 - r.y0 < MIN_SIZE ? null : r;
}

/**
 * Box a page of `size` keeps: a drawn `rect` is placed at the same position and clamped to the page;
 * typed `margins` are trimmed from the page's own edges. null when less than MIN_SIZE is left.
 */
export function cropBoxFor(size, { rect = null, margins = null }) {
  if (rect) return clampRect(rect, size);
  const r = marginsToRect(margins, size);
  return r.x1 - r.x0 < MIN_SIZE || r.y1 - r.y0 < MIN_SIZE ? null : r;
}

/** True when the pages' sizes ({width, height}) are not all the same (to 0.5 pt). */
export function sizesDiffer(sizes) {
  return sizes.some((s) => Math.abs(s.width - sizes[0].width) > 0.5 || Math.abs(s.height - sizes[0].height) > 0.5);
}

/** Box from two corner points, clamped to the page (not to MIN_SIZE). */
export function rectFromPoints(a, b, { width, height }) {
  const cx = (v) => Math.max(0, Math.min(width, v)), cy = (v) => Math.max(0, Math.min(height, v));
  return { x0: cx(Math.min(a.x, b.x)), y0: cy(Math.min(a.y, b.y)), x1: cx(Math.max(a.x, b.x)), y1: cy(Math.max(a.y, b.y)) };
}

/**
 * Drag a handle ('n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw') of `start` by (dx, dy), or 'move' the
 * whole box; kept inside the page and at least MIN_SIZE across.
 */
export function dragRect(start, handle, dx, dy, { width, height }) {
  let { x0, y0, x1, y1 } = start;
  if (handle === 'move') {
    const mx = Math.max(-x0, Math.min(width - x1, dx)), my = Math.max(-y0, Math.min(height - y1, dy));
    return { x0: x0 + mx, y0: y0 + my, x1: x1 + mx, y1: y1 + my };
  }
  if (handle.includes('w')) x0 = Math.max(0, Math.min(x1 - MIN_SIZE, x0 + dx));
  if (handle.includes('e')) x1 = Math.min(width, Math.max(x0 + MIN_SIZE, x1 + dx));
  if (handle.includes('n')) y0 = Math.max(0, Math.min(y1 - MIN_SIZE, y0 + dy));
  if (handle.includes('s')) y1 = Math.min(height, Math.max(y0 + MIN_SIZE, y1 + dy));
  return { x0, y0, x1, y1 };
}

/**
 * Pages the crop applies to (0-based, sorted). mode: 'current' | 'selected' | 'range' | 'odd' |
 * 'even' | 'all'; odd/even count from page 1. `parseRanges` is pdfOps.parseRanges (throws RangeError).
 */
export function pickPages(mode, { n, current = 0, selected = [], spec = '' }, parseRanges) {
  const all = Array.from({ length: n }, (_, i) => i);
  switch (mode) {
    case 'all': return all;
    case 'odd': return all.filter((i) => i % 2 === 0);
    case 'even': return all.filter((i) => i % 2 === 1);
    case 'selected': return [...selected].sort((a, b) => a - b);
    case 'range': return parseRanges(spec, n);
    default: return [current];
  }
}

/** "123.4 × 56.7 mm" for a box. */
export function sizeLabel({ x0, y0, x1, y1 }, unit) {
  const f = unitFactor(unit);
  return `${((x1 - x0) / f).toFixed(1)} × ${((y1 - y0) / f).toFixed(1)} ${unit}`;
}

// ---- Remove white margins: content box of a rendered page.
export const WHITE = 245; // a pixel is ink when any channel is below this
export const PAD_MM = 2;

export const SPECK_PX = 3;  // a speck spans at most 3 x 3 px (~0.8 mm at 96 dpi): a 0.2-0.5 mm dot, anti-aliased
export const SPECK_GAP_PX = 4; // ...with no other ink within 4 px (~1 mm): dots of a dotted line are kept

/**
 * Bounding box {x0, y0, x1, y1} (pixels, x1 / y1 exclusive) of the ink in an RGBA bitmap
 * (`data` of `width` x `height`); null for a blank page. A pixel is ink when any channel is below
 * `white` (alpha ignored: render on white). Specks are ignored: a connected (8-neighbour) group of
 * ink pixels no more than `speck` px across either way, with no other ink within `gap` px of it.
 * Thin content is kept: a hairline is long, a text line is many glyphs close together.
 */
export function inkBox(data, width, height, { white = WHITE, speck = SPECK_PX, gap = SPECK_GAP_PX } = {}) {
  const n = width * height;
  const label = new Int32Array(n); // 0 = paper, -1 = ink not yet labelled, k > 0 = group k
  for (let p = 0, q = 0; q < n; p += 4, q++) if (data[p] < white || data[p + 1] < white || data[p + 2] < white) label[q] = -1;
  const stack = new Int32Array(n);
  const boxes = []; // group k -> [x0, y0, x1, y1] (inclusive)
  for (let q0 = 0; q0 < n; q0++) {
    if (label[q0] !== -1) continue;
    const k = boxes.length + 1, b = [width, height, -1, -1];
    let top = 0;
    stack[top++] = q0; label[q0] = k;
    while (top) {
      const q = stack[--top], x = q % width, y = (q - x) / width;
      if (x < b[0]) b[0] = x;
      if (x > b[2]) b[2] = x;
      if (y < b[1]) b[1] = y;
      if (y > b[3]) b[3] = y;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1); yy++) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx++) {
          const r = yy * width + xx;
          if (label[r] === -1) { label[r] = k; stack[top++] = r; }
        }
      }
    }
    boxes.push(b);
  }
  const isolated = (k, [x0, y0, x1, y1]) => {
    for (let y = Math.max(0, y0 - gap); y <= Math.min(height - 1, y1 + gap); y++) {
      for (let x = Math.max(0, x0 - gap); x <= Math.min(width - 1, x1 + gap); x++) {
        const l = label[y * width + x];
        if (l && l !== k) return false;
      }
    }
    return true;
  };
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  boxes.forEach((b, j) => {
    if (b[2] - b[0] < speck && b[3] - b[1] < speck && isolated(j + 1, b)) return;
    if (b[0] < x0) x0 = b[0];
    if (b[1] < y0) y0 = b[1];
    if (b[2] > x1) x1 = b[2];
    if (b[3] > y1) y1 = b[3];
  });
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/**
 * Boxes {x, y, w, h} (page points as displayed) of what the app draws over page `i` itself, not in
 * the page's content: its overlay objects (tab.objects; `objectBox` is annotations.objectBox),
 * except whiteout, which only hides.
 */
export function overlayBoxes(tab, i, objectBox) {
  const out = [];
  for (const o of tab.objects ?? []) {
    if (o.page !== i || o.type === 'whiteout') continue;
    const b = objectBox(o);
    if (b) out.push(b);
  }
  return out;
}

/**
 * Margins (points) that trim a page of `size` (points, as displayed) to the ink box `box` of its
 * rendering `pxWidth` x `pxHeight` pixels joined with `extra` boxes ({x, y, w, h}, points: the
 * page's own overlay objects), padded by `pad` points and kept on the page; null when there is
 * neither ink nor an extra box.
 */
export function inkMargins(box, pxWidth, pxHeight, size, extra = [], pad = PAD_MM * MM) {
  const sx = size.width / pxWidth, sy = size.height / pxHeight;
  const rs = extra.map((b) => ({ x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h }));
  if (box) rs.push({ x0: box.x0 * sx, y0: box.y0 * sy, x1: box.x1 * sx, y1: box.y1 * sy });
  if (!rs.length) return null;
  const r = {
    x0: Math.max(0, Math.min(...rs.map((b) => b.x0)) - pad), y0: Math.max(0, Math.min(...rs.map((b) => b.y0)) - pad),
    x1: Math.min(size.width, Math.max(...rs.map((b) => b.x1)) + pad), y1: Math.min(size.height, Math.max(...rs.map((b) => b.y1)) + pad),
  };
  return rectToMargins(r, size);
}
