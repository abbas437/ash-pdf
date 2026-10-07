// Stamp catalogue and pure helpers shared by the Stamp tool (renderer/ui/tools-stamp.js) and tests.
import { formatDate } from './siglib.js';

const GREEN = '#1b7f3b', RED = '#b42318', BLUE = '#1d4ed8', GREY = '#4b5563';
/** Standard stamps: [text, colour, borderWidth]. */
export const STANDARD_STAMPS = [
  ['APPROVED', GREEN, 2], ['APPROVED AS NOTED', GREEN, 2], ['NOT APPROVED', RED, 2], ['REJECTED', RED, 3],
  ['REVISE AND RESUBMIT', RED, 2], ['DRAFT', GREY, 2], ['FINAL', GREEN, 3], ['CONFIDENTIAL', RED, 3],
  ['FOR COMMENT', BLUE, 2], ['FOR INFORMATION', BLUE, 2], ['RECEIVED', BLUE, 2], ['REVIEWED', GREEN, 2],
  ['REVISED', BLUE, 2], ['VOID', RED, 3], ['COMPLETED', GREEN, 2], ['PAID', GREEN, 3], ['COPY', GREY, 2],
  ['ORIGINAL', BLUE, 3], ['SIGN HERE', RED, 2], ['WITNESS', BLUE, 2],
].map(([text, color, borderWidth]) => ({ id: 'std-' + text.toLowerCase().replace(/\s+/g, '-'), text, color, borderWidth }));
/** Stamps whose second line is filled at placement. */
export const DYNAMIC_STAMPS = ['APPROVED', 'REVIEWED', 'RECEIVED', 'REJECTED', 'REVISED', 'COMPLETED']
  .map((t) => ({ ...STANDARD_STAMPS.find((s) => s.text === t), dynamic: true }))
  .map((s) => ({ ...s, id: s.id.replace('std-', 'dyn-') }));

/**
 * Second line of a dynamic stamp, e.g. "by A. Example · 2026-10-07 14:05".
 * opts: {author, showAuthor=true, showDate=true, showTime=false, dateFormat='YYYY-MM-DD'}.
 */
export function stampSubtext(date, { author = '', showAuthor = true, showDate = true, showTime = false, dateFormat = 'YYYY-MM-DD' } = {}) {
  const p = (n) => String(n).padStart(2, '0');
  const parts = [];
  if (showAuthor && String(author).trim()) parts.push(`by ${String(author).trim()}`);
  const when = [];
  if (showDate) when.push(formatDate(`${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`, dateFormat));
  if (showTime) when.push(`${p(date.getHours())}:${p(date.getMinutes())}`);
  if (when.length) parts.push(when.join(' '));
  return parts.join(' · ');
}

/** Border shapes of a text stamp; anything else reads as 'rect'. */
export const STAMP_SHAPES = ['rect', 'rounded', 'circle', 'ellipse'];
export const stampShape = (s) => (STAMP_SHAPES.includes(s) ? s : 'rect');
const ROUND_K = 0.94; // fraction of the text ellipse the text block's corners may reach

/**
 * Layout of a stamp box in visible space (y down). `w1`/`sw1` = width of text / subtext at
 * size 1, `capH` = cap height per unit size. `o.shape`: 'rect' (default) | 'rounded' | 'circle' | 'ellipse'.
 * Returns {shape, size, base, subSize, subBase} plus the border geometry: `corner` (rounded radius)
 * for the box shapes; for circle / ellipse `cx, cy` and `rings` [{rx, ry, width}] (ring centre lines,
 * outer then inner; empty without a border) with the text block's corners inside the inner ring.
 */
export function stampLayout(o, w1, sw1, capH) {
  const shape = stampShape(o.shape);
  const bw = Number.isFinite(o.borderWidth) ? o.borderWidth : 3;
  if (shape === 'circle' || shape === 'ellipse') return roundLayout(o, shape, bw, w1, sw1, capH);
  const corner = shape === 'rounded' ? Math.min(o.w, o.h) * 0.25 : 0;
  const pad = bw + 4 + corner * 0.3;
  const iw = Math.max(1, o.w - 2 * pad), ih = Math.max(1, o.h - 2 * pad);
  if (!o.subtext) {
    const size = Math.max(1, Math.min(iw / (w1 || 1), ih / capH));
    return { shape, corner, size, base: o.y + o.h / 2 + (capH * size) / 2 };
  }
  const size = Math.max(1, Math.min(iw / (w1 || 1), (ih * 0.6) / capH));
  const subSize = Math.max(1, Math.min(iw / (sw1 || 1), (ih * 0.28) / capH, size * 0.6));
  const gap = capH * size * 0.3, total = capH * (size + subSize) + gap;
  const base = o.y + (o.h - total) / 2 + capH * size;
  return { shape, corner, size, base, subSize, subBase: base + gap + capH * subSize };
}

/** Circle (centred in the box, diameter = shorter side) or ellipse (the box): double ring, centred text. */
function roundLayout(o, shape, bw, w1, sw1, capH) {
  const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
  const R = Math.min(o.w, o.h) / 2;
  const rx = shape === 'circle' ? R : o.w / 2, ry = shape === 'circle' ? R : o.h / 2;
  const rings = [];
  let inset = 3;
  if (bw > 0) {
    const inner = Math.max(0.75, bw * 0.5), gap = bw + 1.5;
    rings.push({ rx: rx - bw / 2, ry: ry - bw / 2, width: bw }, { rx: rx - bw - gap - inner / 2, ry: ry - bw - gap - inner / 2, width: inner });
    inset += bw + gap + inner;
  }
  const a = Math.max(1, rx - inset), b = Math.max(1, ry - inset);
  // Largest size s whose block (s*bw1 x s*bh1) has its corners on the ellipse ROUND_K*(a, b).
  const fit = (bw1, bh1) => ROUND_K / Math.hypot(bw1 / (2 * a), bh1 / (2 * b));
  if (!o.subtext) {
    const size = Math.max(1, fit(w1 || 1, capH));
    return { shape, cx, cy, rings, size, base: cy + (capH * size) / 2 };
  }
  const size = Math.max(1, fit(Math.max(w1 || 1, 0.6 * (sw1 || 1)), capH * 1.9));
  const subSize = size * 0.6, gap = capH * size * 0.3, total = capH * (size + subSize) + gap;
  const base = cy - total / 2 + capH * size;
  return { shape, cx, cy, rings, size, base, subSize, subBase: base + gap + capH * subSize };
}
