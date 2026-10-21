// FreeText rich text (/RC, PDF 32000 §12.7.3.4): XHTML <-> a text object's box style + runs.
import { boxStyle, runsOf, normalizeRuns } from './richtext.js';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const FAMILY = { Helvetica: 'Helvetica', Times: 'Times', Courier: 'Courier' };

/** CSS of one effective style (font-family, size, weight, style, colour, decoration). */
function css(s) {
  const deco = [s.underline && 'underline', s.strike && 'line-through'].filter(Boolean).join(' ') || 'none';
  return `font-family:${s.font};font-size:${s.fontSize}pt;font-weight:${s.bold ? 'bold' : 'normal'};font-style:${s.italic ? 'italic' : 'normal'};color:${s.color};text-decoration:${deco}`;
}

/** The /RC string of a text / callout object: one <p> per paragraph, one <span> per run piece. */
export function toRichContents(obj) {
  const box = boxStyle(obj);
  const paras = [[]];
  for (const r of runsOf(obj)) {
    const s = { ...box };
    for (const k of Object.keys(box)) if (r[k] !== undefined && r[k] !== null) s[k] = r[k];
    r.text.split('\n').forEach((piece, i) => {
      if (i) paras.push([]);
      if (piece) paras[paras.length - 1].push(`<span style="${esc(css(s))}">${esc(piece)}</span>`);
    });
  }
  const align = obj.align || 'left';
  return (
    '<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml" xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/" ' +
    `xfa:APIVersion="Acrobat:11.0.0" xfa:spec="2.0.2" style="${esc(`${css(box)};text-align:${align}`)}">` +
    paras.map((p) => `<p dir="ltr">${p.join('')}</p>`).join('') +
    '</body>'
  );
}

const NAMED = { black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', gray: '#808080', grey: '#808080', silver: '#c0c0c0', maroon: '#800000', purple: '#800080', fuchsia: '#ff00ff', magenta: '#ff00ff', lime: '#00ff00', olive: '#808000', navy: '#000080', teal: '#008080', aqua: '#00ffff', cyan: '#00ffff', orange: '#ffa500' };
const hex2 = (n) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');

function cssColor(v) {
  const c = v.trim().toLowerCase();
  if (NAMED[c]) return NAMED[c];
  let m = /^#([0-9a-f]{3})$/.exec(c);
  if (m) return '#' + [...m[1]].map((d) => d + d).join('');
  if (/^#[0-9a-f]{6}$/.test(c)) return c;
  m = /^rgba?\(\s*([\d.]+%?)\s*,\s*([\d.]+%?)\s*,\s*([\d.]+%?)/.exec(c);
  if (m) return '#' + m.slice(1, 4).map((x) => hex2(x.endsWith('%') ? (parseFloat(x) * 255) / 100 : parseFloat(x))).join('');
  return undefined;
}

function cssSize(v) {
  const m = /^([\d.]+)\s*(pt|px)?$/.exec(v.trim().toLowerCase());
  if (!m || !(Number(m[1]) > 0)) return undefined;
  return m[2] === 'px' ? Number(m[1]) * 0.75 : Number(m[1]);
}

/** Apply a CSS declaration list to style `s` (in place). `family` maps a font name to Helvetica/Times/Courier. */
function applyCss(s, decl, family) {
  for (const part of decl.split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const k = part.slice(0, i).trim().toLowerCase();
    const v = part.slice(i + 1).trim();
    if (k === 'font-family') {
      const f = family(v.split(',')[0].trim().replace(/^['"]|['"]$/g, ''));
      if (f) s.font = f;
    } else if (k === 'font-size') {
      const z = cssSize(v);
      if (z) s.fontSize = z;
    } else if (k === 'font-weight') s.bold = /bold/i.test(v) || Number(v) >= 600;
    else if (k === 'font-style') s.italic = /italic|oblique/i.test(v);
    else if (k === 'color') {
      const c = cssColor(v);
      if (c) s.color = c;
    } else if (k === 'text-decoration' || k === 'text-decoration-line') {
      s.underline = /underline/i.test(v);
      s.strike = /line-through/i.test(v);
    } else if (k === 'font') {
      // shorthand: [style] [weight] size[/line-height] family
      const m = /(?<![\d.])([\d.]+(?:pt|px)?)(?:\/\S+)?\s+(.+)$/.exec(v);
      if (m) {
        const z = cssSize(m[1]);
        if (z) s.fontSize = z;
        const f = family(m[2].split(',')[0].trim().replace(/^['"]|['"]$/g, ''));
        if (f) s.font = f;
        const pre = v.slice(0, m.index);
        if (/bold|[6-9]00/i.test(pre)) s.bold = true;
        if (/italic|oblique/i.test(pre)) s.italic = true;
      }
    }
  }
}

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, e) => {
    const l = e.toLowerCase();
    if (l[0] === '#') return String.fromCodePoint(l[1] === 'x' ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[l];
  });
}

// (?<!…) anchors: one match attempt per name, so a long name with no '=' is not rescanned (linear).
const attrs = (src) => Object.fromEntries([...src.matchAll(/(?<![\w:-])([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)].map((m) => [m[1].toLowerCase(), decodeEntities(m[3] ?? m[4])]));

/** Larger /RC (or deeper nesting) is not from a real editor: the box falls back to plain text. */
export const RC_MAX_LENGTH = 64 * 1024;
export const RC_MAX_DEPTH = 100;

/** `src` without comments, processing instructions and DOCTYPE (linear); null when one is unterminated. */
function stripMarkup(src) {
  let out = '', i = 0;
  for (;;) {
    const j = src.indexOf('<', i);
    if (j < 0) return out + src.slice(i);
    out += src.slice(i, j);
    const end = src.startsWith('<!--', j) ? ['-->', j + 4] : src.startsWith('<?', j) ? ['?>', j + 2] : /^<!DOCTYPE/i.test(src.slice(j, j + 9)) ? ['>', j + 9] : null;
    if (!end) { out += '<'; i = j + 1; continue; }
    const e = src.indexOf(end[0], end[1]);
    if (e < 0) return null;
    i = e + end[0].length;
  }
}

const BLOCKS = new Set(['p', 'div', 'body']);

/**
 * Parse /RC XHTML on top of `base` (a boxStyle). Returns { text, runs: [{ text, ...full style }] } or
 * null when it is not usable. <p>/<div> end a line, <br> is a line break; a trailing newline is dropped.
 * Whitespace collapses as in CSS white-space: normal (runs of XML whitespace become one space, none at
 * the start or end of a line, whitespace-only text between blocks dropped); &nbsp; is kept.
 */
export function parseRichContents(xhtml, base, family) {
  const raw = String(xhtml);
  if (raw.length > RC_MAX_LENGTH) return null;
  const src = stripMarkup(raw);
  if (src === null || !/<body[\s>]/i.test(src)) return null;
  const stack = [{ tag: '', s: { ...base } }];
  const runs = [];
  let lineStart = true; // no collapsible space may follow (start of a line, or after a space)
  const trimEnd = () => {
    const last = runs[runs.length - 1];
    if (last && last.text.endsWith(' ')) {
      last.text = last.text.slice(0, -1);
      if (!last.text) runs.pop();
    }
  };
  const push = (t, s) => {
    if (t) runs.push({ text: t, ...s });
  };
  const pushText = (t, s) => {
    let c = t.replace(/[ \t\r\n\f]+/g, ' ');
    if (lineStart && c.startsWith(' ')) c = c.slice(1);
    if (!c) return;
    push(c, s);
    lineStart = c.endsWith(' ');
  };
  const lineBreak = (s) => {
    trimEnd();
    push('\n', s);
    lineStart = true;
  };
  // [^<>] in the tag: an unterminated '<' is skipped at the next '<' instead of rescanning the rest.
  for (const m of src.matchAll(/<(\/?)([a-zA-Z][\w:-]*)((?:\s[^<>]*?)?)(\/?)>|([^<]+)/g)) {
    const top = stack[stack.length - 1];
    if (m[5] !== undefined) {
      if (stack.length > 1) pushText(decodeEntities(m[5]), top.s);
      continue;
    }
    const close = !!m[1], tag = m[2].toLowerCase().replace(/^.*:/, ''), self = !!m[4] || tag === 'br';
    if (close) {
      let i = stack.length - 1;
      while (i > 0 && stack[i].tag !== tag) i--;
      if (i <= 0) continue;
      stack.length = i;
      if (tag === 'p' || tag === 'div') lineBreak(stack[stack.length - 1].s);
      else if (BLOCKS.has(tag)) { trimEnd(); lineStart = true; }
      continue;
    }
    if (tag === 'br') {
      lineBreak(top.s);
      continue;
    }
    if (BLOCKS.has(tag)) { trimEnd(); lineStart = true; }
    const s = { ...top.s };
    const a = attrs(m[3]);
    if (tag === 'b' || tag === 'strong') s.bold = true;
    else if (tag === 'i' || tag === 'em') s.italic = true;
    else if (tag === 'u') s.underline = true;
    else if (tag === 's' || tag === 'strike' || tag === 'del') s.strike = true;
    else if (tag === 'font') {
      if (a.face) {
        const f = family(a.face.split(',')[0].trim());
        if (f) s.font = f;
      }
      if (a.size && cssSize(a.size)) s.fontSize = cssSize(a.size);
      if (a.color && cssColor(a.color)) s.color = cssColor(a.color);
    }
    if (a.style) applyCss(s, a.style, family);
    if (self) continue;
    if (stack.length > RC_MAX_DEPTH) return null;
    stack.push({ tag, s });
  }
  trimEnd();
  let text = runs.map((r) => r.text).join('');
  if (text.endsWith('\n')) {
    const last = runs[runs.length - 1];
    last.text = last.text.slice(0, -1);
    if (!last.text) runs.pop();
    text = text.slice(0, -1);
  }
  return { text: text.replace(/ /g, ' '), runs: runs.map((r) => ({ ...r, text: r.text.replace(/ /g, ' ') })) };
}

const STYLE_FIELDS = ['font', 'fontSize', 'bold', 'italic', 'underline', 'strike', 'color'];
const isWs = (c) => /\s/.test(c);

/**
 * The parsed runs re-cut onto `text` (/Contents): every non-whitespace character must match in order,
 * and each whitespace stretch of `text` matches one (possibly empty, only at the ends) of the parsed
 * text. Returns runs whose texts concatenate to exactly `text`, or null when the texts differ.
 */
function mapRuns(runs, text) {
  const P = [], at = [];
  runs.forEach((r, k) => { for (const c of r.text) { P.push(c); at.push(k); } });
  const C = [...text], of = [];
  let i = 0;
  for (let j = 0; j < C.length;) {
    if (isWs(C[j])) {
      const j0 = j, i0 = i;
      while (j < C.length && isWs(C[j])) j++;
      while (i < P.length && isWs(P[i])) i++;
      const near = i > i0 ? null : i < P.length ? at[i] : i0 > 0 ? at[i0 - 1] : 0;
      for (let k = j0; k < j; k++) of.push(near ?? at[Math.min(i0 + k - j0, i - 1)]);
      continue;
    }
    if (i < P.length && isWs(P[i])) {
      if (j > 0) return null;
      while (i < P.length && isWs(P[i])) i++;
    }
    if (i >= P.length || P[i] !== C[j]) return null;
    of.push(at[i++]);
    j++;
  }
  while (i < P.length) if (!isWs(P[i++])) return null;
  const out = [];
  C.forEach((c, j) => {
    const last = out[out.length - 1];
    if (last && last.k === of[j]) last.text += c;
    else out.push({ ...runs[of[j]], text: c, k: of[j] });
  });
  return out.map(({ k, ...r }) => r);
}

/**
 * Box style + runs of a text object `o` (text = /Contents, box style already read) from its /RC:
 * returns the fields to assign ({ text, runs } or uniform box fields), or null to keep `o` as it is.
 * /Contents stays the text: the /RC runs are mapped onto it, or not used when its text differs.
 */
export function richFromRC(xhtml, o, family = (n) => FAMILY[n]) {
  let parsed;
  try {
    parsed = parseRichContents(xhtml, boxStyle(o), family);
  } catch {
    return null;
  }
  const text = String(o.text ?? '');
  const runs = parsed && mapRuns(parsed.runs, text);
  if (!runs) return null;
  const key = (r) => STYLE_FIELDS.map((k) => r[k]).join('|');
  if (runs.length && runs.every((r) => key(r) === key(runs[0]))) {
    const box = boxStyle(o);
    const out = { text };
    for (const k of STYLE_FIELDS) if (runs[0][k] !== box[k]) out[k] = runs[0][k];
    return out;
  }
  return { text, runs: normalizeRuns(runs, { ...o, text }) };
}
