// Pure helpers of measurements.js (no DOM), unit-tested in test/measurements-lib.test.js.
// A row per measurement object (an annotation with measure: { kind, scale, value?, label? }); the
// value is re-computed from the geometry when the object has a scale (measure-lib.js withValue).
import { areaUnit, format } from '../../src/core/measure.js';
import { withValue, measuredPoints } from './measure-lib.js';
import { csvCell } from './comments-lib.js';

export const KINDS = ['distance', 'perimeter', 'area'];
export const KIND_LABELS = { distance: 'Distance', perimeter: 'Perimeter', area: 'Area' };

/** Top-left of the measured points (visible page points, y down), for the in-page order. */
function topLeft(o) {
  const pts = measuredPoints(o) ?? [];
  return pts.length ? [Math.min(...pts.map((p) => p[1])), Math.min(...pts.map((p) => p[0]))] : [0, 0];
}

/**
 * [{page (1-based), kind, value, unit, text, scaleLabel, label, id}] of the measurement objects, by
 * page, then top to bottom, then left to right. value is at full precision; text is the displayed
 * value ("2500 mm"); unit is squared for areas ("m²"); label is the object's comment.
 */
export function measurementRows(objects) {
  const rows = [];
  objects.forEach((o, order) => {
    if (!KINDS.includes(o?.measure?.kind)) return;
    const m = o.measure.scale ? withValue(o) : o.measure;
    if (!Number.isFinite(m.value)) return;
    const unit = m.scale?.unit ?? '';
    rows.push({
      page: o.page + 1, kind: m.kind, value: m.value, unit: m.kind === 'area' && unit ? areaUnit(unit) : unit,
      text: m.label ?? String(m.value), scaleLabel: m.scale?.label ?? '', label: o.note ?? '', id: o.id,
      _pos: [...topLeft(o), order],
    });
  });
  rows.sort((a, b) => a.page - b.page || a._pos[0] - b._pos[0] || a._pos[1] - b._pos[1] || a._pos[2] - b._pos[2]);
  return rows.map(({ _pos, ...r }) => r);
}

/** [{kind, unit, total, count, text}] per kind and unit, kinds in KINDS order then by unit; text = "12.500 m". */
export function measurementTotals(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.kind}\u0000${r.unit}`;
    if (!groups.has(key)) groups.set(key, { kind: r.kind, unit: r.unit, total: 0, count: 0 });
    const g = groups.get(key);
    g.total += r.value;
    g.count++;
  }
  return [...groups.values()]
    .sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.unit.localeCompare(b.unit))
    .map((g) => ({ ...g, text: g.kind === 'area' ? format(g.total, g.unit.replace(/²$/, ''), undefined, 'area') : format(g.total, g.unit) }));
}

/** UTF-8 CSV text (with BOM, CRLF, like the comments export): Page,Kind,Value,Unit,Scale,Label; values at full precision. */
export function measurementsCsv(rows) {
  const out = [['Page', 'Kind', 'Value', 'Unit', 'Scale', 'Label']];
  for (const r of rows) out.push([r.page, KIND_LABELS[r.kind], String(r.value), r.unit, r.scaleLabel, r.label]);
  return '﻿' + out.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
