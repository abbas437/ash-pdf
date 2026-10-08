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

// ---------------------------------------------------------------- character model (text markup tools)
// Text markups select TEXT, not an area: pdf.js text items -> per-character boxes in page space (in
// content order, grouped into line runs), a pointer maps to a caret (char boundary) and a caret range
// becomes one quad per line made of the selected characters' boxes. Vertical extent comes from the
// item's font ascent/descent, never from the pointer.

const ALONG = { 0: (x, y) => x, 90: (x, y) => y, 180: (x, y) => -x, 270: (x, y) => -y };
const CROSS = { 0: (x, y) => y, 90: (x, y) => -x, 180: (x, y) => -y, 270: (x, y) => x };
/** Along/cross extents of an axis-aligned box in a text direction (cross grows "down" the text). */
function extents(b, angle) {
  const al = [ALONG[angle](b.x0, b.y0), ALONG[angle](b.x1, b.y1)], cr = [CROSS[angle](b.x0, b.y0), CROSS[angle](b.x1, b.y1)];
  return { a0: Math.min(...al), a1: Math.max(...al), c0: Math.min(...cr), c1: Math.max(...cr) };
}
const union = (bs) => ({ x0: Math.min(...bs.map((b) => b.x0)), y0: Math.min(...bs.map((b) => b.y0)), x1: Math.max(...bs.map((b) => b.x1)), y1: Math.max(...bs.map((b) => b.y1)) });

/**
 * items: pdf.js getTextContent items [{str, width, transform:[a,b,c,d,e,f], fontName, hasEOL}] in PDF
 * user space; styles: {[fontName]: {ascent, descent, fontFamily}}; toPage(ux, uy) -> [x, y] page space;
 * measure(chars[], fontFamily) -> advance per char (any unit, scaled so the item spans item.width).
 * Returns {chars: [{ch, x0, y0, x1, y1, line}], lines: [{start, end, angle, a0, a1, c0, c1}]}.
 */
export function buildCharModel(items, styles, toPage, measure) {
  const chars = [], lines = [];
  let eol = false, prev = null;
  for (const it of items) {
    const str = [...(it.str ?? '')];
    if (!str.length || !it.transform) { if (it.hasEOL) eol = true; continue; }
    const [a, b, c, d, e, f] = it.transform, len = Math.hypot(a, b) || 1, size = Math.hypot(c, d) || len;
    const st = styles?.[it.fontName] ?? {};
    const asc = st.ascent || (st.descent ? 1 + st.descent : 0.8), desc = st.descent || asc - 1;
    const u = [a / len, b / len], n = [c / size, d / size];
    const pt = (s, h) => toPage(e + u[0] * s + n[0] * h * size, f + u[1] * s + n[1] * h * size);
    const p0 = toPage(e, f), p1 = toPage(e + u[0], f + u[1]);
    const angle = snapAngle((Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) * 180) / Math.PI);
    const adv = measure(str, st.fontFamily ?? 'sans-serif').map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
    const tot = adv.reduce((s, w) => s + w, 0);
    const k = tot > 0 ? (it.width || 0) / tot : 0;
    const first = chars.length;
    let s = 0;
    str.forEach((ch, i) => {
      const s1 = tot > 0 ? s + adv[i] * k : ((i + 1) * (it.width || 0)) / str.length;
      const ps = [pt(s, desc), pt(s, asc), pt(s1, desc), pt(s1, asc)];
      chars.push({ ch, x0: Math.min(...ps.map((p) => p[0])), y0: Math.min(...ps.map((p) => p[1])), x1: Math.max(...ps.map((p) => p[0])), y1: Math.max(...ps.map((p) => p[1])) });
      s = s1;
    });
    const ex = { ...extents(union(chars.slice(first)), angle), angle };
    const h = ex.c1 - ex.c0;
    const same = prev && !eol && prev.angle === angle
      && Math.min(prev.c1, ex.c1) - Math.max(prev.c0, ex.c0) > 0.5 * Math.min(prev.c1 - prev.c0, h)
      && ex.a0 > prev.a1 - 0.5 * h && ex.a0 - prev.a1 < 1.5 * Math.max(prev.c1 - prev.c0, h);
    if (same) {
      const L = lines.at(-1);
      Object.assign(L, { end: chars.length, a0: Math.min(L.a0, ex.a0), a1: Math.max(L.a1, ex.a1), c0: Math.min(L.c0, ex.c0), c1: Math.max(L.c1, ex.c1) });
    } else lines.push({ start: first, end: chars.length, angle, a0: ex.a0, a1: ex.a1, c0: ex.c0, c1: ex.c1 });
    for (let j = first; j < chars.length; j++) chars[j].line = lines.length - 1;
    prev = ex;
    eol = !!it.hasEOL;
  }
  return { chars, lines };
}

/** Index of the line nearest page point (x, y), or -1 when none lies within maxDist. */
function lineAt(model, x, y, maxDist = Infinity) {
  let best = -1, bd = Infinity, bc = Infinity;
  model.lines.forEach((L, i) => {
    const pa = ALONG[L.angle](x, y), pc = CROSS[L.angle](x, y);
    const ga = Math.max(L.a0 - pa, 0, pa - L.a1), gc = Math.max(L.c0 - pc, 0, pc - L.c1), dd = Math.hypot(ga, gc);
    if (dd < bd || (dd === bd && gc < bc)) { best = i; bd = dd; bc = gc; }
  });
  return bd <= maxDist ? best : -1;
}
const charExt = (model, i) => extents(model.chars[i], model.lines[model.chars[i].line].angle);

/** Caret (char boundary index: k = before char k) nearest page point (x, y); null when no text within maxDist. */
export function caretAt(model, x, y, maxDist = Infinity) {
  const li = lineAt(model, x, y, maxDist);
  if (li < 0) return null;
  const L = model.lines[li], pa = ALONG[L.angle](x, y);
  for (let k = L.start; k < L.end; k++) { const c = charExt(model, k); if (pa < (c.a0 + c.a1) / 2) return k; }
  return L.end;
}

const WORD = /[\p{L}\p{N}\p{M}_'’]/u;
/** [start, end) of the word under page point (x, y) (a lone symbol selects itself); null over space / no text. */
export function wordAt(model, x, y, maxDist = 0) {
  const li = lineAt(model, x, y, maxDist);
  if (li < 0) return null;
  const L = model.lines[li], pa = ALONG[L.angle](x, y);
  let k = L.start;
  for (let best = Infinity, j = L.start; j < L.end; j++) {
    const c = charExt(model, j), g = Math.max(c.a0 - pa, 0, pa - c.a1);
    if (g < best) { best = g; k = j; }
  }
  const ch = model.chars[k].ch;
  if (/\s/u.test(ch)) return null;
  if (!WORD.test(ch)) return [k, k + 1];
  let s = k, e = k + 1;
  while (s > L.start && WORD.test(model.chars[s - 1].ch)) s--;
  while (e < L.end && WORD.test(model.chars[e].ch)) e++;
  return [s, e];
}

/** Quads (text-frame corner order) of the characters between carets a and b: one per line run, edge whitespace trimmed. */
export function rangeQuads(model, a, b) {
  const [s0, e0] = a <= b ? [a, b] : [b, a];
  const out = [];
  for (const L of model.lines) {
    let s = Math.max(s0, L.start), e = Math.min(e0, L.end);
    while (s < e && /\s/u.test(model.chars[s].ch)) s++;
    while (e > s && /\s/u.test(model.chars[e - 1].ch)) e--;
    if (s < e) out.push(boxToQuad(union(model.chars.slice(s, e)), L.angle));
  }
  return out;
}

