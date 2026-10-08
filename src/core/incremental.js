// Incremental update (ISO 32000-1, 7.5.6): append the objects an annotation edit changed, with a new
// xref section and a trailer whose /Prev points at the original one, so the original bytes stay an
// exact prefix of the output and a digital signature over them (/ByteRange) still covers the same
// bytes. Pure ES module: imports only from 'pdf-lib'.
import { PDFDocument, PDFDict, PDFArray, PDFName, PDFNumber, PDFRef, PDFStream } from 'pdf-lib';

const N = (s) => PDFName.of(s);
const latin1 = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

function serialize(obj) {
  const buf = new Uint8Array(obj.sizeInBytes());
  obj.copyBytesInto(buf, 0);
  return buf;
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ignoreEncryption: an encrypted original loads (and is then refused) instead of throwing.
const load = (bytes) => PDFDocument.load(bytes.slice(), { updateMetadata: false, throwOnInvalidObject: false, ignoreEncryption: true });

/** Offset after the last `startxref` keyword (the original's xref position), or null. */
function lastStartXref(bytes) {
  const tail = new TextDecoder('latin1').decode(bytes.subarray(Math.max(0, bytes.length - 2048)));
  const m = [...tail.matchAll(/startxref\s+(\d+)/g)].pop();
  return m ? Number(m[1]) : null;
}

/**
 * The /Size of the latest cross-reference section (classic trailer or cross-reference stream
 * dictionary) of `bytes`, or null when the last startxref does not point at one. Every object
 * number below it is taken in some revision -- including object streams and cross-reference
 * streams, which pdf-lib's parser does not register -- so new objects must be numbered from it.
 */
export function trailerSize(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  const at = lastStartXref(bytes);
  if (at == null || at >= bytes.length) return null;
  const text = new TextDecoder('latin1').decode(bytes.subarray(at));
  let dict;
  if (/^xref\s/.test(text)) {
    const t = text.indexOf('trailer');
    if (t < 0) return null;
    dict = text.slice(t, text.indexOf('startxref', t) >>> 0);
  } else if (/^\d+\s+\d+\s+obj\b/.test(text)) {
    dict = text.slice(0, text.indexOf('stream') >>> 0);
    if (!/\/Type\s*\/XRef\b/.test(dict)) return null;
  } else return null;
  const m = /\/Size\s+(\d+)/.exec(dict);
  return m ? Number(m[1]) : null;
}

/**
 * The DocMDP permission of a certified document (/Perms /DocMDP signature, its /Reference
 * /TransformParams /P: 1 no changes, 2 form filling and signing, 3 also annotations), or null when
 * the document is not certified. Annotation changes on P < 3 break the certification.
 */
export async function docMdpPermission(bytes) {
  let doc;
  try { doc = await load(bytes); } catch { return null; }
  return mdpOf(doc);
}

function mdpOf(doc) {
  const perms = doc.catalog.lookup(N('Perms'));
  const sig = perms instanceof PDFDict ? perms.lookup(N('DocMDP')) : null;
  if (!(sig instanceof PDFDict)) return null;
  const refs = sig.lookup(N('Reference'));
  for (const r of refs instanceof PDFArray ? refs.asArray() : []) {
    const sr = doc.context.lookup(r);
    if (!(sr instanceof PDFDict) || sr.get(N('TransformMethod')) !== N('DocMDP')) continue;
    const tp = sr.lookup(N('TransformParams'));
    const p = tp instanceof PDFDict ? tp.lookup(N('P')) : null;
    return p instanceof PDFNumber ? p.asNumber() : 2;
  }
  return 2; // a /DocMDP signature without readable parameters: the default /P 2
}

const dictOf = (o) => (o instanceof PDFDict ? o : o instanceof PDFStream ? o.dict : null);
const isAnnot = (o) => {
  const d = dictOf(o);
  if (!(d instanceof PDFDict) || !d.has(N('Rect'))) return false;
  return (d.get(N('Type')) === N('Annot') || d.has(N('Subtype'))) && d.get(N('Subtype')) !== N('Widget');
};
const isPage = (o) => o instanceof PDFDict && o.get(N('Type')) === N('Page');
const withoutAnnots = (d, ctx) => { const c = d.clone(ctx); c.delete(N('Annots')); return serialize(c); };

/**
 * appendIncrementalUpdate(original, edited) -> Promise<Uint8Array|null>
 *   `edited` is `original` re-saved by pdf-lib (same object numbers) with annotation changes.
 *   Returns `original` itself when nothing changed, `original` + an update section when every
 *   change is annotation-type (markup annotation dictionaries, their new appearance objects, page
 *   /Annots arrays, the document information dictionary), or null when something else changed
 *   (page content, page tree, form fields, catalog, ...) and the caller must write the whole file.
 *   Also null for an encrypted or certified (DocMDP /P < 3) original, an unreadable latest
 *   cross-reference section, and new objects numbered below the original's /Size (`edited` must
 *   come from writeAnnotations on `original`, which numbers new objects from that /Size).
 */
export async function appendIncrementalUpdate(original, edited) {
  if (!(original instanceof Uint8Array) || !(edited instanceof Uint8Array)) throw new TypeError('bytes must be Uint8Arrays');
  if (edited === original) return original;
  const prev = lastStartXref(original);
  const prevSize = trailerSize(original);
  if (prev == null || prevSize == null) return null;
  const [o, e] = await Promise.all([load(original), load(edited)]);
  const ot = o.context.trailerInfo, et = e.context.trailerInfo;
  if (ot.Encrypt || et.Encrypt || !(ot.Root instanceof PDFRef) || !(et.Root instanceof PDFRef) || ot.Root.tag !== et.Root.tag) return null;
  const mdp = mdpOf(o);
  if (mdp != null && mdp < 3) return null;

  const before = new Map(o.context.enumerateIndirectObjects().map(([r, v]) => [r.tag, [r, v]]));
  const after = new Map(e.context.enumerateIndirectObjects().map(([r, v]) => [r.tag, [r, v]]));
  // Indirect /Annots arrays of either version: an edit may rewrite them.
  const annotsRefs = new Set();
  for (const doc of [o, e]) for (const p of doc.getPages()) { const a = p.node.get(N('Annots')); if (a instanceof PDFRef) annotsRefs.add(a.tag); }
  const infoTags = new Set([ot.Info, et.Info].filter((v) => v instanceof PDFRef).map((r) => r.tag));

  const write = []; // [ref, bytes]
  for (const [tag, [ref, obj]] of after) {
    const bytes = serialize(obj);
    const old = before.get(tag)?.[1];
    if (!old) {
      if (ref.objectNumber < prevSize) return null; // would replace an object (stream) of an earlier revision
      write.push([ref, bytes]);
      continue;
    }
    if (sameBytes(serialize(old), bytes)) continue;
    const ok = infoTags.has(tag) || (isAnnot(old) && isAnnot(obj)) || (annotsRefs.has(tag) && old instanceof PDFArray && obj instanceof PDFArray)
      || (isPage(old) && isPage(obj) && sameBytes(withoutAnnots(old, o.context), withoutAnnots(obj, e.context)));
    if (!ok) return null;
    write.push([ref, bytes]);
  }
  const freed = [...before.values()].filter(([r]) => !after.has(r.tag)).map(([r]) => r);
  if (!write.length && !freed.length) return original;

  // Section: objects, xref table (with the free list when objects were deleted), trailer.
  const parts = [];
  let pos = original.length;
  const push = (b) => { const u = typeof b === 'string' ? latin1(b) : b; parts.push(u); pos += u.length; };
  const last = original[original.length - 1];
  if (last !== 0x0a && last !== 0x0d) push('\n');
  const entries = new Map(); // object number -> 20-byte xref entry
  const pad = (n, w) => String(n).padStart(w, '0');
  for (const [ref, bytes] of write.sort((a, b) => a[0].objectNumber - b[0].objectNumber)) {
    entries.set(ref.objectNumber, `${pad(pos, 10)} ${pad(ref.generationNumber, 5)} n\r\n`);
    push(`${ref.objectNumber} ${ref.generationNumber} obj\n`); push(bytes); push('\nendobj\n');
  }
  if (freed.length) {
    freed.sort((a, b) => a.objectNumber - b.objectNumber);
    entries.set(0, `${pad(freed[0].objectNumber, 10)} 65535 f\r\n`);
    freed.forEach((r, i) => entries.set(r.objectNumber, `${pad(freed[i + 1]?.objectNumber ?? 0, 10)} ${pad(Math.min(r.generationNumber + 1, 65535), 5)} f\r\n`));
  }
  const xrefAt = pos;
  let xref = 'xref\n';
  const nums = [...entries.keys()].sort((a, b) => a - b);
  for (let i = 0; i < nums.length;) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    xref += `${nums[i]} ${j - i + 1}\n` + nums.slice(i, j + 1).map((n) => entries.get(n)).join('');
    i = j + 1;
  }
  push(xref);
  const size = Math.max(prevSize - 1, o.context.largestObjectNumber, e.context.largestObjectNumber, ...nums) + 1;
  const trailer = e.context.obj({ Size: size, Root: et.Root, Prev: prev });
  const info = et.Info ?? ot.Info;
  if (info) trailer.set(N('Info'), info);
  if (ot.ID ?? et.ID) trailer.set(N('ID'), ot.ID ?? et.ID);
  push('trailer\n'); push(serialize(trailer)); push(`\nstartxref\n${xrefAt}\n%%EOF\n`);

  const out = new Uint8Array(pos);
  out.set(original, 0);
  let at = original.length;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
