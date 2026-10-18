// Digital-signature detection. ASH PDF Studio saves by rewriting the whole file with pdf-lib (no
// incremental update), which invalidates any existing signature and drops earlier revisions, so the
// shell asks before overwriting a signed file. Pure ES module: imports only from 'pdf-lib'.
import { PDFDocument, PDFDict, PDFArray, PDFName, PDFNumber, PDFRef } from 'pdf-lib';

const N = (s) => PDFName.of(s);
const SIG = N('Sig');
const BYTE_RANGE = N('ByteRange');
const MAX_DEPTH = 32;

/**
 * detectSignatures(bytes) -> Promise<{signed: boolean, fields: number}>
 *   fields: number of signature form fields (/FT /Sig), signed or not.
 *   signed: true when the file carries an applied signature (a dictionary with /Type /Sig or
 *           /ByteRange) or AcroForm /SigFlags has AppendOnly (bit 2) set.
 * Never throws: unparseable input falls back to a raw byte scan; non-bytes give {false, 0}.
 */
export async function detectSignatures(bytes) {
  try {
    if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
    if (!(bytes instanceof Uint8Array)) return { signed: false, fields: 0 };
    try {
      return structural(await PDFDocument.load(bytes.slice(), { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false }));
    } catch {
      return rawScan(bytes);
    }
  } catch {
    return { signed: false, fields: 0 };
  }
}

/**
 * mayBeSigned(bytes) -> boolean: a raw scan of the file's names, fast enough for any size. false only
 * when the file certainly carries no signature, so the detectSignatures parse can be skipped:
 *   - A signature is a dictionary in an indirect object (or nested in one) with /ByteRange or /Type /Sig,
 *     reached from a field with /FT /Sig (AcroForm /SigFlags) or from /Perms; outside object streams
 *     every such name is literally in the bytes, so none of /Sig* (Sig, SigFlags, SigRef...) and no
 *     /ByteRange means no signature there.
 *   - Objects inside an object stream are compressed and invisible to a raw scan; the stream's own
 *     dictionary (never itself in an object stream) is not, so any /ObjStm means "may be signed".
 *   - A name may be written with #xx escapes (/S#69g is /Sig): any name holding '#' means "may be signed".
 * A true result proves nothing (a name in a content stream, an unsigned field): detectSignatures decides.
 * pdf.js metadata IsSignaturesPresent cannot stand in for this: it is only AcroForm /SigFlags bit 1.
 */
export function mayBeSigned(bytes) {
  if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
  const n = bytes.length;
  const at = (i, s) => { for (let k = 0; k < s.length; k++) if (bytes[i + k] !== s.charCodeAt(k)) return false; return true; };
  for (let i = bytes.indexOf(0x2f); i >= 0 && i < n; i = bytes.indexOf(0x2f, i + 1)) { // '/'
    let j = i + 1;
    // Name characters: anything but whitespace and delimiters ( ) < > [ ] { } / %
    for (; j < n; j++) {
      const c = bytes[j];
      if (c <= 0x20 || c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25) break;
      if (c === 0x23) return true; // '#': escaped name
    }
    const len = j - i - 1;
    if ((len >= 3 && at(i + 1, 'Sig')) || (len === 9 && at(i + 1, 'ByteRange')) || (len === 6 && at(i + 1, 'ObjStm'))) return true;
    i = j - 1;
  }
  return false;
}

function structural(doc) {
  let signed = false;
  let fields = 0;
  const seen = new Set();
  // Walk every indirect object and the direct dictionaries/arrays nested in it (a signature value
  // or a /Perms entry can be a direct dictionary). Indirect references are not followed here: the
  // referenced object is visited as an indirect object in its own right.
  const visit = (obj, depth) => {
    if (depth > MAX_DEPTH || obj instanceof PDFRef || obj == null) return;
    if (obj instanceof PDFArray) { for (const v of obj.asArray()) visit(v, depth + 1); return; }
    const dict = obj instanceof PDFDict ? obj : obj.dict instanceof PDFDict ? obj.dict : null;
    if (!dict || seen.has(dict)) return;
    seen.add(dict);
    if (dict.get(N('FT')) === SIG) fields++;
    if (dict.get(N('Type')) === SIG || dict.has(BYTE_RANGE)) signed = true;
    for (const v of dict.values()) visit(v, depth + 1);
  };
  for (const [, obj] of doc.context.enumerateIndirectObjects()) visit(obj, 0);
  const acro = doc.catalog.lookupMaybe(N('AcroForm'), PDFDict);
  const flags = acro?.lookupMaybe(N('SigFlags'), PDFNumber)?.asNumber() ?? 0;
  if (flags & 2) signed = true; // AppendOnly: "signatures that may be invalidated if the file is saved" (ISO 32000-1, 12.7.2)
  return { signed, fields };
}

function rawScan(bytes) {
  const text = new TextDecoder('latin1').decode(bytes);
  const fields = (text.match(/\/FT\s*\/Sig(?![A-Za-z0-9])/g) ?? []).length;
  const signed = /\/ByteRange(?![A-Za-z0-9])/.test(text) || /\/Type\s*\/Sig(?![A-Za-z0-9])/.test(text);
  return { signed, fields };
}
