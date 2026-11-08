// Measure > Set scale: the page scale dialog (drawing scale, imperial, Calibrate…), the options-bar
// scale chip and the Tools menu item. The scale state itself lives in annotations.js
// (measureScaleOf / setMeasureScale); parsing and presets in measure-scale-lib.js.
//
// Calibrate… closes the dialog and runs a two-click pick on a page: the first click starts a preview
// line, Shift snaps it to 0/45/90°, the second click ends it, Esc cancels. A line under 5 pt is
// refused with a toast and the pick goes on. The dialog then reopens on the picked page with the
// picked length and fields for the real length.
import { bus } from '../bus.js';
import { activeTab } from '../state.js';
import { h } from './dom.js';
import { viewer } from './viewer.js';
import { annotations } from './annotations.js';
import { showDialog, toast } from './dialogs.js';
import {
  DRAWING_PRESETS, METRIC_UNITS, CALIBRATION_UNITS, IMPERIAL_PRESETS, parseRatio, parseLength, calibrationError,
  snapAngle, buildScale, precisionChoices, sourceText, chipText, unitLabel, formFromScale,
} from './measure-scale-lib.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Tools > Set measure scale… (the menus have no submenus). */
export function initMeasureScale({ registerMenuItem: M }) {
  M('Tools', { separator: true });
  M('Tools', { id: 'measure-scale', label: 'Set measure scale…', action: () => { const t = activeTab(); if (t) scaleDialog(t); }, enabled: () => !!activeTab()?.pdfDoc });
  for (const ev of ['page:changed', 'tab:activated', 'annotations:changed', 'tab:loaded']) bus.on(ev, refreshChips);
}

/** An options-bar control for registerTool({options}): "Scale 1:50 (mm)" of the current page; opens the dialog. */
export function scaleChip() {
  return (el) => {
    const b = h('button.tb-btn.opt-scale-chip', { type: 'button', title: 'Set the measure scale of this page', onclick: () => { const t = activeTab(); if (t) scaleDialog(t); } });
    el.append(b);
    refreshChips();
  };
}
function refreshChips() {
  const tab = activeTab();
  for (const b of document.querySelectorAll('.opt-scale-chip')) b.textContent = tab?.pdfDoc ? chipText(annotations.measureScaleOf(tab, tab.currentPage ?? 0)) : 'Scale';
}

/**
 * The scale dialog for `tab`'s current page. Resolves with the scale applied, or null when cancelled.
 * OK calls setMeasureScale (one undo step) for the page or for all pages.
 */
export async function scaleDialog(tab, { pageIndex = tab.currentPage ?? 0 } = {}) {
  const cur = annotations.measureScaleOf(tab, pageIndex);
  const f = { ...formFromScale(cur.scale), all: false, calib: null, real: '', calUnit: METRIC_UNITS.includes(cur.scale.unit) ? cur.scale.unit : 'mm' };
  for (;;) {
    const ui = form(tab, pageIndex, f);
    const v = await showDialog({
      title: 'Measure scale', body: ui.body, className: 'ms-dialog', help: 'measure',
      buttons: [
        { label: 'Calibrate…', value: 'calibrate', validate: () => { ui.read(); return true; } },
        { label: 'Cancel', value: 'cancel', cancel: true },
        { label: 'OK', value: 'ok', primary: true, validate: () => ui.validate() },
      ],
    });
    if (v === 'ok') {
      const scale = ui.scale();
      annotations.setMeasureScale(tab, f.all ? 'all' : pageIndex, scale, f.mode === 'calibrated' ? 'calibrated' : 'preset');
      refreshChips();
      return scale;
    }
    if (v !== 'calibrate') return null;
    const pick = await pickLine(tab, pageIndex);
    if (pick) { pageIndex = pick.pageIndex; Object.assign(f, { mode: 'calibrated', calib: pick.lengthPt }); }
  }
}

// The dialog body for form state `f` (kept across Calibrate… round trips).
function form(tab, pageIndex, f) {
  const cur = annotations.measureScaleOf(tab, pageIndex);
  const opt = (value, label, sel) => h('option', { value: String(value), selected: sel }, label);
  const radio = (mode, label) => h('label.ms-radio', {}, h('input', { type: 'radio', name: 'ms-mode', value: mode, checked: f.mode === mode, onchange: () => { f.mode = mode; sync(); } }), h('span', {}, label));
  const preset = h('select.input#ms-preset', { 'aria-label': 'Drawing scale', onchange: () => sync() },
    DRAWING_PRESETS.map((n) => opt(n, `1:${n}`, f.n === n)), opt('custom', 'Custom 1:n…', !DRAWING_PRESETS.includes(f.n)));
  const custom = h('input.input#ms-custom', { type: 'text', value: DRAWING_PRESETS.includes(f.n) ? '' : `1:${f.n}`, placeholder: '1:n', 'aria-label': 'Custom drawing scale' });
  const unit = h('select.input#ms-unit', { 'aria-label': 'Units', onchange: () => sync() }, METRIC_UNITS.map((u) => opt(u, u, f.unit === u)));
  const imperial = h('select.input#ms-imperial', { 'aria-label': 'Imperial scale' }, IMPERIAL_PRESETS.map((p, k) => opt(k, p.label, f.imperial === k)));
  const display = h('select.input#ms-display', { 'aria-label': 'Show as', onchange: () => sync() }, opt('ftin', 'Feet and inches', f.display === 'ftin'), opt('decimal', 'Decimal feet', f.display === 'decimal'));
  const real = h('input.input#ms-real', { type: 'text', value: f.real, placeholder: 'e.g. 1000 or 12\'-6"', 'aria-label': 'Real length' });
  const calUnit = h('select.input#ms-cal-unit', { 'aria-label': 'Real length units', onchange: () => sync() }, CALIBRATION_UNITS.map((u) => opt(u, u, f.calUnit === u)));
  const precision = h('select.input#ms-precision', { 'aria-label': 'Precision' });
  const err = h('p.ms-error', { role: 'alert' });
  const calRow = f.calib == null ? null : h('div.ms-row', {}, radio('calibrated', 'Calibrated'),
    h('span.ms-picked', {}, `Picked line: ${f.calib.toFixed(1)} pt =`), real, calUnit);
  const body = h('div.ms-form', {},
    h('p.ms-current', {}, `Page ${pageIndex + 1}: ${cur.scale.label} (${unitLabel(cur.scale)}) — `, h('span#ms-source', {}, sourceText(cur))),
    h('div.ms-row', {}, radio('metric', 'Drawing scale'), preset, custom, unit),
    h('div.ms-row', {}, radio('imperial', 'Imperial'), imperial, display),
    calRow,
    h('div.ms-row', {}, h('label.ms-label', { for: 'ms-precision' }, 'Precision'), precision),
    h('div.ms-row', {}, h('span.ms-label', {}, 'Apply to'),
      h('label.ms-radio', {}, h('input', { type: 'radio', name: 'ms-apply', value: 'page', checked: !f.all, onchange: () => { f.all = false; } }), h('span', {}, 'This page')),
      h('label.ms-radio', {}, h('input', { type: 'radio', name: 'ms-apply', value: 'all', checked: f.all, onchange: () => { f.all = true; } }), h('span', {}, 'All pages'))),
    err);
  function precisionUnit() { return f.mode === 'imperial' ? 'ft' : f.mode === 'calibrated' ? calUnit.value : unit.value; }
  function sync() {
    custom.hidden = preset.value !== 'custom';
    const choices = precisionChoices(precisionUnit(), display.value);
    const keep = choices.some((c) => c.value === Number(precision.value || f.precision)) ? Number(precision.value || f.precision) : choices[0].value;
    precision.replaceChildren(...choices.map((c) => opt(c.value, c.label, c.value === keep)));
    display.disabled = f.mode !== 'imperial' && !(f.mode === 'calibrated' && calUnit.value === 'ft');
  }
  function read() {
    f.n = preset.value === 'custom' ? (parseRatio(custom.value) ?? f.n) : Number(preset.value);
    Object.assign(f, { unit: unit.value, imperial: Number(imperial.value), display: display.value, precision: Number(precision.value), real: real.value, calUnit: calUnit.value });
  }
  function choice() {
    read();
    if (f.mode === 'metric' && preset.value === 'custom' && parseRatio(custom.value) == null) return { error: 'Enter the custom drawing scale as 1:n, for example 1:30.', focus: custom };
    if (f.mode === 'calibrated') {
      const r = parseLength(real.value, calUnit.value);
      if (r == null) return { error: `Enter the real length of the picked line in ${calUnit.value}${calUnit.value === 'ft' ? ', for example 12\'-6"' : ''}.`, focus: real };
      return { scale: buildScale({ ...f, lengthPt: f.calib, real: r, unit: calUnit.value }) };
    }
    return { scale: buildScale(f) };
  }
  sync();
  return {
    body, read,
    validate() { const c = choice(); err.textContent = c.error ?? ''; c.focus?.focus(); return !c.error; },
    scale: () => choice().scale,
  };
}

/**
 * Two-click line pick on a page of `tab` (any page; the second click is on the first click's page).
 * Resolves {pageIndex, lengthPt, a, b} in page points, or null on Esc / a click outside the pages.
 */
export function pickLine(tab, pageIndex = tab.currentPage ?? 0) {
  const scrollEl = viewer.getScrollEl(tab);
  return new Promise((resolve) => {
    let p = null; // {i, pe, a, b, svg, line}
    const hint = h('div.vx-snap-hint.ms-cal-hint', { role: 'status' }, `Click the two ends of a known dimension (page ${pageIndex + 1} or any page). Shift snaps to 0/45/90°. Esc cancels.`);
    document.body.append(hint);
    scrollEl.classList.add('vx-snapping');
    const pointOn = (i, e) => {
      const r = viewer.getPageEl(tab, i).getBoundingClientRect();
      const [ux, uy] = viewer.getViewport(tab, i).convertToPdfPoint(e.clientX - r.left, e.clientY - r.top);
      const [x, y] = tab.pages[i].getViewport({ scale: 1 }).convertToViewportPoint(ux, uy);
      return { x, y };
    };
    const end = (e) => { const b = pointOn(p.i, e); return e.shiftKey ? snapAngle(p.a, b) : b; };
    const paint = () => {
      const ref = viewer.getOverlaySvg(tab, p.i);
      if (ref) { p.svg.style.width = ref.style.width; p.svg.style.height = ref.style.height; if (ref.dataset.viewRotation) p.svg.dataset.viewRotation = ref.dataset.viewRotation; }
      Object.entries({ x1: p.a.x, y1: p.a.y, x2: p.b.x, y2: p.b.y }).forEach(([k, v]) => p.line.setAttribute(k, String(v)));
      hint.textContent = `${Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y).toFixed(1)} pt — click the second end. Shift snaps to 0/45/90°. Esc cancels.`;
    };
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    const onDown = (e) => {
      if (!scrollEl.contains(e.target)) { finish(null); return; } // a click elsewhere cancels
      const pe = p?.pe ?? e.target.closest?.('.page');
      if (!pe || e.button !== 0) return;                            // gaps and scrollbars still scroll
      stop(e);
      if (!p) {
        const i = Number(pe.dataset.pageIndex), { width, height } = viewer.pageSize(tab, i);
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('class', 'overlay-svg ms-cal-svg');
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('preserveAspectRatio', 'none');
        const line = document.createElementNS(SVG_NS, 'line');
        line.setAttribute('class', 'ms-cal-line');
        svg.append(line);
        pe.append(svg);
        const a = pointOn(i, e);
        p = { i, pe, a, b: a, svg, line };
        paint();
        return;
      }
      p.b = end(e);
      const lengthPt = Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y);
      const msg = calibrationError(lengthPt);
      if (msg) { toast(msg); p.svg.remove(); p = null; return; }
      finish({ pageIndex: p.i, lengthPt, a: p.a, b: p.b });
    };
    const onMove = (e) => { if (!p) return; stop(e); p.b = end(e); paint(); };
    const onUp = (e) => { if (p || scrollEl.contains(e.target)) stop(e); };
    const onKey = (e) => { if (e.key === 'Escape') { stop(e); finish(null); } };
    const offTab = bus.on('tab:activated', () => finish(null));
    const opts = { capture: true };
    window.addEventListener('pointerdown', onDown, opts);
    window.addEventListener('pointermove', onMove, opts);
    window.addEventListener('pointerup', onUp, opts);
    window.addEventListener('keydown', onKey, opts);
    function finish(result) {
      window.removeEventListener('pointerdown', onDown, opts);
      window.removeEventListener('pointermove', onMove, opts);
      window.removeEventListener('pointerup', onUp, opts);
      window.removeEventListener('keydown', onKey, opts);
      offTab();
      p?.svg.remove();
      hint.remove();
      scrollEl.classList.remove('vx-snapping');
      resolve(result);
    }
  });
}
