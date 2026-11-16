// Make a pdf-lib loaded document match the file's cross-reference data.
//
// pdf-lib's PDFDocument.load parses the body sequentially and ignores the xref, so when a file
// still carries stale, unreferenced object streams (/Type /ObjStm) from earlier saves, the copy
// of an object that appears LAST in the file wins, even when the xref points at an earlier,
// current copy. Viewers that follow the xref (pdf.js, Acrobat, qpdf) show the current data;
// pdf-lib showed, and on save wrote back, the old data.
//
// repairFromXref walks the xref chain from the last startxref (classic tables and xref streams,
// /Prev and hybrid /XRefStm; the newest section wins), finds stale copies in object streams (every
// member of a stream the xref does not reference, and members of a referenced one that the xref
// places elsewhere), and for every object pdf-lib took from such a copy (it sits after the xref's
// location for that object), re-parses the object from where the xref says and assigns it.
// Anything unexpected (no/garbled startxref, offsets out of range, /Prev loop, a stream that does
// not parse, an encrypted file, implausible sizes or amounts of work) leaves the document exactly
// as pdf-lib loaded it.
// Pure ES module: imports only from 'pdf-lib'.
import { PDFObjectParser, PDFObjectStreamParser, PDFRawStream, PDFDict, PDFArray, PDFName, PDFNumber, PDFRef, decodePDFRawStream } from 'pdf-lib';

const N = (s) => PDFName.of(s);
const MAX_SECTIONS = 4096;
const MAX_ENTRIES = 10_000_000; // per xref section: beyond it the repair gives up
const MAX_MARKERS = 100_000; // `/ObjStm` tokens in the file: beyond it the repair gives up
const LOOK_BACK = 256; // bytes from an `/ObjStm` token back to its `N G obj` header
const enc = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const STARTXREF = enc('startxref');
const OBJSTM = enc('/ObjStm');
const STREAM = enc('stream');
const END = enc('end');

class Inconsistent extends Error {}
function check(cond, msg) {
  if (!cond) throw new Inconsistent(msg);
}

const isWs = (b) => b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09 || b === 0x0c || b === 0x00;
const isDelim = (b) => b === undefined || isWs(b) || b === 0x2f || b === 0x3c || b === 0x3e || b === 0x5b || b === 0x5d || b === 0x28 || b === 0x29 || b === 0x25;
const latin1 = (bytes, a, b) => {
  let s = '';
  for (let i = a; i < b; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(b, i + 8192)));
  return s;
};

function matchAt(bytes, at, pat) {
  for (let k = 0; k < pat.length; k++) if (bytes[at + k] !== pat[k]) return false;
  return true;
}

const isDigit = (b) => b >= 0x30 && b <= 0x39;

/**
 * The `N G obj` header whose dictionary holds the name token at `pos`, as {offset, num, gen}, or
 * null. Looks back at most LOOK_BACK bytes, in place; a `stream`/`endstream`/`endobj` keyword in
 * between means the token is not in an object's dictionary (content stream data, say).
 */
function headerBefore(bytes, pos) {
  const lo = Math.max(0, pos - LOOK_BACK);
  for (let j = pos - 3; j >= lo; j--) {
    if (bytes[j] === 0x73 && matchAt(bytes, j, STREAM)) return null;
    if (bytes[j] !== 0x6f || bytes[j + 1] !== 0x62 || bytes[j + 2] !== 0x6a || !isDelim(bytes[j + 3])) continue;
    if (j >= 3 && matchAt(bytes, j - 3, END)) return null; // endobj
    // backwards: whitespace, generation digits, whitespace, object number digits, a delimiter
    let k = j - 1;
    const ws = () => {
      const from = k;
      while (k >= 0 && isWs(bytes[k])) k--;
      return k < from;
    };
    const digits = () => {
      const to = k;
      while (k >= 0 && to - k < 10 && isDigit(bytes[k])) k--;
      return to > k ? Number(String.fromCharCode(...bytes.subarray(k + 1, to + 1))) : null;
    };
    if (!ws()) continue;
    const gen = digits();
    if (gen === null || !ws()) continue;
    const num = digits();
    if (num === null || (k >= 0 && !isDelim(bytes[k]))) continue;
    return { offset: k + 1, num, gen };
  }
  return null;
}

/**
 * The distinct `N G obj` headers of objects whose dictionary holds an `/ObjStm` name token, in file
 * order: one pass over the bytes, a bounded look-back per token. null when there are more than
 * MAX_MARKERS tokens (a hostile file: not worth repairing).
 */
function objStmHeaders(bytes) {
  const out = [];
  let markers = 0;
  const last = bytes.length - OBJSTM.length;
  for (let i = 0; i <= last; i++) {
    if (bytes[i] !== 0x2f || bytes[i + 1] !== 0x4f || !matchAt(bytes, i, OBJSTM) || !isDelim(bytes[i + OBJSTM.length])) continue;
    if (++markers > MAX_MARKERS) return null;
    const h = headerBefore(bytes, i);
    if (h && h.offset !== out[out.length - 1]?.offset) out.push(h);
  }
  return out;
}

/** The integer after the last `startxref` keyword, or null. */
function lastStartXref(bytes) {
  for (let i = bytes.length - STARTXREF.length; i >= 0; i--) {
    if (bytes[i] === 0x73 && matchAt(bytes, i, STARTXREF)) {
      const m = /^\s*(\d+)/.exec(latin1(bytes, i + STARTXREF.length, Math.min(bytes.length, i + STARTXREF.length + 32)));
      return m ? Number(m[1]) : null;
    }
  }
  return null;
}

function makeReader(bytes, context) {
  const p = PDFObjectParser.forBytes(bytes, context);
  /** Parse `N G obj <object>` at `offset`; returns {num, gen, obj}. Throws on anything else. */
  const indirectAt = (offset) => {
    check(Number.isInteger(offset) && offset >= 0 && offset < bytes.length, 'offset out of range');
    p.bytes.moveTo(offset);
    p.skipWhitespaceAndComments();
    const num = p.parseRawInt();
    p.skipWhitespaceAndComments();
    const gen = p.parseRawInt();
    p.skipWhitespaceAndComments();
    const at = p.bytes.offset();
    check(bytes[at] === 0x6f && bytes[at + 1] === 0x62 && bytes[at + 2] === 0x6a && isDelim(bytes[at + 3]), 'no obj keyword');
    p.bytes.moveTo(at + 3);
    p.skipWhitespaceAndComments();
    return { num, gen, obj: p.parseObject() };
  };
  const objectAt = (offset) => {
    p.bytes.moveTo(offset);
    p.skipWhitespaceAndComments();
    return p.parseObject();
  };
  return { indirectAt, objectAt, pos: () => p.bytes.offset() };
}

const num = (dict, key) => {
  const v = dict.lookup(N(key));
  return v instanceof PDFNumber ? v.asNumber() : undefined;
};

/** A subsection's first object number and entry count are sane (checked before any is summed or looped over). */
const validRun = (start, count) => Number.isSafeInteger(start) && Number.isSafeInteger(count) && start >= 0 && count >= 0 && Number.isSafeInteger(start + count);

/** Entries of a classic `xref` table at `off`, plus its trailer dict. */
function classicSection(bytes, off, reader) {
  let t = -1;
  const TRAILER = enc('trailer');
  for (let i = off; i <= bytes.length - TRAILER.length; i++) if (bytes[i] === 0x74 && matchAt(bytes, i, TRAILER)) { t = i; break; }
  check(t > 0, 'no trailer');
  const tok = latin1(bytes, off + 4, t).trim().split(/\s+/).filter(Boolean);
  const entries = [];
  let i = 0;
  while (i < tok.length) {
    const start = Number(tok[i]);
    const count = Number(tok[i + 1]);
    check(validRun(start, count) && entries.length + count <= MAX_ENTRIES && i + 2 + 3 * count <= tok.length, 'bad subsection');
    i += 2;
    for (let k = 0; k < count; k++, i += 3) {
      const [a, g, kind] = [Number(tok[i]), Number(tok[i + 1]), tok[i + 2]];
      check(Number.isInteger(a) && Number.isInteger(g) && (kind === 'n' || kind === 'f'), 'bad entry');
      entries.push(kind === 'n' ? { n: start + k, type: 1, a, b: g } : { n: start + k, type: 0 });
    }
  }
  const trailer = reader.objectAt(t + TRAILER.length);
  check(trailer instanceof PDFDict, 'trailer not a dict');
  return { entries, trailer };
}

/**
 * Undo a PNG predictor (/DecodeParms /Predictor >= 10), which xref streams commonly use and pdf-lib's
 * decodePDFRawStream does not apply. Other predictors are not used for xref streams: refuse them.
 */
function unpredict(data, parms) {
  if (parms instanceof PDFArray) parms = parms.lookup(0);
  const predictor = parms instanceof PDFDict ? num(parms, 'Predictor') ?? 1 : 1;
  if (predictor === 1) return data;
  check(predictor >= 10, 'unsupported predictor');
  const colors = num(parms, 'Colors') ?? 1;
  const bpc = num(parms, 'BitsPerComponent') ?? 8;
  const columns = num(parms, 'Columns') ?? 1;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  check(rowLen > 0, 'bad predictor columns');
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  for (let r = 0; r < rows; r++) {
    const f = data[r * (rowLen + 1)];
    const src = r * (rowLen + 1) + 1;
    const o = r * rowLen;
    for (let i = 0; i < rowLen; i++) {
      const x = data[src + i];
      const a = i >= bpp ? out[o + i - bpp] : 0;
      const b = r ? out[o - rowLen + i] : 0;
      const c = r && i >= bpp ? out[o - rowLen + i - bpp] : 0;
      let v;
      if (f === 0) v = x;
      else if (f === 1) v = x + a;
      else if (f === 2) v = x + b;
      else if (f === 3) v = x + ((a + b) >> 1);
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Inconsistent('bad PNG filter type');
      out[o + i] = v & 0xff;
    }
  }
  return out;
}

/** Entries of the cross-reference stream at `off`, plus its dict. */
function streamSection(bytes, off, reader) {
  const { obj } = reader.indirectAt(off);
  check(obj instanceof PDFRawStream && obj.dict.lookup(N('Type')) === N('XRef'), 'not an xref stream');
  const dict = obj.dict;
  const data = unpredict(decodePDFRawStream(obj).decode(), dict.lookup(N('DecodeParms')));
  const W = dict.lookup(N('W'));
  check(W instanceof PDFArray && W.size() >= 3, 'bad /W');
  const w = [0, 1, 2].map((k) => W.lookup(k, PDFNumber).asNumber());
  check(w.every((x) => Number.isInteger(x) && x >= 0 && x <= 8) && w[1] > 0, 'bad /W');
  const size = num(dict, 'Size');
  const Index = dict.lookup(N('Index'));
  const subs = [];
  if (Index instanceof PDFArray) {
    for (let k = 0; k + 1 < Index.size(); k += 2) subs.push([Index.lookup(k, PDFNumber).asNumber(), Index.lookup(k + 1, PDFNumber).asNumber()]);
  } else {
    check(Number.isInteger(size), 'no /Size');
    subs.push([0, size]);
  }
  const row = w[0] + w[1] + w[2]; // > 0: w[1] > 0
  const maxRows = Math.min(Math.floor(data.length / row), MAX_ENTRIES);
  let total = 0;
  for (const [start, count] of subs) {
    check(validRun(start, count), 'bad /Index');
    total += count;
    check(total <= maxRows, 'xref stream too short');
  }
  const field = (at, width) => {
    let v = 0;
    for (let k = 0; k < width; k++) v = v * 256 + data[at + k];
    return v;
  };
  const entries = [];
  let at = 0;
  for (const [start, count] of subs) {
    for (let k = 0; k < count; k++, at += row) {
      const type = w[0] ? field(at, w[0]) : 1;
      const a = field(at + w[0], w[1]);
      const b = field(at + w[0] + w[1], w[2]);
      if (type === 1 || type === 2) entries.push({ n: start + k, type, a, b });
      // 0 is free; other types are null references (ISO 32000-1, 7.5.8.3): committed like a free
      // entry, so an older section's entry for the number does not win
      else entries.push({ n: start + k, type: 0 });
    }
  }
  return { entries, trailer: dict };
}

/**
 * Walk the xref chain from the last startxref. Returns {map: Map(objNum -> entry), encrypted}.
 * entry: {type: 0} free | {type: 1, a: offset, b: gen} | {type: 2, a: objStmNum, b: index}.
 */
function readXref(bytes, reader) {
  const first = lastStartXref(bytes);
  check(first !== null, 'no startxref');
  const map = new Map();
  const seen = new Set();
  let encrypted = false;
  const commit = (entries) => {
    for (const e of entries) if (!map.has(e.n)) map.set(e.n, e);
  };
  const sectionAt = (off) => {
    check(Number.isInteger(off) && off > 0 && off < bytes.length && !seen.has(off) && seen.size < MAX_SECTIONS, 'bad section offset');
    seen.add(off);
    let i = off;
    while (isWs(bytes[i])) i++;
    return bytes[i] === 0x78 && matchAt(bytes, i, enc('xref')) ? classicSection(bytes, i, reader) : streamSection(bytes, i, reader);
  };
  for (let off = first; off !== undefined; ) {
    const { entries, trailer } = sectionAt(off);
    if (trailer.get(N('Encrypt'))) encrypted = true;
    const stm = num(trailer, 'XRefStm');
    if (stm !== undefined) {
      // hybrid file: the table's in-use entries win, then the stream's, then /Prev. The table
      // marks compressed objects free, so its free entries do not hide the stream's.
      const used = entries.filter((e) => e.type !== 0);
      commit(used);
      commit(sectionAt(stm).entries);
      commit(entries);
    } else {
      commit(entries);
    }
    off = num(trailer, 'Prev');
  }
  return { map, encrypted };
}

/**
 * repairFromXref(doc, bytes) -> number of objects re-assigned (0 when nothing differed or the
 * xref could not be trusted). Call right after PDFDocument.load on the same bytes.
 */
export function repairFromXref(doc, bytes) {
  try {
    if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
    if (!(bytes instanceof Uint8Array)) return 0;
    const headers = objStmHeaders(bytes);
    if (!headers?.length) return 0; // no object stream at all: nothing can clash (or a hostile file)
    const context = doc.context;
    const reader = makeReader(bytes, context);
    const { map, encrypted } = readXref(bytes, reader);
    if (encrypted) return 0; // stream data would need decrypting; pdf-lib cannot read it either
    const live = new Map(); // objStm number -> offset
    for (const e of map.values()) {
      if (e.type !== 2) continue;
      const s = map.get(e.a);
      check(s && s.type === 1, 'object stream not in xref');
      live.set(e.a, s.a);
    }

    // Every object number held by an object stream at a place other than the xref's, with the
    // furthest such stream. A live stream can hold stale copies too, beside its live members.
    const staleAt = new Map();
    // Parsing work over all candidate headers: a legitimate file parses each byte about once; fake
    // headers packed into stream data could each make the parser scan far ahead.
    const budget = 4 * bytes.length + 65536;
    let spent = 0;
    for (const h of headers) {
      let members;
      try {
        const { obj } = reader.indirectAt(h.offset);
        if (!(obj instanceof PDFRawStream) || obj.dict.lookup(N('Type')) !== N('ObjStm')) continue;
        members = PDFObjectStreamParser.forStream(obj).parseOffsetsAndObjectNumbers();
      } catch {
        continue; // pdf-lib could not have taken objects from it either
      } finally {
        spent += Math.max(0, reader.pos() - h.offset);
        check(spent <= budget, 'too much parsing');
      }
      const isLive = live.get(h.num) === h.offset;
      members.forEach(({ objectNumber: n }, index) => {
        const e = map.get(n);
        if (isLive && e?.type === 2 && e.a === h.num && e.b === index) return; // the xref's copy
        staleAt.set(n, Math.max(staleAt.get(n) ?? -1, h.offset));
      });
    }

    // Objects pdf-lib took from a stale stream: the stale copy sits after the xref's location.
    const byStream = new Map(); // objStm number -> [{n, index}]
    const direct = [];
    for (const [n, staleOff] of staleAt) {
      const e = map.get(n);
      if (!e || e.type === 0) continue;
      if (e.type === 2) {
        if (staleOff > live.get(e.a)) (byStream.get(e.a) ?? byStream.set(e.a, []).get(e.a)).push({ n, index: e.b });
      } else if (e.b === 0 && staleOff > e.a) {
        direct.push({ n, offset: e.a });
      }
    }
    if (!byStream.size && !direct.length) return 0;

    const fixes = [];
    for (const [s, wanted] of byStream) {
      const { num: sn, obj } = reader.indirectAt(live.get(s));
      check(sn === s && obj instanceof PDFRawStream && obj.dict.lookup(N('Type')) === N('ObjStm'), 'object stream mismatch');
      const parser = PDFObjectStreamParser.forStream(obj);
      const list = parser.parseOffsetsAndObjectNumbers();
      for (const { n, index } of wanted) {
        check(index < list.length && list[index].objectNumber === n, 'object stream index mismatch');
        parser.bytes.moveTo(parser.firstOffset + list[index].offset);
        fixes.push([PDFRef.of(n, 0), parser.parseObject()]);
      }
    }
    for (const { n, offset } of direct) {
      let got;
      try {
        got = reader.indirectAt(offset);
      } catch {
        continue; // the entry does not point at an object: ignore it
      }
      if (got.num !== n || got.gen !== 0) continue; // a different object starts there: ignore the entry
      fixes.push([PDFRef.of(n, 0), got.obj]);
    }
    if (!fixes.length) return 0;

    for (const [ref, obj] of fixes) context.assign(ref, obj);
    const root = context.trailerInfo.Root;
    if (fixes.some(([ref]) => ref === root)) doc.catalog = context.lookup(root);
    return fixes.length;
  } catch {
    return 0; // nothing has been assigned yet: the doc is exactly as pdf-lib loaded it
  }
}
