// Revision-cloud geometry shared by the overlay (renderer/ui/annotations.js), the flattener
// (annotate.js) and the annotation writer (annots.js). Visible space, y down.

export const DEFAULT_ARC = 12;
const f = (n) => Math.round(n * 1000) / 1000 + 0;

/** Arc size of a cloud object (diameter of one scallop), clamped to something drawable. */
export function cloudArc(o) {
  const a = Number.isFinite(o.arcSize) && o.arcSize > 0 ? o.arcSize : DEFAULT_ARC;
  return Math.max(2, Math.min(a, Math.min(o.w, o.h) / 2 || a));
}

/** Corners of the polygon the scallops sit on: the box inset by one scallop height (arc / 2). */
export function cloudPolygon(o) {
  const r = cloudArc(o) / 2;
  const x0 = o.x + r, y0 = o.y + r, x1 = o.x + o.w - r, y1 = o.y + o.h - r;
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

/**
 * SVG path of a scalloped border along a closed polygon: each edge is split into equal chords of
 * about `arc`, and each chord gets a cubic bump bulging outward whose peak is chord / 2 off the
 * edge (a semicircle approximation). Works for any simple polygon, either orientation.
 */
export function cloudPathOf(points, arc) {
  const n = points.length;
  if (n < 3) return '';
  let area = 0;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = points[i], [bx, by] = points[(i + 1) % n];
    area += ax * by - bx * ay;
  }
  const out = area >= 0 ? 1 : -1; // y down: positive area = clockwise on screen, outward = (dy, -dx)
  let d = `M${f(points[0][0])} ${f(points[0][1])}`;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = points[i], [bx, by] = points[(i + 1) % n];
    const len = Math.hypot(bx - ax, by - ay);
    if (!len) continue;
    const k = Math.max(1, Math.round(len / arc));
    const ux = (bx - ax) / len, uy = (by - ay) / len;
    const c = ((4 / 3) * (len / k)) / 2; // control offset: cubic peak = 3/4 c = chord / 2
    const nx = out * uy * c, ny = -out * ux * c;
    for (let j = 0; j < k; j++) {
      const px = ax + ((bx - ax) * j) / k, py = ay + ((by - ay) * j) / k;
      const qx = ax + ((bx - ax) * (j + 1)) / k, qy = ay + ((by - ay) * (j + 1)) / k;
      d += `C${f(px + nx)} ${f(py + ny)} ${f(qx + nx)} ${f(qy + ny)} ${f(qx)} ${f(qy)}`;
    }
  }
  return d + 'Z';
}

/** Path of a cloud object {x, y, w, h, arcSize?}; the scallops stay inside the box. */
export const cloudPath = (o) => cloudPathOf(cloudPolygon(o), cloudArc(o));
