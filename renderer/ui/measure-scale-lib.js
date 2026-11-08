// Pure helpers of the Measure scale dialog (renderer/ui/measure-scale.js): presets, parsing of typed
// entries, calibration checks and labels. No DOM; unit-tested in test/measure-scale-lib.test.js.
import { scaleFromDrawingScale, scaleFromPaper, scaleFromCalibration } from '../../src/core/measure.js';

/** Drawing scale presets 1:n. */
export const DRAWING_PRESETS = [1, 2, 5, 10, 20, 25, 50, 75, 100, 200, 250, 500, 1000];
export const METRIC_UNITS = ['mm', 'cm', 'm'];
export const CALIBRATION_UNITS = ['mm', 'cm', 'm', 'in', 'ft'];
/** Imperial presets: `paper` inches on the sheet = `real` feet. */
export const IMPERIAL_PRESETS = [
  { label: '1/8" = 1\'-0"', paper: 1 / 8, real: 1 },
  { label: '3/16" = 1\'-0"', paper: 3 / 16, real: 1 },
  { label: '1/4" = 1\'-0"', paper: 1 / 4, real: 1 },
  { label: '1/2" = 1\'-0"', paper: 1 / 2, real: 1 },
  { label: '1" = 1\'-0"', paper: 1, real: 1 },
  { label: '1" = 10\'', paper: 1, real: 10 },
  { label: '1" = 20\'', paper: 1, real: 20 },
  { label: '1" = 50\'', paper: 1, real: 50 },
];
/** Precision choices: decimals, or the fraction of an inch (denominator) for feet-and-inches. */
export const DECIMALS = [0, 1, 2, 3];
export const FRACTIONS = [16, 8, 4, 2];
/** A calibration line shorter than this (points) is refused. */
export const MIN_CALIBRATION_PT = 5;

const NUM = String.raw`\d+(?:[.,]\d+)?|[.,]\d+`;
const num = (s) => Number(s.replace(',', '.'));

/** Custom drawing scale "1:75", "1 : 75" or "75" -> 75; null when not a positive number. */
export function parseRatio(text) {
  const m = new RegExp(String.raw`^\s*(?:1\s*:\s*)?(${NUM})\s*$`).exec(String(text ?? ''));
  const n = m ? num(m[1]) : NaN;
  return n > 0 && Number.isFinite(n) ? n : null;
}

/** Inches as "6", "6.5", "6 1/2", "1/2" -> number, or NaN. */
function inches(s) {
  const m = new RegExp(String.raw`^(?:(${NUM})(?:\s+(\d+)\/(\d+))?|(\d+)\/(\d+))$`).exec(s.trim());
  if (!m) return NaN;
  if (m[4]) return Number(m[5]) ? Number(m[4]) / Number(m[5]) : NaN;
  const frac = m[2] ? (Number(m[3]) ? Number(m[2]) / Number(m[3]) : NaN) : 0;
  return num(m[1]) + frac;
}

/**
 * Feet and inches as typed -> decimal feet, or null: 12'-6", 12' 6 1/2", 12', 6", 12.5', and a plain
 * number is feet. Never negative or zero.
 */
export function parseFeetInches(text) {
  const s = String(text ?? '').trim().replace(/[′’]/g, "'").replace(/[″”]|''/g, '"');
  let ft = NaN;
  const fi = /^([^'"]+)'(?:\s*-?\s*([^'"]*?)\s*"?)?$/.exec(s);
  if (fi) {
    const f = new RegExp(String.raw`^(${NUM})$`).test(fi[1].trim()) ? num(fi[1].trim()) : NaN;
    const i = fi[2] ? inches(fi[2]) : 0;
    ft = f + i / 12;
  } else if (/^[^'"]+"$/.test(s)) ft = inches(s.slice(0, -1)) / 12;
  else if (new RegExp(String.raw`^(${NUM})$`).test(s)) ft = num(s);
  return ft > 0 && Number.isFinite(ft) ? ft : null;
}

/** A real length typed in `unit` -> number, or null. 'ft' takes feet-and-inches, 'in' takes fractions. */
export function parseLength(text, unit) {
  if (unit === 'ft') return parseFeetInches(text);
  const s = String(text ?? '').trim().replace(/\s*(mm|cm|m|in|")$/, '');
  const n = unit === 'in' ? inches(s) : new RegExp(String.raw`^(${NUM})$`).test(s) ? num(s) : NaN;
  return n > 0 && Number.isFinite(n) ? n : null;
}

/** The refusal message for a calibration line of `lengthPt` points, or null when it is long enough. */
export function calibrationError(lengthPt) {
  return lengthPt >= MIN_CALIBRATION_PT ? null : `The line is too short to calibrate (under ${MIN_CALIBRATION_PT} pt). Click two points further apart.`;
}

/** Point b moved onto the nearest 0/45/90° direction from a, keeping its distance (Shift while picking). */
export function snapAngle(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
  if (!L) return { ...b };
  const t = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const r = (v) => Math.round(v * 1e9) / 1e9;
  return { x: r(a.x + L * Math.cos(t)), y: r(a.y + L * Math.sin(t)) };
}

/** The dialog's choice -> a scale. f: {mode: 'metric'|'imperial'|'calibrated', n, unit, imperial (index), display: 'ftin'|'decimal', precision, lengthPt, real (number)}. */
export function buildScale(f) {
  const arch = (unit) => unit === 'ft' && f.display === 'ftin';
  const opts = (unit) => (arch(unit) ? { precision: f.precision, style: 'architectural' } : { precision: f.precision });
  if (f.mode === 'imperial') {
    const p = IMPERIAL_PRESETS[f.imperial];
    return scaleFromPaper(p.paper, 'in', p.real, 'ft', { ...opts('ft'), label: p.label });
  }
  if (f.mode === 'calibrated') return scaleFromCalibration(f.lengthPt, f.real, f.unit, opts(f.unit));
  return scaleFromDrawingScale(f.n, f.unit, { precision: f.precision });
}

/** The precision choices for a unit and display: [{value, label}]. */
export function precisionChoices(unit, display) {
  if (unit === 'ft' && display === 'ftin') return FRACTIONS.map((d) => ({ value: d, label: `1/${d}"` }));
  return DECIMALS.map((d) => ({ value: d, label: d ? `0.${'0'.repeat(d - 1)}1` : '1' }));
}

/** The units shown for a scale: "ft-in" for feet-and-inches, else its unit. */
export const unitLabel = (scale) => (scale.style === 'architectural' ? 'ft-in' : scale.unit);

/** Where a page scale comes from, for the dialog: "From the PDF", "Calibrated", the preset ("1:50"), "Default". */
export function sourceText({ scale, source }) {
  return { pdf: 'From the PDF', calibrated: 'Calibrated', default: 'Default' }[source] ?? scale.label;
}

/** The options-bar chip text: "Scale 1:50 (mm)", "Scale calibrated (mm)". */
export function chipText({ scale, source }) {
  const name = source === 'calibrated' || /^Calibrated/.test(scale.label) ? 'calibrated' : scale.label;
  return `Scale ${name} (${unitLabel(scale)})`;
}

/** The dialog's starting choice for the page's current scale: {mode, n, unit, imperial, display, precision}. */
export function formFromScale(scale) {
  const f = { mode: 'metric', n: 50, unit: 'mm', imperial: 2, display: 'ftin', precision: 0 };
  const imp = IMPERIAL_PRESETS.findIndex((p) => p.label === scale.label);
  const ratio = /^1:(\d+(?:\.\d+)?)$/.exec(scale.label ?? '');
  if (imp >= 0) Object.assign(f, { mode: 'imperial', imperial: imp, display: scale.style === 'architectural' ? 'ftin' : 'decimal', precision: scale.precision });
  else if (ratio && METRIC_UNITS.includes(scale.unit)) Object.assign(f, { n: Number(ratio[1]), unit: scale.unit, precision: scale.precision });
  if (!precisionChoices(f.mode === 'imperial' ? 'ft' : f.unit, f.display).some((c) => c.value === f.precision)) f.precision = precisionChoices(f.mode === 'imperial' ? 'ft' : f.unit, f.display)[0].value;
  return f;
}
