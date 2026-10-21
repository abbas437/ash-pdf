// Rich text runs of a text / callout object: pure helpers that keep `runs` consistent with `text`.
// A run is { text, font?, fontSize?, bold?, italic?, underline?, strike?, color? }: overrides on top of
// the box style; the run texts concatenated always equal `text`. No `runs` = one style for the box.

export const STYLE_KEYS = ['font', 'fontSize', 'bold', 'italic', 'underline', 'strike', 'color'];

const normColor = (c) => String(c).trim().toLowerCase();

/** The box-level style of a text object (the base every run override sits on). */
export function boxStyle(obj) {
  return {
    font: obj.font || 'Helvetica',
    fontSize: Number.isFinite(obj.fontSize) ? obj.fontSize : obj.type === 'callout' ? 10 : 12,
    bold: !!obj.bold,
    italic: !!obj.italic,
    underline: !!obj.underline,
    strike: !!obj.strike,
    color: normColor(obj.color ?? (obj.type === 'callout' ? obj.stroke ?? '#000000' : '#000000')),
  };
}

const same = (k, a, b) => (k === 'color' ? normColor(a) === normColor(b) : k === 'bold' || k === 'italic' || k === 'underline' || k === 'strike' ? !!a === !!b : a === b);

/** The overrides of a run, minus those equal to the box style. */
function overrides(run, box) {
  const o = {};
  for (const k of STYLE_KEYS) if (run[k] !== undefined && run[k] !== null && !same(k, run[k], box[k])) o[k] = k === 'color' ? normColor(run[k]) : run[k];
  return o;
}

const sameStyle = (a, b) => STYLE_KEYS.every((k) => a[k] === b[k]);

/** The object's runs, or one plain run when it has none (or its runs do not add up to its text). */
export function runsOf(obj) {
  const text = String(obj.text ?? '');
  if (Array.isArray(obj.runs) && obj.runs.map((r) => String(r?.text ?? '')).join('') === text) return obj.runs.map((r) => ({ ...r, text: String(r.text ?? '') }));
  return [{ text }];
}

/** Drop empty runs and overrides equal to the box style, merge equal neighbours; undefined when uniform. */
export function normalizeRuns(runs, obj) {
  const box = boxStyle(obj);
  const out = [];
  for (const r of runs) {
    if (!r.text) continue;
    const run = { text: r.text, ...overrides(r, box) };
    const last = out[out.length - 1];
    if (last && sameStyle(last, run)) last.text += run.text;
    else out.push(run);
  }
  return out.length === 0 || (out.length === 1 && Object.keys(out[0]).length === 1) ? undefined : out;
}

/** Split runs so that offsets `at...` fall on run boundaries. */
function splitAt(runs, ...cuts) {
  let out = runs;
  for (const at of cuts) {
    const next = [];
    let pos = 0;
    for (const r of out) {
      const end = pos + r.text.length;
      if (at > pos && at < end) next.push({ ...r, text: r.text.slice(0, at - pos) }, { ...r, text: r.text.slice(at - pos) });
      else next.push(r);
      pos = end;
    }
    out = next;
  }
  return out;
}

const clamp = (n, len) => Math.min(Math.max(0, Math.trunc(Number(n) || 0)), len);

/** Effective style (box style + overrides) of the character at `index`. */
export function styleAt(obj, index) {
  const box = boxStyle(obj);
  let pos = 0;
  for (const r of runsOf(obj)) {
    if (index < pos + r.text.length) return { ...box, ...overrides(r, box) };
    pos += r.text.length;
  }
  return box;
}

/**
 * Apply `patch` (keys of STYLE_KEYS) to characters [start, end). A patch value equal to the box style
 * (or null) removes that override. Returns { text, runs } (runs undefined when the result is uniform).
 */
export function applyStyleToRange(obj, start, end, patch) {
  const text = String(obj.text ?? '');
  const a = clamp(Math.min(start, end), text.length);
  const b = clamp(Math.max(start, end), text.length);
  let pos = 0;
  const runs = splitAt(runsOf(obj), a, b).map((r) => {
    const inside = pos >= a && pos + r.text.length <= b && r.text.length > 0;
    pos += r.text.length;
    if (!inside) return r;
    const n = { ...r };
    for (const k of STYLE_KEYS) if (Object.hasOwn(patch, k)) n[k] = patch[k] ?? undefined;
    return n;
  });
  return { text, runs: normalizeRuns(runs, obj) };
}

/**
 * Insert `str` at offset `at`. It takes `style` (overrides) when given, else the style of the character
 * before `at` (the first character's at offset 0). Returns { text, runs }.
 */
export function insertText(obj, at, str, style) {
  const text = String(obj.text ?? '');
  const i = clamp(at, text.length);
  const s = String(str ?? '');
  const box = boxStyle(obj);
  const inherit = overrides(style ?? styleAt(obj, i > 0 ? i - 1 : 0), box);
  const runs = splitAt(runsOf(obj), i);
  let pos = 0;
  let k = runs.length;
  for (let n = 0; n < runs.length; n++) {
    if (pos >= i) { k = n; break; }
    pos += runs[n].text.length;
  }
  runs.splice(k, 0, { text: s, ...inherit });
  return { text: text.slice(0, i) + s + text.slice(i), runs: normalizeRuns(runs, obj) };
}

/** Delete characters [start, end). Returns { text, runs }. */
export function deleteRange(obj, start, end) {
  const text = String(obj.text ?? '');
  const a = clamp(Math.min(start, end), text.length);
  const b = clamp(Math.max(start, end), text.length);
  let pos = 0;
  const runs = splitAt(runsOf(obj), a, b).filter((r) => {
    const keep = !(pos >= a && pos + r.text.length <= b);
    pos += r.text.length;
    return keep;
  });
  return { text: text.slice(0, a) + text.slice(b), runs: normalizeRuns(runs, obj) };
}
