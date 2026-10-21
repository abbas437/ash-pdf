// Rich text runs of a text / callout object: pure helpers that keep `runs` consistent with `text`.
// A run is { text, font?, fontSize?, bold?, italic?, underline?, strike?, color? }: overrides on top of
// the box style; the run texts concatenated always equal `text`. No `runs` = one style for the box.
//
// Inline pictures ("in line with text"): an image run is { text: '\uFFFC', img: <key>, imgW, imgH } —
// exactly one U+FFFC (OBJECT REPLACEMENT CHARACTER) per image, sized in points; `img` names an entry
// of the object's `images: { <key>: { bytes: Uint8Array, mime: 'image/png'|'image/jpeg' } }`. An image
// run carries no style (style keys on it are dropped), never merges with a neighbour (two adjacent
// images stay two runs) and is kept even when its key has no entry in `images` (so runs always add up
// to the text): layout keeps its space, drawing leaves it blank. A U+FFFC in an ordinary text run is
// just an unencodable character ('?' when drawn).

export const STYLE_KEYS = ['font', 'fontSize', 'bold', 'italic', 'underline', 'strike', 'color'];

/** The character an inline image occupies in `text`. */
export const OBJ_CHAR = '\uFFFC';

const DEFAULT_IMG_SIZE = 12;
const imgSize = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : DEFAULT_IMG_SIZE);

/** True for an image run: one U+FFFC with a non-empty string `img` key. */
export function isImageRun(r) {
  return !!r && r.text === OBJ_CHAR && typeof r.img === 'string' && r.img !== '';
}

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

const FONTS = { helvetica: 'Helvetica', times: 'Times', courier: 'Courier' };

/** A run's style value made valid for `key` (canonical font, #rrggbb colour), or undefined when it is not valid. */
function cleanValue(k, v) {
  if (k === 'font') return typeof v === 'string' ? FONTS[v.trim().toLowerCase()] : undefined;
  if (k === 'fontSize') return typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 1000 ? v : undefined;
  if (k === 'color') {
    const m = typeof v === 'string' ? /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v.trim().toLowerCase()) : null;
    if (!m) return undefined;
    return '#' + (m[1].length === 3 ? [...m[1]].map((d) => d + d).join('') : m[1]);
  }
  return typeof v === 'boolean' ? v : undefined;
}

/** The overrides of a run, minus those equal to the box style and invalid values (which are dropped). */
function overrides(run, box) {
  const o = {};
  for (const k of STYLE_KEYS) {
    if (run[k] === undefined || run[k] === null) continue;
    const v = cleanValue(k, run[k]);
    if (v !== undefined && !same(k, v, box[k])) o[k] = v;
  }
  return o;
}

const sameStyle = (a, b) => !isImageRun(a) && !isImageRun(b) && STYLE_KEYS.every((k) => a[k] === b[k]);

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
    const run = isImageRun(r) ? { text: OBJ_CHAR, img: r.img, imgW: imgSize(r.imgW), imgH: imgSize(r.imgH) } : { text: r.text, ...overrides(r, box) };
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
  const inherit = overrides(style ?? styleAt(obj, textIndexNear(obj, i)), box);
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

/**
 * The character whose style text typed at `at` takes: the one before `at`, skipping inline images
 * (they have no style), else the first text character after it (0 when there is none).
 */
function textIndexNear(obj, at) {
  const runs = runsOf(obj);
  const isImg = [];
  for (const r of runs) for (let k = 0; k < r.text.length; k++) isImg.push(isImageRun(r));
  for (let k = at - 1; k >= 0; k--) if (!isImg[k]) return k;
  for (let k = Math.max(at, 0); k < isImg.length; k++) if (!isImg[k]) return k;
  return 0;
}

/**
 * Insert an inline image (key `img` of obj.images, `w` x `h` points) at offset `at`: one U+FFFC image
 * run. Returns { text, runs }.
 */
export function insertImage(obj, at, img, w, h) {
  const text = String(obj.text ?? '');
  const i = clamp(at, text.length);
  const runs = splitAt(runsOf(obj), i);
  let pos = 0;
  let k = runs.length;
  for (let n = 0; n < runs.length; n++) {
    if (pos >= i) { k = n; break; }
    pos += runs[n].text.length;
  }
  runs.splice(k, 0, { text: OBJ_CHAR, img: String(img), imgW: w, imgH: h });
  return { text: text.slice(0, i) + OBJ_CHAR + text.slice(i), runs: normalizeRuns(runs, obj) };
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
