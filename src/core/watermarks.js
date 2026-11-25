// Find and remove watermarks, including those made by other programs (Document > Remove watermark…).
// Pure ES module (pdf-lib only). Three kinds, each removed only when asked:
//   ash    PDF Studio's own watermark streams (pagemarks.js, tagged /ASH_Mark): removeMarks(…, 'watermark').
//   other  (a) marked content `/Artifact <<… /Subtype /Watermark>> BDC … EMC` (inline or a named
//          /Properties dict) on the page or inside Form XObjects it draws, and (b) draws (`/Name Do`) of
//          Acrobat watermark forms (/PieceInfo /ADBE_CompoundType /Private /Watermark).
//   annots /Subtype /Watermark annotations.
// Removal edits the content streams in place, byte for byte outside the edits: inside a watermark span
// only painting operators go (text shows, Do, sh, inline images; path paints become `n`) and its
// marked-content operators; state operators (q/Q, cm, colours, Tf, Td…) stay, so the content after it
// is unchanged. A span inside a text object whose dropped text would shift later text in the same
// object (a show after it with no repositioning in between) is left alone and not reported.
// PDFium exports the marked-content API but cannot read name-valued properties (/Subtype /Watermark
// reads as an unreadable name) and does not regenerate form XObjects, hence the tokenizer here.
import { PDFName, PDFDict, PDFArray, PDFRef, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { loadPdf, saveEdited } from './internal.js';
import { listMarks, removeMarks } from './pagemarks.js';

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([...'()<>[]{}/%'].map((c) => c.charCodeAt(0)));
const latin = (b, s, e) => String.fromCharCode(...b.subarray(s, e));
const NUM = /^[+-]?(\d+\.?\d*|\.\d+)$/;

/** Tokenize a content stream into instructions [{op, args: [{t, v, s, e}], start, end}] (byte offsets). */
export function lexContent(b) {
  const n = b.length, out = [];
  let i = 0;
  const skip = () => {
    for (;;) {
      while (i < n && WS.has(b[i])) i++;
      if (b[i] !== 0x25) return;
      while (i < n && b[i] !== 10 && b[i] !== 13) i++;
    }
  };
  const regEnd = (j) => { while (j < n && !WS.has(b[j]) && !DELIM.has(b[j])) j++; return j; };
  const value = () => {
    const s = i, c = b[i];
    const tok = (t, v) => ({ t, v, s, e: i });
    if (c === 0x2f) { i = regEnd(i + 1); return tok('name', latin(b, s + 1, i).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))); }
    if (c === 0x28) {
      let d = 1; i++;
      while (i < n && d) { if (b[i] === 0x5c) i++; else if (b[i] === 0x28) d++; else if (b[i] === 0x29) d--; i++; }
      return tok('str');
    }
    if (c === 0x3c && b[i + 1] === 0x3c) {
      i += 2; const v = {};
      for (;;) {
        skip();
        if (i >= n) break;
        if (b[i] === 0x3e && b[i + 1] === 0x3e) { i += 2; break; }
        const k = value(); skip();
        if (i >= n) break;
        const val = value();
        if (k.t === 'name') v[k.v] = val;
      }
      return tok('dict', v);
    }
    if (c === 0x3c) { while (i < n && b[i] !== 0x3e) i++; i++; return tok('hex'); }
    if (c === 0x5b) {
      i++; const v = [];
      for (;;) { skip(); if (i >= n) break; if (b[i] === 0x5d) { i++; break; } v.push(value()); }
      return tok('arr', v);
    }
    i = regEnd(i);
    if (i === s) { i++; return tok('junk'); } // stray ) > ] { }
    const w = latin(b, s, i);
    return NUM.test(w) ? tok('num', Number(w)) : w === 'true' || w === 'false' || w === 'null' ? tok('kw', w) : tok('op', w);
  };
  let args = [];
  for (;;) {
    skip();
    if (i >= n) break;
    const t = value();
    if (t.t !== 'op') { args.push(t); continue; }
    const start = args.length ? args[0].s : t.s;
    if (t.v === 'BI') { // inline image: dict pairs up to ID, then binary data up to a delimited EI
      for (;;) { skip(); if (i >= n) break; const x = value(); if (x.t === 'op' && x.v === 'ID') break; }
      i++;
      while (i < n && !(WS.has(b[i - 1]) && b[i] === 0x45 && b[i + 1] === 0x49 && (i + 2 >= n || WS.has(b[i + 2]) || DELIM.has(b[i + 2])))) i++;
      i = Math.min(n, i + 2);
    }
    out.push({ op: t.v, args, start, end: i });
    args = [];
  }
  return out;
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
 * Scan one content unit (a page's /Contents streams, or a form XObject) for watermarks of kind "other".
 * Records edits in st.edits (ref -> [{start, end, rep}]) and returns true when the unit (or a form it
 * draws) holds one. Forms are scanned once (st.forms caches the result).
 */
function scanUnit(doc, refs, res, st) {
  const streams = refs.map((ref) => ({ ref, b: decodeStream(doc.context.lookup(ref)) })).filter((x) => x.b);
  const list = streams.flatMap((x, k) => lexContent(x.b).map((ins) => ({ ...ins, k })));
  const resolveRes = (key, name) => {
    const d = res && doc.context.lookupMaybe(res.get(PDFName.of(key)), PDFDict);
    const ref = d?.get(PDFName.of(name));
    return { ref, obj: ref && doc.context.lookup(ref) };
  };
  let found = false, inText = false, span = null, pending = null;
  const mc = []; // open marked content: true = watermark span
  const commit = (sp) => { for (const e of sp.edits) { const r = streams[e.k].ref; if (!st.edits.has(r)) st.edits.set(r, []); st.edits.get(r).push(e); } if (sp.edits.length) found = true; };
  const edit = (ins, rep) => span.edits.push({ k: ins.k, start: ins.start, end: ins.end, rep });
  for (const ins of list) {
    const { op, args } = ins;
    if (pending && (op === 'Tj' || op === 'TJ')) pending = null; // would shift: leave that span alone
    else if (pending && REPOSITION.has(op)) { commit(pending); pending = null; }
    if (op === 'BT') inText = true;
    else if (op === 'ET') inText = false;
    if (op === 'BDC' || op === 'BMC') {
      const wm = op === 'BDC' && !span && isWatermarkProps(doc, args[0], args[1], res);
      mc.push(wm);
      if (wm) span = { edits: [], shifted: false };
      if (span) edit(ins, ' ');
      continue;
    }
    if (op === 'EMC') {
      if (span) edit(ins, ' ');
      if (mc.pop() && span) {
        if (inText && span.shifted) pending = span; else commit(span);
        span = null;
      }
      continue;
    }
    if (span) {
      if (op === 'Tj' || op === 'TJ') edit(ins, ' ');
      else if (op === "'") edit(ins, ' T* ');
      else if (op === '"') edit(ins, ` ${args.slice(0, 2).map((a) => latin(streams[ins.k].b, a.s, a.e)).join(' Tw ')} Tc T* `);
      else if (op === 'Do' || op === 'sh' || op === 'BI') edit(ins, ' ');
      else if (PAINT.has(op)) edit(ins, ' n ');
      if (inText && SHOWS.has(op)) span.shifted = true;
      continue;
    }
    if (op === 'Do' && args[0]?.t === 'name') {
      const { ref, obj } = resolveRes('XObject', args[0].v);
      if (!(ref instanceof PDFRef) || !obj?.dict || nameOf(obj.dict.get(PDFName.of('Subtype'))) !== 'Form') continue;
      if (isAcrobatWatermark(doc, obj.dict)) { commit({ edits: [{ k: ins.k, start: ins.start, end: ins.end, rep: ' ' }] }); continue; }
      if (!st.forms.has(ref)) {
        st.forms.set(ref, false); // cycle guard
        const fres = doc.context.lookupMaybe(obj.dict.get(PDFName.of('Resources')), PDFDict) ?? res;
        st.forms.set(ref, scanUnit(doc, [ref], fres, st));
      }
      if (st.forms.get(ref)) found = true;
    }
  }
  if (pending) commit(pending);
  return found;
}

function contentRefs(page) {
  const c = page.node.get(PDFName.Contents);
  if (c instanceof PDFRef) return [c];
  if (c instanceof PDFArray) return c.asArray().filter((r) => r instanceof PDFRef);
  return [];
}
function watermarkAnnots(doc, page) {
  const arr = doc.context.lookupMaybe(page.node.get(PDFName.Annots), PDFArray);
  if (!arr) return [];
  return arr.asArray().filter((a) => nameOf(doc.context.lookupMaybe(a, PDFDict)?.get(PDFName.of('Subtype'))) === 'Watermark');
}
function scanDoc(doc) {
  const st = { edits: new Map(), forms: new Map() };
  const other = [], annots = { count: 0, pages: [] };
  doc.getPages().forEach((page, i) => {
    const res = doc.context.lookupMaybe(page.node.get(PDFName.Resources), PDFDict);
    if (scanUnit(doc, contentRefs(page), res, st)) other.push(i);
    const a = watermarkAnnots(doc, page).length;
    if (a) { annots.count += a; annots.pages.push(i); }
  });
  return { st, other, annots };
}

/** What Remove watermark can remove: { ash: page indices, other: page indices, annots: { count, pages } }. */
export async function findWatermarks(bytes) {
  const ash = (await listMarks(bytes)).find((m) => m.kind === 'watermark')?.pages ?? [];
  const { other, annots } = scanDoc(await loadPdf(bytes));
  return { ash, other, annots };
}

/** Remove the chosen kinds: { ash, other, annots } booleans. Returns the new bytes (a full save). */
export async function removeWatermarks(bytes, { ash = false, other = false, annots = false } = {}) {
  let out = ash ? await removeMarks(bytes, 'watermark') : bytes;
  if (!other && !annots) return out;
  const doc = await loadPdf(out);
  const { st } = scanDoc(doc);
  if (other) {
    for (const [ref, edits] of st.edits) {
      const old = doc.context.lookup(ref), src = decodeStream(old);
      const parts = [];
      let at = 0;
      for (const e of [...edits].sort((x, y) => x.start - y.start)) {
        if (e.start < at) continue;
        parts.push(src.subarray(at, e.start), new TextEncoder().encode(e.rep));
        at = e.end;
      }
      parts.push(src.subarray(at));
      const joined = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
      let o = 0;
      for (const p of parts) { joined.set(p, o); o += p.length; }
      const next = doc.context.flateStream(joined);
      for (const [k, v] of old.dict.entries()) if (!['Length', 'Filter', 'DecodeParms'].includes(k.decodeText())) next.dict.set(k, v);
      doc.context.assign(ref, next);
    }
  }
  if (annots) {
    for (const page of doc.getPages()) {
      const gone = new Set(watermarkAnnots(doc, page));
      if (!gone.size) continue;
      const arr = doc.context.lookup(page.node.get(PDFName.Annots), PDFArray);
      for (let i = arr.size() - 1; i >= 0; i--) if (gone.has(arr.get(i))) arr.remove(i);
      for (const r of gone) if (r instanceof PDFRef) doc.context.delete(r);
    }
  }
  out = await saveEdited(doc);
  return out;
}
