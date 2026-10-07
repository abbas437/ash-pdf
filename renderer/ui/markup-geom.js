// Pure geometry for text markups (no DOM): page-space boxes of selected text fragments ->
// merged per line -> quads [TLx,TLy,TRx,TRy,BLx,BLy,BRx,BRy] in visible page space, where
// TL/TR/BL/BR are corners in the TEXT's own frame (so an underline runs along BL->BR even for
// text that reads top-to-bottom on a rotated page). Tested in test/markup.test.js.

/** Snap any angle (deg) to 0/90/180/270. */
export const snapAngle = (a) => ((Math.round((Number(a) || 0) / 90) * 90) % 360 + 360) % 360;

/**
 * Text direction in visible page space: the text layer is rotated by `mainRotation`
 * (/Rotate + view rotation); the view rotation is not part of page space; spans add their own.
 */
export function textAngle(mainRotation, viewRotation, spanRotation = 0) {
  return snapAngle(mainRotation - viewRotation + spanRotation);
}

/** Axis-aligned box {x0,y0,x1,y1} + text angle -> quad in text-frame corner order. */
export function boxToQuad({ x0, y0, x1, y1 }, angle = 0) {
  const c = {
    0: [[x0, y0], [x1, y0], [x0, y1], [x1, y1]],
    90: [[x1, y0], [x1, y1], [x0, y0], [x0, y1]],
    180: [[x1, y1], [x0, y1], [x1, y0], [x0, y0]],
    270: [[x0, y1], [x0, y0], [x1, y1], [x1, y0]],
  }[snapAngle(angle)];
  return c.flat();
}

/**
 * Merge fragment boxes [{x0,y0,x1,y1,angle}] that sit on the same line (same angle, cross-axis
 * extents overlapping by more than half the smaller one, gap along the line < one line height).
 * Zero-size boxes are dropped. Returns merged boxes in input order of their first fragment.
 */
export function mergeLines(boxes) {
  const out = [];
  for (const b0 of boxes) {
    if (!(b0.x1 - b0.x0 > 0.01 && b0.y1 - b0.y0 > 0.01)) continue;
    const b = { ...b0, angle: snapAngle(b0.angle) };
    const horiz = b.angle % 180 === 0;
    const cross = (r) => (horiz ? [r.y0, r.y1] : [r.x0, r.x1]);
    const along = (r) => (horiz ? [r.x0, r.x1] : [r.y0, r.y1]);
    const m = out.find((r) => {
      if (r.angle !== b.angle) return false;
      const [a0, a1] = cross(r), [c0, c1] = cross(b);
      const ov = Math.min(a1, c1) - Math.max(a0, c0);
      if (ov <= 0.5 * Math.min(a1 - a0, c1 - c0)) return false;
      const [p0, p1] = along(r), [q0, q1] = along(b);
      return Math.max(p0, q0) - Math.min(p1, q1) < Math.max(a1 - a0, c1 - c0);
    });
    if (m) Object.assign(m, { x0: Math.min(m.x0, b.x0), y0: Math.min(m.y0, b.y0), x1: Math.max(m.x1, b.x1), y1: Math.max(m.y1, b.y1) });
    else out.push(b);
  }
  return out;
}

export const quadsFromBoxes = (boxes) => mergeLines(boxes).map((b) => boxToQuad(b, b.angle));

/** Union bbox {x,y,w,h} of quads. */
export function quadsBox(quads) {
  const xs = quads.flatMap((q) => [q[0], q[2], q[4], q[6]]), ys = quads.flatMap((q) => [q[1], q[3], q[5], q[7]]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
