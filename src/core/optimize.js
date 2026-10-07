// Reduce file size: recompress large embedded images, drop unreferenced objects, save with object streams.
//
// optimizePdf(bytes, { maxDpi, quality, decodeImage, encodeJpeg }) -> { bytes, before, after, imagesRecompressed, skipped }
//
// Candidates are image XObjects that are 8-bit DeviceRGB / DeviceGray, filtered by DCTDecode (JPEG) or
// FlateDecode without DecodeParms. Anything else is left byte-identical: soft masks and stencil masks
// (and the images that carry them), /Decode arrays, Indexed / ICC / CMYK / Lab colour spaces, JPX / JBIG2 /
// CCITT, other bit depths, streams smaller than MIN_BYTES.
//
// Placed size: the core does not walk content streams for the CTM. It assumes an image can be shown no
// larger than the largest page side, so its longest pixel side spans at most that many inches; the
// effective dpi is therefore never overestimated, and an image is downsampled only when it has more
// pixels than maxDpi needs even at full-page size. An image used smaller than the page keeps more
// resolution than strictly needed (safe, just less saving).
//
// Pixels are decoded / encoded by injected functions so the core runs in Node and in the renderer:
//   decodeImage(jpegBytes) -> Promise<{ width, height, data: RGBA Uint8(Clamped)Array }>
//   encodeJpeg({ width, height, data: RGBA }, { width, height, quality }) -> Promise<Uint8Array>
//     (scales the source to the requested size, then encodes a baseline RGB JPEG)
// A recompressed stream replaces the original only when it is at least MIN_GAIN smaller; the result is
// the original bytes when the whole file did not get smaller.
import { PDFName, PDFNumber, PDFArray, PDFDict, PDFRef, PDFRawStream, PDFStream, decodePDFRawStream } from 'pdf-lib';
import { loadPdf, saveEdited, coreError } from './internal.js';

export const PRESETS = Object.freeze({
  high: Object.freeze({ id: 'high', label: 'High quality', maxDpi: 200, quality: 0.85 }),
  balanced: Object.freeze({ id: 'balanced', label: 'Balanced', maxDpi: 150, quality: 0.75 }),
  smallest: Object.freeze({ id: 'smallest', label: 'Smallest', maxDpi: 100, quality: 0.6 }),
});

const MIN_BYTES = 16 * 1024; // smaller streams are not worth a lossy re-encode
const MIN_GAIN = 0.95;       // keep a new stream only when it is at most 95% of the old one
const KEEP_KEYS = new Set(['Type', 'Subtype', 'Width', 'Height', 'ColorSpace', 'BitsPerComponent', 'Filter', 'DecodeParms', 'Length']);

const N = (s) => PDFName.of(s);

function nameOf(obj) {
  return obj instanceof PDFName ? obj.decodeText() : null;
}

/** The single filter name of a stream, '' for none, null for a chain of several. */
function singleFilter(dict) {
  const f = dict.lookup(N('Filter'));
  if (f == null) return '';
  if (f instanceof PDFName) return f.decodeText();
  if (f instanceof PDFArray) {
    if (f.size() === 0) return '';
    if (f.size() === 1) return nameOf(f.lookup(0)) ?? null;
  }
  return null;
}

function num(dict, key) {
  const v = dict.lookup(N(key));
  return v instanceof PDFNumber ? v.asNumber() : null;
}

/** Why an image stream is not a candidate (null when it is). `maskRefs` are refs used as SMask / Mask. */
function skipReason(ref, stream, maskRefs) {
  const d = stream.dict;
  if (maskRefs.has(ref.tag)) return 'mask';
  if (d.has(N('SMask')) || d.has(N('Mask')) || d.lookup(N('ImageMask'))?.asBoolean?.()) return 'mask';
  if (d.has(N('Decode'))) return 'decode';
  if (num(d, 'BitsPerComponent') !== 8) return 'bits';
  const cs = nameOf(d.lookup(N('ColorSpace')));
  if (cs !== 'DeviceRGB' && cs !== 'DeviceGray') return 'colorspace';
  const filter = singleFilter(d);
  if (filter === 'DCTDecode') {
    if (d.has(N('DecodeParms'))) return 'filter';
  } else if (filter === 'FlateDecode') {
    if (d.has(N('DecodeParms'))) return 'filter';
  } else return 'filter';
  const w = num(d, 'Width'), h = num(d, 'Height');
  if (!(w > 0 && h > 0)) return 'size';
  if (stream.getContents().length < MIN_BYTES) return 'small';
  return null;
}

/** Flate image -> RGBA. */
function flateToRgba(stream, w, h, gray) {
  const raw = decodePDFRawStream(stream).decode();
  const ch = gray ? 1 : 3;
  if (raw.length < w * h * ch) throw new Error('short image data');
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, j = 0; i < w * h; i++, j += ch) {
    const o = i * 4;
    out[o] = raw[j];
    out[o + 1] = gray ? raw[j] : raw[j + 1];
    out[o + 2] = gray ? raw[j] : raw[j + 2];
    out[o + 3] = 255;
  }
  return out;
}

function largestPageSide(doc) {
  let side = 0;
  for (const p of doc.getPages()) {
    const { width, height } = p.getSize();
    side = Math.max(side, Math.abs(width), Math.abs(height));
  }
  return side;
}

/** Refs reachable from the trailer; everything else is garbage. */
function reachable(context) {
  const seen = new Set();
  const stack = [];
  const t = context.trailerInfo;
  for (const v of [t.Root, t.Info, t.Encrypt, t.ID]) if (v) stack.push(v);
  while (stack.length) {
    const obj = stack.pop();
    if (obj instanceof PDFRef) {
      if (seen.has(obj.tag)) continue;
      seen.add(obj.tag);
      const target = context.lookup(obj);
      if (target) stack.push(target);
    } else if (obj instanceof PDFDict) {
      for (const [, v] of obj.entries()) stack.push(v);
    } else if (obj instanceof PDFArray) {
      for (const v of obj.asArray()) stack.push(v);
    } else if (obj instanceof PDFStream) {
      stack.push(obj.dict);
    }
  }
  return seen;
}

export async function optimizePdf(bytes, { maxDpi = PRESETS.balanced.maxDpi, quality = PRESETS.balanced.quality, decodeImage, encodeJpeg, password } = {}) {
  if (typeof encodeJpeg !== 'function' || typeof decodeImage !== 'function') {
    throw coreError('BAD_ARGS', 'optimizePdf needs decodeImage and encodeJpeg functions');
  }
  if (!(maxDpi > 0) || !(quality > 0 && quality <= 1)) throw coreError('BAD_ARGS', 'maxDpi must be > 0 and quality in (0, 1]');
  const before = bytes.byteLength ?? bytes.length;
  const doc = await loadPdf(bytes, { password });
  const { context } = doc;
  const objects = context.enumerateIndirectObjects();

  // Streams used as another image's SMask / Mask must stay as they are (DeviceGray, exact size).
  const maskRefs = new Set();
  for (const [, obj] of objects) {
    if (!(obj instanceof PDFStream)) continue;
    for (const k of ['SMask', 'Mask']) {
      const v = obj.dict.get(N(k));
      if (v instanceof PDFRef) maskRefs.add(v.tag);
    }
  }

  const pageSideIn = largestPageSide(doc) / 72;
  let imagesRecompressed = 0;
  let skipped = 0;
  for (const [ref, obj] of objects) {
    if (!(obj instanceof PDFRawStream) || nameOf(obj.dict.lookup(N('Subtype'))) !== 'Image') continue;
    if (skipReason(ref, obj, maskRefs) || !(pageSideIn > 0)) { skipped++; continue; }
    const d = obj.dict;
    const w = num(d, 'Width'), h = num(d, 'Height');
    const gray = nameOf(d.lookup(N('ColorSpace'))) === 'DeviceGray';
    const dct = singleFilter(d) === 'DCTDecode';
    try {
      const dpi = Math.max(w, h) / pageSideIn;
      const scale = dpi > maxDpi ? maxDpi / dpi : 1;
      const ow = Math.max(1, Math.round(w * scale)), oh = Math.max(1, Math.round(h * scale));
      let src;
      if (dct) {
        src = await decodeImage(obj.getContents());
        if (src?.width !== w || src?.height !== h) { skipped++; continue; }
      } else {
        src = { width: w, height: h, data: flateToRgba(obj, w, h, gray) };
      }
      const jpeg = await encodeJpeg(src, { width: ow, height: oh, quality });
      if (!(jpeg instanceof Uint8Array) || jpeg.length >= obj.getContents().length * MIN_GAIN) { skipped++; continue; }
      const dict = { Type: 'XObject', Subtype: 'Image', Width: ow, Height: oh, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' };
      const next = context.stream(jpeg, dict);
      for (const [k, v] of d.entries()) if (!KEEP_KEYS.has(k.decodeText())) next.dict.set(k, v);
      context.assign(ref, next);
      imagesRecompressed++;
    } catch {
      skipped++; // undecodable image: leave it untouched
    }
  }

  const live = reachable(context);
  for (const [ref] of context.enumerateIndirectObjects()) if (!live.has(ref.tag)) context.delete(ref);

  const out = await saveEdited(doc, { useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false });
  if (out.length >= before) return { bytes, before, after: before, imagesRecompressed: 0, skipped: skipped + imagesRecompressed };
  return { bytes: out, before, after: out.length, imagesRecompressed, skipped };
}
