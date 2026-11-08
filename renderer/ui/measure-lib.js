// Pure helpers for measurement objects in the editor (no DOM), unit-tested in test/measure-lib.test.js.
// A measurement object is a line / arrow / polyline / polygon with measure: { kind, scale, value?, label? }
// (src/core/annots.js); geometry is in visible page points.
import { measurePoints } from '../../src/core/measure.js';

/** Fill opacity of an area measurement without a fill of its own (its stroke colour). */
export const AREA_FILL_OPACITY = 0.2;
/** Caption font size in page points (the core's appearance uses the same). */
export const LABEL_FONT = 9;
const LABEL_PAD = 2;
const CHAR_EM = 0.556; // Helvetica digit advance

/** The points a measurement object measures. */
export const measuredPoints = (o) => (o.type === 'line' || o.type === 'arrow' ? [[o.x1, o.y1], [o.x2, o.y2]] : o.points);

/** o.measure with value and label re-computed from o's geometry and scale (a polygon's perimeter is closed). */
export function withValue(o) {
  const m = measurePoints(o.measure.kind, measuredPoints(o), o.measure.scale, o.type === 'polygon');
  return { ...o.measure, value: m.value, label: m.text };
}

/**
 * The caption's box {x, y, w, h, text, fontSize} in page points, centred where the core draws it: a
 * line's midpoint, a polyline's middle vertex, a polygon's vertex average. null without a usable scale.
 */
export function labelBox(o, fontSize = LABEL_FONT) {
  if (!o.measure?.scale) return null;
  const text = withValue(o).label;
  const pts = measuredPoints(o);
  let c;
  if (o.type === 'polygon') c = [0, 1].map((k) => pts.reduce((s, p) => s + p[k], 0) / pts.length);
  else if (pts.length === 2) c = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
  else c = pts[Math.floor(pts.length / 2)];
  const w = text.length * fontSize * CHAR_EM + 2 * LABEL_PAD, h = fontSize * 1.2 + 2 * LABEL_PAD;
  return { x: c[0] - w / 2, y: c[1] - h / 2, w, h, text, fontSize };
}

/** Tick marks [x1, y1, x2, y2] of length `len` across both ends of a line, perpendicular to it. */
export function tickSegments(o, len) {
  const dx = o.x2 - o.x1, dy = o.y2 - o.y1, L = Math.hypot(dx, dy);
  if (!L) return [];
  const nx = (-dy / L) * (len / 2), ny = (dx / L) * (len / 2);
  return [[o.x1, o.y1], [o.x2, o.y2]].map(([x, y]) => [x - nx, y - ny, x + nx, y + ny]);
}

/** Even-odd point-in-polygon test. */
export function pointInPolygon(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
