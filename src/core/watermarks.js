// Find and remove watermarks, including those made by other programs (Document > Remove watermark…).
// Pure ES module (pdf-lib only). Three kinds, each removed only when asked:
//   ash    PDF Studio's own watermark streams (pagemarks.js, tagged /ASH_Mark): removeMarks(…, 'watermark').
//   other  (a) marked content `/Artifact <<… /Subtype /Watermark>> BDC … EMC` (inline or a named
//          /Properties dict) on the page or inside Form XObjects it draws, and (b) draws (`/Name Do`) of
//          Acrobat watermark forms (/PieceInfo /ADBE_CompoundType /Private /Watermark).
//   annots /Subtype /Watermark annotations.
// A page's /Contents streams are read as one (joined with a newline); content that cannot be read with
// confidence (malformed, an inline image whose end is unclear, over MAX_UNIT_BYTES) is skipped: nothing
// in it is counted or changed, and findWatermarks reports how many pages were skipped.
// Removal edits the content streams in place, byte for byte outside the edits (a /Contents array that
// changes becomes one new stream): inside a watermark span
// only painting operators go (text shows, Do, sh, inline images; path paints become `n`) and its
// marked-content operators; state operators (q/Q, cm, colours, Tf, Td…) stay, so the content after it
// is unchanged. A span inside a text object whose dropped text would shift later text in the same
// object (a show after it with no repositioning in between) is left alone and not reported.
// /Watermark annotations leave every page's /Annots; the objects stay (see removeWatermarks).
// PDFium exports the marked-content API but cannot read name-valued properties (/Subtype /Watermark
// reads as an unreadable name) and does not regenerate form XObjects, hence the tokenizer here.
import { PDFName, PDFDict, PDFArray, PDFRef, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { loadPdf, saveEdited } from './internal.js';
import { listMarks, removeMarks } from './pagemarks.js';

/** Content the tokenizer cannot read with confidence: the page or form holding it is skipped, never guessed at. */
export class ContentError extends Error {}

const MAX_DEPTH = 64; // array / dictionary nesting
const MAX_TOKEN = 4096; // bytes in one name, number or operator
const MAX_ARGS = 1024; // operands before an operator
/** Decoded content of one page (its /Contents streams together) or form above this is skipped. */
export const MAX_UNIT_BYTES = 8 * 1024 * 1024;

const CLS = new Uint8Array(256); // 0 regular, 1 white-space, 2 delimiter
for (const c of [0, 9, 10, 12, 13, 32]) CLS[c] = 1;
for (const c of '()<>[]{}/%') CLS[c.charCodeAt(0)] = 2;
const HEXD = new Uint8Array(256);
for (const c of '0123456789abcdefABCDEF') HEXD[c.charCodeAt(0)] = 1;
const latin = (b, s, e) => { let out = ''; for (let j = s; j < e; j += 4096) out += String.fromCharCode.apply(null, b.subarray(j, Math.min(e, j + 4096))); return out; };
const nameValue = (b, s, e) => latin(b, s + 1, e).replace(/#([0-9a-fA-F]{2})/g, (_, x) => String.fromCharCode(parseInt(x, 16)));
function isNum(b, s, e) {
  let j = s, digits = 0, dot = false;
  if (b[j] === 0x2b || b[j] === 0x2d) j++;
  for (; j < e; j++) {
    const c = b[j];
    if (c >= 0x30 && c <= 0x39) digits++; else if (c === 0x2e && !dot) dot = true; else return false;
  }
  return digits > 0;
}
const WORDS = new Map(); // operators up to 3 bytes, interned
function word(b, s, e) {
  if (e - s > 3) return latin(b, s, e);
  let key = e - s;
  for (let j = s; j < e; j++) key = key * 256 + b[j];
  let w = WORDS.get(key);
  if (w === undefined) WORDS.set(key, (w = latin(b, s, e)));
  return w;
}
const KW = new Set(['true', 'false', 'null']);
// Operand counts of the content operators (negative: at most that many), for checking what follows an EI.
const ARITY = new Map(Object.entries({
  b: 0, B: 0, 'b*': 0, 'B*': 0, BT: 0, ET: 0, EMC: 0, BX: 0, EX: 0, f: 0, F: 0, 'f*': 0, h: 0, n: 0, q: 0, Q: 0, s: 0, S: 0, 'T*': 0, W: 0, 'W*': 0, BI: 0,
  BMC: 1, MP: 1, BDC: 2, DP: 2, cm: 6, d: 2, d0: 2, d1: 6, Do: 1, g: 1, G: 1, gs: 1, i: 1, j: 1, J: 1, k: 4, K: 4, l: 2, m: 2, M: 1, re: 4, rg: 3, RG: 3, ri: 1,
  sh: 1, Tc: 1, Td: 2, TD: 2, Tf: 2, Tj: 1, TJ: 1, TL: 1, Tm: 6, Tr: 1, Ts: 1, Tw: 1, Tz: 1, v: 4, w: 1, y: 4, c: 6, "'": 1, '"': 3, cs: 1, CS: 1,
  sc: -4, SC: -4, scn: -33, SCN: -33,
}));
const EOF = 0, NUM = 1, NAME = 2, STR = 3, HEX = 4, AOPEN = 5, ACLOSE = 6, DOPEN = 7, DCLOSE = 8, JUNK = 9, WORD = 10;
const TYPE = ['', 'num', 'name', 'str', 'hex', 'arr', '', 'dict', '', 'junk', 'kw'];

/**
 * Tokenize a content stream, calling visit(op, args, argc, start, end, uncertain) per instruction (byte
 * offsets; args[0..argc) are {t, v, s, e} and are reused after the call). Without visit, returns
 * [{op, args, start, end, uncertain?}]. Linear and iterative; throws ContentError on malformed input
 * (unterminated string / array / dictionary, nesting over MAX_DEPTH, a token over MAX_TOKEN, an inline
 * image without a recognisable EI). `uncertain` marks an inline image whose /L did not lead to its EI.
 */
export function lexContent(b, visit) {
  if (!visit) {
    const out = [];
    lexContent(b, (op, args, argc, start, end, uncertain) => out.push({ op, args: args.slice(0, argc).map((a) => ({ ...a })), start, end, ...(uncertain ? { uncertain } : {}) }));
    return out;
  }
  const n = b.length, stack = new Uint8Array(MAX_DEPTH), pool = [];
  let i = 0, ts = 0, argc = 0;
  const token = () => {
    for (;;) {
      while (i < n && CLS[b[i]] === 1) i++;
      if (i >= n) { ts = i; return EOF; }
      if (b[i] !== 0x25) break;
      while (i < n && b[i] !== 10 && b[i] !== 13) i++;
    }
    ts = i;
    const c = b[i++];
    if (CLS[c] === 0 || c === 0x2f) {
      while (i < n && CLS[b[i]] === 0) i++;
      if (i - ts > MAX_TOKEN) throw new ContentError('token too long');
      return c === 0x2f ? NAME : isNum(b, ts, i) ? NUM : WORD;
    }
    switch (c) {
      case 0x28: {
        let d = 1;
        while (i < n) { const x = b[i++]; if (x === 0x5c) i++; else if (x === 0x28) d++; else if (x === 0x29 && --d === 0) return STR; }
        throw new ContentError('unterminated string');
      }
      case 0x3c:
        if (b[i] === 0x3c) { i++; return DOPEN; }
        for (; i < n && b[i] !== 0x3e; i++) if (!HEXD[b[i]] && CLS[b[i]] !== 1) throw new ContentError('bad hex string');
        if (i >= n) throw new ContentError('unterminated hex string');
        i++;
        return HEX;
      case 0x3e: if (b[i] === 0x3e) { i++; return DCLOSE; } return JUNK;
      case 0x5b: return AOPEN;
      case 0x5d: return ACLOSE;
      default: return JUNK; // stray ) { }
    }
  };
  // After an [ or <<: reads to the matching close. Only a dictionary's own entries are kept (as {t, v, s, e}).
  const composite = (open) => {
    const s = ts, top = open === DOPEN ? Object.create(null) : null;
    let depth = 1, key = null, vs = 0;
    stack[0] = open;
    for (;;) {
      const k = token();
      if (k === EOF) throw new ContentError('unterminated array or dictionary');
      if (k === AOPEN || k === DOPEN) {
        if (depth === MAX_DEPTH) throw new ContentError('nesting too deep');
        if (depth === 1) vs = ts;
        stack[depth++] = k;
        continue;
      }
      if (k === ACLOSE || k === DCLOSE) {
        if (stack[depth - 1] !== k - 1) throw new ContentError('mismatched brackets');
        if (--depth === 0) return { t: top ? 'dict' : 'arr', v: top ?? undefined, s, e: i };
        if (depth === 1 && top && key !== null) { top[key] = { t: k === ACLOSE ? 'arr' : 'dict', s: vs, e: i }; key = null; }
        continue;
      }
      if (depth !== 1 || !top) continue;
      if (key === null) key = k === NAME ? nameValue(b, ts, i) : '';
      else { top[key] = { t: TYPE[k], v: k === NAME ? nameValue(b, ts, i) : k === NUM ? Number(latin(b, ts, i)) : undefined, s: ts, e: i }; key = null; }
    }
  };
  // pdf.js-style check that an EI candidate really ends the image: what follows lexes as known
  // operators with their operand counts (up to three of them, or the end of the stream).
  const validAfter = (p) => {
    const save = i;
    i = p;
    try {
      let ops = 0, args = 0;
      while (ops < 3 && i - p < 2048) {
        const k = token();
        if (k === EOF) return true;
        if (k === JUNK) return false;
        if (k === AOPEN || k === DOPEN) composite(k);
        if (k !== WORD) { args++; continue; }
        const w = word(b, ts, i);
        if (KW.has(w)) { args++; continue; }
        const a = ARITY.get(w);
        if (a === undefined || (a >= 0 ? args !== a : args > -a)) return false;
        if (w === 'BI') return true;
        ops++; args = 0;
      }
      return ops > 0;
    } catch (e) {
      if (e instanceof ContentError) return false;
      throw e;
    } finally { i = save; }
  };
  // BI <dict> ID <data> EI: returns true when the image had an /L (/Length) that did not end at an EI.
  const inlineImage = () => {
    let len = -1, hasLen = false;
    for (let key = null; ;) {
      const k = token();
      if (k === EOF) throw new ContentError('inline image without ID');
      if (k === WORD) {
        const w = word(b, ts, i);
        if (w === 'ID') break;
        if (!KW.has(w)) throw new ContentError('operator inside an inline image dictionary');
      }
      if (key === 'L' || key === 'Length') { hasLen = true; if (k === NUM) len = Number(latin(b, ts, i)); }
      key = key === null ? (k === NAME ? nameValue(b, ts, i) : '') : null;
      if (k === AOPEN || k === DOPEN) composite(k);
    }
    const data = i < n && CLS[b[i]] === 1 ? i + 1 : i;
    if (Number.isInteger(len) && len >= 0) {
      let p = data + len;
      while (p < n && CLS[b[p]] === 1) p++;
      if (p + 1 < n && b[p] === 0x45 && b[p + 1] === 0x49 && (p + 2 >= n || CLS[b[p + 2]] !== 0)) { i = p + 2; return false; }
    }
    for (let j = data; ; j++) {
      j = b.indexOf(0x45, j);
      if (j < 0 || j + 1 >= n) throw new ContentError('inline image without EI');
      if (b[j + 1] === 0x49 && CLS[b[j - 1]] === 1 && (j + 2 >= n || CLS[b[j + 2]] !== 0) && validAfter(j + 2)) { i = j + 2; return hasLen; }
    }
  };
  const push = (t, v, s, e) => {
    if (argc === MAX_ARGS) throw new ContentError('too many operands');
    const o = pool[argc++];
    if (o) { o.t = t; o.v = v; o.s = s; o.e = e; } else pool.push({ t, v, s, e });
  };
  for (;;) {
    const k = token();
    if (k === EOF) break;
    if (k === AOPEN || k === DOPEN) { const c = composite(k); push(c.t, c.v, c.s, c.e); continue; }
    if (k !== WORD) { push(TYPE[k], k === NAME ? nameValue(b, ts, i) : undefined, ts, i); continue; }
    const op = word(b, ts, i);
    if (KW.has(op)) { push('kw', op, ts, i); continue; }
    const start = argc ? pool[0].s : ts;
    const uncertain = op === 'BI' ? inlineImage() : false;
    visit(op, pool, argc, start, i, uncertain);
    argc = 0;
  }
}

const PAINT = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);
const SHOWS = new Set(['Tj', 'TJ', "'", '"']);
const REPOSITION = new Set(['Td', 'TD', 'Tm', 'T*', "'", '"', 'ET']);
const nameOf = (o) => (o instanceof PDFName ? o.decodeText() : null);

function decodeStream(obj) {
  if (!(obj instanceof PDFRawStream)) return obj?.getContents?.() ?? null;
  try { return decodePDFRawStream(obj).decode(); } catch { return null; } // unsupported filter: not inspected
}
function isAcrobatWatermark(doc, dict) {
  const piece = doc.context.lookupMaybe(dict.get(PDFName.of('PieceInfo')), PDFDict);
  const ct = piece && doc.context.lookupMaybe(piece.get(PDFName.of('ADBE_CompoundType')), PDFDict);
  return nameOf(ct && doc.context.lookup(ct.get(PDFName.of('Private')))) === 'Watermark';
}
function isWatermarkProps(doc, tag, props, res) {
  if (tag?.v !== 'Artifact' || !props) return false;
  if (props.t === 'dict') return props.v.Subtype?.v === 'Watermark' && !props.v.ASH_Mark && props.v.Subtype.t === 'name';
  if (props.t !== 'name' || !res) return false;
  const all = doc.context.lookupMaybe(res.get(PDFName.of('Properties')), PDFDict);
  const d = all && doc.context.lookupMaybe(all.get(PDFName.of(props.v)), PDFDict);
  return !!d && nameOf(d.get(PDFName.of('Subtype'))) === 'Watermark' && !d.has(PDFName.of('ASH_Mark'));
}

/**
 * Lex one content unit's bytes and find its watermark spans. Returns { edits: [{start, end, rep}], forms:
 * [{ref, res}] } (forms drawn outside spans, to scan next). Throws ContentError when the unit cannot be read
 * with confidence; a span holding an inline image of uncertain length is left alone.
 */
function scanContent(doc, b, res) {
  const edits = [], forms = [];
  let inText = false, span = null, pending = null;
  const mc = []; // open marked content: true = watermark span
  const commit = (sp) => { for (const e of sp.edits) edits.push(e); };
  lexContent(b, (op, args, argc, start, end, uncertain) => {
    if (pending && (op === 'Tj' || op === 'TJ')) pending = null; // would shift: leave that span alone
    else if (pending && REPOSITION.has(op)) { commit(pending); pending = null; }
    if (op === 'BT') inText = true;
    else if (op === 'ET') inText = false;
    if (op === 'BDC' || op === 'BMC') {
      const wm = op === 'BDC' && !span && argc >= 2 && isWatermarkProps(doc, args[argc - 2], args[argc - 1], res);
      mc.push(wm);
      if (wm) span = { edits: [], shifted: false, unsure: false };
      if (span) span.edits.push({ start, end, rep: ' ' });
      return;
    }
    if (op === 'EMC') {
      if (!mc.length) throw new ContentError('EMC without BDC/BMC');
      if (span) span.edits.push({ start, end, rep: ' ' });
      if (mc.pop() && span) {
        if (!span.unsure) { if (inText && span.shifted) pending = span; else commit(span); }
        span = null;
      }
      return;
    }
    if (span) {
      let rep = null;
      if (op === 'Tj' || op === 'TJ' || op === 'Do' || op === 'sh') rep = ' ';
      else if (op === 'BI') { rep = ' '; if (uncertain) span.unsure = true; }
      else if (op === "'") rep = ' T* ';
      else if (op === '"') rep = argc >= 3 ? ` ${latin(b, args[argc - 3].s, args[argc - 3].e)} Tw ${latin(b, args[argc - 2].s, args[argc - 2].e)} Tc T* ` : ' T* ';
      else if (PAINT.has(op)) rep = ' n ';
      if (rep !== null) span.edits.push({ start, end, rep });
      if (inText && SHOWS.has(op)) span.shifted = true;
      return;
    }
    if (op === 'Do' && argc && args[argc - 1].t === 'name') {
      const d = res && doc.context.lookupMaybe(res.get(PDFName.of('XObject')), PDFDict);
      const ref = d?.get(PDFName.of(args[argc - 1].v)), obj = ref instanceof PDFRef ? doc.context.lookup(ref) : null;
      if (!obj?.dict || nameOf(obj.dict.get(PDFName.of('Subtype'))) !== 'Form') return;
      if (isAcrobatWatermark(doc, obj.dict)) edits.push({ start, end, rep: ' ' });
      else forms.push({ ref, res: doc.context.lookupMaybe(obj.dict.get(PDFName.of('Resources')), PDFDict) ?? res });
    }
  });
  if (span) throw new ContentError('watermark span not closed');
  if (pending) commit(pending);
  return { edits, forms };
}

/** Decoded bytes of a unit's streams, joined with a newline (one stream, as the spec reads /Contents); null when unreadable or over MAX_UNIT_BYTES. */
function unitBytes(doc, refs) {
  const parts = [];
  let total = refs.length - 1;
  for (const ref of refs) {
    const obj = doc.context.lookup(ref);
    if (obj instanceof PDFRawStream && obj.contents.length > MAX_UNIT_BYTES) return null;
    const b = decodeStream(obj);
    if (!b) return null;
    parts.push(b);
    if ((total += b.length) > MAX_UNIT_BYTES) return null;
  }
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { if (o) out[o++] = 10; out.set(p, o); o += p.length; }
  return out;
}

/**
 * Scan one content unit (a page's /Contents streams as one, or a form XObject) for watermarks of kind
 * "other". Units are cached in st.units by their stream refs (also the cycle guard for forms): { refs, pages,
 * src, edits, found, skipped }. found: the unit or a form it draws holds one; skipped: the unit or a form it
 * draws could not be read, so nothing in that one is counted or changed.
 */
function scanUnit(doc, refs, res, st, pageNode = null) {
  const key = refs.join(' ');
  let u = st.units.get(key);
  if (u) { if (pageNode) u.pages.push(pageNode); return u; }
  u = { refs, pages: pageNode ? [pageNode] : [], src: null, edits: [], found: false, skipped: false };
  st.units.set(key, u);
  let scanned;
  try {
    const src = unitBytes(doc, refs);
    if (!src) throw new ContentError('unreadable or too large');
    scanned = scanContent(doc, src, res);
    u.src = src;
  } catch { // any problem reading untrusted content: skip this unit, keep going
    u.skipped = true;
    return u;
  }
  u.edits = scanned.edits;
  u.found = u.edits.length > 0;
  for (const f of scanned.forms) {
    const r = scanUnit(doc, [f.ref], f.res, st);
    if (r.found) u.found = true;
    if (r.skipped) u.skipped = true;
  }
  return u;
}

function contentRefs(doc, page) {
  let c = page.node.get(PDFName.Contents);
  if (c instanceof PDFRef) {
    const o = doc.context.lookup(c);
    if (!(o instanceof PDFArray)) return [c];
    c = o;
  }
  if (c instanceof PDFArray) return c.asArray().filter((r) => r instanceof PDFRef);
  return [];
}
function watermarkAnnots(doc, page) {
  const arr = doc.context.lookupMaybe(page.node.get(PDFName.Annots), PDFArray);
  if (!arr) return [];
  return arr.asArray().filter((a) => nameOf(doc.context.lookupMaybe(a, PDFDict)?.get(PDFName.of('Subtype'))) === 'Watermark');
}
function scanDoc(doc) {
  const st = { units: new Map() };
  const other = [], annots = { count: 0, pages: [] };
  let skipped = 0;
  doc.getPages().forEach((page, i) => {
    const res = doc.context.lookupMaybe(page.node.get(PDFName.Resources), PDFDict);
    const refs = contentRefs(doc, page);
    const u = refs.length ? scanUnit(doc, refs, res, st, page.node) : null;
    if (u?.found) other.push(i);
    if (u?.skipped) skipped++;
    const a = watermarkAnnots(doc, page).length;
    if (a) { annots.count += a; annots.pages.push(i); }
  });
  return { st, other, annots, skipped };
}

function applyEdits(src, edits) {
  const parts = [], enc = new TextEncoder();
  let at = 0;
  for (const e of [...edits].sort((x, y) => x.start - y.start)) {
    if (e.start < at) continue;
    parts.push(src.subarray(at, e.start), enc.encode(e.rep));
    at = e.end;
  }
  parts.push(src.subarray(at));
  const joined = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { joined.set(p, o); o += p.length; }
  return joined;
}

/**
 * What Remove watermark can remove: { ash: page indices, other: page indices, annots: { count, pages },
 * skipped: number of pages whose content (or a form on them) could not be checked }.
 */
export async function findWatermarks(bytes) {
  const ash = (await listMarks(bytes)).find((m) => m.kind === 'watermark')?.pages ?? [];
  const { other, annots, skipped } = scanDoc(await loadPdf(bytes));
  return { ash, other, annots, skipped };
}

/** Remove the chosen kinds: { ash, other, annots } booleans. Returns the new bytes (a full save). */
export async function removeWatermarks(bytes, { ash = false, other = false, annots = false } = {}) {
  let out = ash ? await removeMarks(bytes, 'watermark') : bytes;
  if (!other && !annots) return out;
  const doc = await loadPdf(out);
  const { st } = scanDoc(doc);
  if (other) {
    for (const u of st.units.values()) {
      if (!u.edits.length) continue;
      const next = doc.context.flateStream(applyEdits(u.src, u.edits));
      if (u.refs.length === 1) { // in place: every page or form drawing this stream sees the edit
        const old = doc.context.lookup(u.refs[0]);
        for (const [k, v] of old.dict.entries()) if (!['Length', 'Filter', 'DecodeParms'].includes(k.decodeText())) next.dict.set(k, v);
        doc.context.assign(u.refs[0], next);
      } else { // a /Contents array becomes one stream (the streams may be shared with other pages: left as they are)
        const ref = doc.context.register(next);
        for (const p of u.pages) p.set(PDFName.Contents, ref);
      }
    }
  }
  if (annots) {
    // Dropped from every page's /Annots that lists them. The annotation objects stay in the file, so a
    // structure tree /OBJR (or /ParentTree entry) that points at one never dangles.
    for (const page of doc.getPages()) {
      const gone = new Set(watermarkAnnots(doc, page));
      if (!gone.size) continue;
      const arr = doc.context.lookup(page.node.get(PDFName.Annots), PDFArray);
      for (let i = arr.size() - 1; i >= 0; i--) if (gone.has(arr.get(i))) arr.remove(i);
    }
  }
  out = await saveEdited(doc);
  return out;
}
