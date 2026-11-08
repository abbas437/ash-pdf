// Measurement scales for ASH PDF Studio: a pure library (no pdf-lib). Geometry is in PDF points
// (1/72 in, no /UserUnit); a scale turns points into real units. The PDF measurement dictionary
// (ISO 32000-1 §12.9 / ISO 32000-2 §12.10: /Measure /Subtype /RL, /NumberFormat, /Viewport) is
// produced and read here as plain data; annots.js turns it into PDF objects.

const MM_PER_PT = 25.4 / 72;
/** millimetres per unit */
export const MM_PER = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };
export const UNITS = Object.keys(MM_PER);
const DEF_DIST = { mm: 0, cm: 1, m: 3, in: 2, ft: 2 };
const DEF_AREA = { mm: 0, cm: 1, m: 2, in: 2, ft: 2 };
const ARCH_DEN = 16;

const isUnit = (u) => Object.hasOwn(MM_PER, u);
const fmtNum = (n) => String(Math.round(n * 1e6) / 1e6 + 0);

/**
 * A scale: { ratio: real units per PDF point, unit, label, precision, style? }.
 * precision = decimals, or the fraction denominator (16 = 1/16") when style is 'architectural' (unit 'ft').
 */
function makeScale(ratio, unit, label, precision, style) {
  if (!(ratio > 0) || !Number.isFinite(ratio)) throw new RangeError('scale ratio must be a positive number');
  const s = { ratio, unit, label, precision: precision ?? (style === 'architectural' ? ARCH_DEN : DEF_DIST[unit] ?? 2) };
  if (style === 'architectural') s.style = 'architectural';
  return s;
}

/** Drawing scale 1:n with real dimensions in `unit` (1:50 in mm: 1 pt = 25.4/72 x 50 mm). */
export function scaleFromDrawingScale(n, unit = 'mm', { precision, style } = {}) {
  if (!isUnit(unit)) throw new TypeError(`Unknown unit "${unit}"`);
  if (!(n > 0)) throw new RangeError('drawing scale must be positive');
  return makeScale((MM_PER_PT * n) / MM_PER[unit], unit, `1:${fmtNum(n)}`, precision, style);
}

/** `paper` `paperUnit` on the sheet = `real` `unit` (1/4" = 1'-0": scaleFromPaper(0.25, 'in', 1, 'ft')). */
export function scaleFromPaper(paper, paperUnit, real, unit, { precision, style, label } = {}) {
  if (!isUnit(paperUnit) || !isUnit(unit)) throw new TypeError('Unknown unit');
  const paperPt = (paper * MM_PER[paperUnit]) / MM_PER_PT;
  return makeScale(real / paperPt, unit, label ?? `${fmtNum(paper)} ${paperUnit} = ${fmtNum(real)} ${unit}`, precision, style);
}

/** A known dimension picked on the page: `lengthPt` points measure `realLength` `unit`. */
export function scaleFromCalibration(lengthPt, realLength, unit = 'mm', { precision, style } = {}) {
  if (!isUnit(unit)) throw new TypeError(`Unknown unit "${unit}"`);
  if (!(lengthPt > 0) || !(realLength > 0)) throw new RangeError('calibration needs a positive length and real length');
  return makeScale(realLength / lengthPt, unit, `Calibrated: ${fmtNum(realLength)} ${unit} = ${lengthPt.toFixed(1)} pt`, precision, style);
}

// ---------------------------------------------------------------- geometry (points)

const seg = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** Length of the open path through `points` ([[x, y], ...], points). */
export function distance(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += seg(points[i - 1], points[i]);
  return d;
}

/** Perimeter of the path; `closed` adds the closing side. */
export function perimeter(points, closed = false) {
  return distance(points) + (closed && points.length > 2 ? seg(points[points.length - 1], points[0]) : 0);
}

/** Area of the closed polygon (shoelace, absolute), square points. */
export function area(points) {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

/** A value in points (or square points for 'area') in the scale's units (or square units). */
export function toReal(valuePt, scale, kind = 'distance') {
  return kind === 'area' ? valuePt * scale.ratio * scale.ratio : valuePt * scale.ratio;
}

/**
 * kind 'distance' | 'perimeter' | 'area' of `points` with `scale`: { value, unit, text }. A perimeter
 * is the open path's length (Acrobat's PolyLineDimension) unless `closed` (a polygon).
 */
export function measurePoints(kind, points, scale, closed = false) {
  const pt = kind === 'area' ? area(points) : kind === 'perimeter' ? perimeter(points, closed) : distance(points);
  const value = toReal(pt, scale, kind === 'area' ? 'area' : 'distance');
  return { value, unit: scale.unit, text: formatScaled(value, scale, kind) };
}

// ---------------------------------------------------------------- formatting

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

/** Feet as 12'-6 1/2" to 1/`den` inch. */
function feetInches(ft, den) {
  const neg = ft < 0;
  const n = Math.round(Math.abs(ft) * 12 * den);
  const feet = Math.floor(n / (12 * den));
  const rem = n - feet * 12 * den;
  const whole = Math.floor(rem / den);
  let frac = rem - whole * den;
  let fs = '';
  if (frac) {
    const g = gcd(frac, den);
    fs = ` ${frac / g}/${den / g}`;
    frac = 0;
  }
  return `${neg && n ? '-' : ''}${feet}'-${whole}${fs}"`;
}

/** Area unit label of a length unit: mm -> mm². */
export const areaUnit = (unit) => `${unit}²`;

/**
 * A real value as text, locale-independent ('.' decimal point). kind 'area' uses square units (m² to 2
 * decimals by default). Unit 'ft' with style 'architectural' gives 12'-6 1/2" (precision = denominator, default 16).
 */
export function format(value, unit, precision, kind = 'distance', style) {
  if (kind === 'area') {
    const p = Number.isInteger(precision) && style !== 'architectural' ? precision : DEF_AREA[unit] ?? 2;
    return `${value.toFixed(p)} ${areaUnit(unit)}`;
  }
  if (unit === 'ft' && style === 'architectural') return feetInches(value, Number.isInteger(precision) && precision > 0 ? precision : ARCH_DEN);
  const p = Number.isInteger(precision) ? precision : DEF_DIST[unit] ?? 2;
  return `${value.toFixed(p)} ${unit}`;
}

/** format() with the scale's unit, precision and style ('perimeter' formats as a distance). */
export function formatScaled(value, scale, kind = 'distance') {
  return format(value, scale.unit, kind === 'area' ? undefined : scale.precision, kind === 'area' ? 'area' : 'distance', scale.style);
}

// ---------------------------------------------------------------- PDF measurement dictionary (plain data)

const AREA_U = (unit) => `sq ${unit}`;
const nf = (U, C, F, D) => ({ Type: 'NumberFormat', U, C, F, D });

/**
 * The /Measure dictionary of a scale as plain data (strings = text strings, except Type / Subtype / F,
 * which are names). /X[0] /C = scale units per point (§12.9.2: the first element converts default user
 * space units); /D and /A are relative to /X's first unit (/C 1: same unit). Architectural feet:
 * /X = [ft (truncated), in (/C 12, fractions of /D 16)].
 */
export function measureDict(scale) {
  const { ratio, unit, precision, style } = scale;
  const dec = (p) => 10 ** Math.max(0, Math.min(6, Number.isInteger(p) ? p : 2));
  const arch = unit === 'ft' && style === 'architectural';
  const xs = arch ? [nf('ft', ratio, 'T', 1), nf('in', 12, 'F', Number.isInteger(precision) && precision > 0 ? precision : ARCH_DEN)] : [nf(unit, ratio, 'D', dec(precision))];
  const ds = arch ? [nf('ft', 1, 'T', 1), nf('in', 12, 'F', xs[1].D)] : [nf(unit, 1, 'D', dec(precision))];
  return { Type: 'Measure', Subtype: 'RL', R: scale.label || '', X: xs, D: ds, A: [nf(AREA_U(unit), 1, 'D', dec(DEF_AREA[unit] ?? 2))] };
}

/** A unit name from a /NumberFormat /U ('mm', 'sq m', 'm²', 'ft', "'", '"', 'inch', ...), else null. */
function unitOf(u) {
  const s = String(u ?? '').trim().toLowerCase().replace(/^sq\.?\s*/, '').replace(/[²2]$/, '');
  if (isUnit(s)) return s;
  return { "'": 'ft', feet: 'ft', foot: 'ft', '"': 'in', inch: 'in', inches: 'in', millimeter: 'mm', millimetre: 'mm', centimeter: 'cm', centimetre: 'cm', meter: 'm', metre: 'm' }[s] ?? null;
}

const numOr = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * A scale from plain /Measure data (as measureDict returns, or read from a file), or null when it is
 * not a usable rectilinear measure. The scale's units are /D's first unit (else /X's): units per point
 * = X[0].C x D[0].C. A feet-then-inches array (/X or /D) reads as architectural feet.
 */
export function scaleFromMeasureDict(d) {
  if (!d || (d.Subtype && d.Subtype !== 'RL')) return null;
  const X = Array.isArray(d.X) ? d.X : [];
  if (!X.length) return null;
  let ratio = numOr(X[0].C, NaN);
  let arr = X;
  const D = Array.isArray(d.D) && d.D.length ? d.D : null;
  if (D) {
    ratio *= numOr(D[0].C, 1);
    arr = D;
  }
  const unit = unitOf(arr[0].U);
  if (!unit || !(ratio > 0)) return null;
  const second = arr[1];
  const arch = unit === 'ft' && second && unitOf(second.U) === 'in' && Math.abs(numOr(second.C, 12) - 12) < 1e-9;
  let precision;
  if (arch) precision = second.F === 'F' && numOr(second.D, 0) > 0 ? second.D : ARCH_DEN;
  else if (arr[0].F === 'D' || arr[0].F === undefined) precision = Math.max(0, Math.round(Math.log10(numOr(arr[0].D, 100))));
  return makeScale(ratio, unit, typeof d.R === 'string' ? d.R : '', precision, arch ? 'architectural' : undefined);
}

// ---------------------------------------------------------------- viewports (/VP)

/** A page /VP entry as plain data: { bbox: [x1 y1 x2 y2] PDF user space, name?, scale }. */
export function viewportDict(vp) {
  const b = vp.bbox;
  const out = { Type: 'Viewport', BBox: [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])] };
  if (vp.name) out.Name = vp.name;
  if (vp.scale) out.Measure = measureDict(vp.scale);
  return out;
}

/** The plain viewport read back from viewportDict-shaped data, or null without a usable /BBox. */
export function viewportFromDict(d) {
  const b = d?.BBox;
  if (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite)) return null;
  const vp = { bbox: [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])] };
  if (typeof d.Name === 'string') vp.name = d.Name;
  const s = d.Measure ? scaleFromMeasureDict(d.Measure) : null;
  if (s) vp.scale = s;
  return vp;
}

/**
 * The viewport that applies at PDF point [x, y]: §12.9.1 examines /VP in reverse order, the last one
 * whose /BBox contains the point wins. null when none does.
 */
export function viewportAt(vps, [x, y]) {
  for (let i = (vps?.length ?? 0) - 1; i >= 0; i--) {
    const b = vps[i].bbox;
    if (x >= Math.min(b[0], b[2]) && x <= Math.max(b[0], b[2]) && y >= Math.min(b[1], b[3]) && y <= Math.max(b[1], b[3])) return vps[i];
  }
  return null;
}
