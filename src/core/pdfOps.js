// Page-level operations for ASH PDF Studio. Bytes in, bytes out; never mutates input.
import { PDFName, PDFDict, PDFArray, degrees } from 'pdf-lib';
import {
  loadPdf,
  createPdf,
  saveEdited,
  pageGeometry,
  assertPageIndices,
  coreError,
  PRODUCER,
} from './internal.js';

const PAGE_SIZES = {
  A4: [595.28, 841.89],
  Letter: [612, 792],
};

/**
 * Parse a 1-based page range string ("1-3,5,8-", "-4") into sorted unique
 * zero-based indices. Throws RangeError on any invalid token.
 */
export function parseRanges(str, pageCount) {
  if (!Number.isInteger(pageCount) || pageCount < 1) throw new RangeError('pageCount must be a positive integer');
  if (typeof str !== 'string' || str.trim() === '') throw new RangeError('Empty page range');
  const out = new Set();
  for (const raw of str.split(',')) {
    const tok = raw.trim();
    const m = /^(\d*)\s*(-?)\s*(\d*)$/.exec(tok);
    if (!tok || !m || (m[1] === '' && m[3] === '' )) throw new RangeError(`Invalid page range token "${tok}"`);
    const isRange = m[2] === '-';
    if (!isRange && m[3] !== '') throw new RangeError(`Invalid page range token "${tok}"`);
    const a = m[1] === '' ? 1 : Number(m[1]);
    const b = isRange ? (m[3] === '' ? pageCount : Number(m[3])) : a;
    if (a < 1 || b < 1 || a > pageCount || b > pageCount) {
      throw new RangeError(`Page range "${tok}" is outside 1-${pageCount}`);
    }
    if (a > b) throw new RangeError(`Page range "${tok}" is reversed`);
    for (let p = a; p <= b; p++) out.add(p - 1);
  }
  return [...out].sort((x, y) => x - y);
}

function boxArray(r) {
  return [r.x, r.y, r.x + r.width, r.y + r.height];
}

function hasAcroFormFields(doc) {
  const af = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (!af) return false;
  const fields = af.lookupMaybe(PDFName.of('Fields'), PDFArray);
  return !!fields && fields.size() > 0;
}

function readMetadata(doc) {
  const safe = (fn) => {
    try {
      const v = fn();
      return v === undefined ? null : v;
    } catch {
      return null;
    }
  };
  return {
    title: safe(() => doc.getTitle()),
    author: safe(() => doc.getAuthor()),
    subject: safe(() => doc.getSubject()),
    keywords: safe(() => doc.getKeywords()),
    creator: safe(() => doc.getCreator()),
    producer: safe(() => doc.getProducer()),
    creationDate: safe(() => doc.getCreationDate()),
    modificationDate: safe(() => doc.getModificationDate()),
  };
}

/**
 * Structural info. Works on encrypted files too (page tree is not encrypted);
 * for those, `metadata` is null because Info strings are encrypted.
 */
export async function getInfo(bytes, { password } = {}) {
  const doc = await loadPdf(bytes, { password, allowEncrypted: true });
  const pages = doc.getPages().map((page) => {
    const g = pageGeometry(page);
    return {
      width: g.width,
      height: g.height,
      rotation: g.rotation,
      mediaBox: boxArray(page.getMediaBox()),
      cropBox: boxArray(page.getCropBox()),
    };
  });
  return {
    pageCount: pages.length,
    pages,
    metadata: doc.isEncrypted ? null : readMetadata(doc),
    isEncrypted: doc.isEncrypted,
    hasForm: hasAcroFormFields(doc),
  };
}

export async function mergePdfs(list) {
  if (!Array.isArray(list) || list.length === 0) throw new TypeError('mergePdfs expects a non-empty array of PDF bytes');
  const out = await createPdf();
  for (const bytes of list) {
    const src = await loadPdf(bytes);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  return out.save();
}

async function copyToNew(src, indices) {
  const out = await createPdf();
  const pages = await out.copyPages(src, indices);
  pages.forEach((p) => out.addPage(p));
  return out.save();
}

export async function splitPdf(bytes, rangeStrings) {
  if (!Array.isArray(rangeStrings) || rangeStrings.length === 0) throw new TypeError('splitPdf expects an array of range strings');
  const src = await loadPdf(bytes);
  const n = src.getPageCount();
  const parsed = rangeStrings.map((r) => parseRanges(r, n)); // validate all first
  const parts = [];
  for (let i = 0; i < parsed.length; i++) {
    parts.push({ name: `part-${i + 1}`, bytes: await copyToNew(src, parsed[i]) });
  }
  return parts;
}

/** New PDF with the given pages, in the order given (duplicates allowed). */
export async function extractPages(bytes, indices) {
  const src = await loadPdf(bytes);
  assertPageIndices(indices, src.getPageCount());
  if (indices.length === 0) throw new RangeError('No pages selected');
  return copyToNew(src, indices);
}

export async function deletePages(bytes, indices) {
  const doc = await loadPdf(bytes);
  const n = doc.getPageCount();
  assertPageIndices(indices, n);
  const unique = [...new Set(indices)].sort((a, b) => b - a);
  if (unique.length >= n) throw coreError('DELETE_ALL_PAGES', 'Cannot delete every page of a PDF; at least one page must remain.');
  unique.forEach((i) => doc.removePage(i));
  return saveEdited(doc);
}

export async function rotatePages(bytes, indices, deltaDeg) {
  if (!Number.isInteger(deltaDeg) || deltaDeg % 90 !== 0) throw new RangeError('Rotation must be a multiple of 90 degrees');
  const doc = await loadPdf(bytes);
  assertPageIndices(indices, doc.getPageCount());
  for (const i of new Set(indices)) {
    const page = doc.getPage(i);
    const cur = pageGeometry(page).rotation;
    page.setRotation(degrees((((cur + deltaDeg) % 360) + 360) % 360));
  }
  return saveEdited(doc);
}

/** newOrder[k] = old index of the page that should end up at position k. */
export async function reorderPages(bytes, newOrder) {
  const doc = await loadPdf(bytes);
  const n = doc.getPageCount();
  assertPageIndices(newOrder, n, 'newOrder');
  if (newOrder.length !== n || new Set(newOrder).size !== n) {
    throw new RangeError(`newOrder must be a permutation of 0..${n - 1}`);
  }
  const pages = doc.getPages();
  for (let i = n - 1; i >= 0; i--) doc.removePage(i);
  newOrder.forEach((oldIdx, k) => doc.insertPage(k, pages[oldIdx]));
  return saveEdited(doc);
}

/** Reverse the order of `indices` (default: all pages) within the positions they occupy. */
export async function reversePages(bytes, indices) {
  const n = (await loadPdf(bytes)).getPageCount();
  const sel = indices ? [...new Set(indices)].sort((a, b) => a - b) : Array.from({ length: n }, (_, i) => i);
  assertPageIndices(sel, n);
  const order = Array.from({ length: n }, (_, i) => i);
  sel.forEach((pos, k) => { order[pos] = sel[sel.length - 1 - k]; });
  return reorderPages(bytes, order);
}

/** Paper sizes in points, portrait. */
export const PAPER_SIZES = { A4: [595.28, 841.89], A3: [841.89, 1190.55], Letter: [612, 792], Legal: [612, 1008] };

/**
 * Give pages a new visible size `width` x `height` (points, as displayed after /Rotate).
 * fit: scale content uniformly to fit, centred; otherwise keep content at 100 %, centred.
 * MediaBox/CropBox become the new page; Trim/Bleed/Art boxes are removed; annotation
 * /Rect values follow the content.
 */
export async function resizePages(bytes, indices, { width, height, fit = true } = {}) {
  if (!(width > 0 && height > 0)) throw new RangeError('width and height must be positive numbers');
  const doc = await loadPdf(bytes);
  assertPageIndices(indices, doc.getPageCount());
  const ctx = doc.context;
  for (const i of new Set(indices)) {
    const page = doc.getPage(i);
    const g = pageGeometry(page);
    const swap = g.rotation === 90 || g.rotation === 270;
    const [TW, TH] = swap ? [height, width] : [width, height];
    const W = g.view.xMax - g.view.xMin, H = g.view.yMax - g.view.yMin;
    const s = fit ? Math.min(TW / W, TH / H) : 1;
    const tx = (TW - s * W) / 2 - s * g.view.xMin, ty = (TH - s * H) / 2 - s * g.view.yMin;
    const f = (v) => +v.toFixed(6);
    page.node.normalize();
    const pre = ctx.register(ctx.stream(`q ${f(s)} 0 0 ${f(s)} ${f(tx)} ${f(ty)} cm\n`));
    const post = ctx.register(ctx.stream('\nQ\n'));
    if (!page.node.wrapContentStreams(pre, post)) page.node.set(PDFName.of('Contents'), ctx.obj([pre, post]));
    page.setMediaBox(0, 0, TW, TH);
    page.setCropBox(0, 0, TW, TH);
    for (const k of ['TrimBox', 'BleedBox', 'ArtBox']) page.node.delete(PDFName.of(k));
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    for (let a = 0; a < (annots?.size() ?? 0); a++) {
      const rect = annots.lookupMaybe(a, PDFDict)?.lookupMaybe(PDFName.of('Rect'), PDFArray);
      if (!rect || rect.size() !== 4) continue;
      const v = rect.asArray().map((x, k) => ctx.lookup(x).asNumber() * s + (k % 2 ? ty : tx));
      annots.lookup(a, PDFDict).set(PDFName.of('Rect'), ctx.obj(v.map(f)));
    }
  }
  return saveEdited(doc);
}

/**
 * Interleave two documents: A1, B1, A2, B2, ... Leftover pages of the longer one follow.
 * reverseB: B was scanned last page first (back sides of a duplex stack).
 * The result keeps document A's catalog; A page i ends at i < min(nA, nB) ? 2i : i + nB.
 */
export async function interleavePdfs(aBytes, bBytes, { reverseB = false } = {}) {
  const a = await loadPdf(aBytes);
  const b = await loadPdf(bBytes);
  const nA = a.getPageCount();
  let idx = b.getPageIndices();
  if (reverseB) idx = idx.reverse();
  const copied = await a.copyPages(b, idx);
  copied.forEach((p, k) => (k < nA ? a.insertPage(2 * k + 1, p) : a.addPage(p)));
  return saveEdited(a);
}

export async function insertBlankPage(bytes, atIndex, { width, height } = {}) {
  const doc = await loadPdf(bytes);
  const n = doc.getPageCount();
  if (!Number.isInteger(atIndex) || atIndex < 0 || atIndex > n) throw new RangeError(`atIndex must be 0..${n}`);
  let size = PAGE_SIZES.A4;
  if (width > 0 && height > 0) size = [width, height];
  else if (n > 0) {
    const g = pageGeometry(doc.getPage(atIndex > 0 ? atIndex - 1 : 0));
    size = [g.width, g.height];
  }
  doc.insertPage(atIndex, size);
  return saveEdited(doc);
}

export async function insertPagesFrom(destBytes, srcBytes, srcIndices, atIndex) {
  const dest = await loadPdf(destBytes);
  const src = await loadPdf(srcBytes);
  const n = dest.getPageCount();
  assertPageIndices(srcIndices, src.getPageCount(), 'srcIndices');
  if (!Number.isInteger(atIndex) || atIndex < 0 || atIndex > n) throw new RangeError(`atIndex must be 0..${n}`);
  const copied = await dest.copyPages(src, srcIndices);
  copied.forEach((p, k) => dest.insertPage(atIndex + k, p));
  return saveEdited(dest);
}

/** Replace dest pages atIndex..atIndex+n-1 by copies of the n source pages (in the order given). */
export async function replacePages(destBytes, srcBytes, srcIndices, atIndex) {
  const dest = await loadPdf(destBytes);
  const src = await loadPdf(srcBytes);
  const n = dest.getPageCount();
  assertPageIndices(srcIndices, src.getPageCount(), 'srcIndices');
  if (srcIndices.length === 0) throw new RangeError('No pages selected');
  if (!Number.isInteger(atIndex) || atIndex < 0 || atIndex + srcIndices.length > n) {
    throw new RangeError(`Replacing ${srcIndices.length} page(s) must start at 1-${n - srcIndices.length + 1}`);
  }
  const copied = await dest.copyPages(src, srcIndices);
  for (let k = srcIndices.length - 1; k >= 0; k--) dest.removePage(atIndex + k);
  copied.forEach((p, k) => dest.insertPage(atIndex + k, p));
  return saveEdited(dest);
}

/**
 * Rectangle on the page as displayed ({x0, y0, x1, y1} in points, origin top-left, y down, /Rotate
 * applied) -> [x, y, width, height] in PDF user space for /CropBox. `view` is the visible box
 * (pageGeometry().view) the displayed page shows; `rotation` its /Rotate (0, 90, 180, 270).
 */
export function displayedRectToCropBox(view, rotation, { x0, y0, x1, y1 }) {
  const { xMin, yMin, xMax, yMax } = view;
  let b;
  switch (rotation) {
    case 90: b = [xMin + y0, yMin + x0, xMin + y1, yMin + x1]; break;
    case 180: b = [xMax - x1, yMin + y0, xMax - x0, yMin + y1]; break;
    case 270: b = [xMax - y1, yMax - x1, xMax - y0, yMax - x0]; break;
    default: b = [xMin + x0, yMax - y1, xMin + x1, yMax - y0];
  }
  return [b[0], b[1], b[2] - b[0], b[3] - b[1]];
}

/**
 * Crop to a rectangle drawn on the page as displayed ({x0, y0, x1, y1}, points, top-left origin),
 * the same box on every page in `indices`, clamped to each page's visible size. Sets /CropBox.
 */
export async function cropPagesToRect(bytes, indices, rect) {
  for (const k of ['x0', 'y0', 'x1', 'y1']) if (!Number.isFinite(rect?.[k])) throw new RangeError(`Crop rectangle ${k} must be a number`);
  const doc = await loadPdf(bytes);
  assertPageIndices(indices, doc.getPageCount());
  for (const i of new Set(indices)) {
    const page = doc.getPage(i);
    const g = pageGeometry(page);
    const r = { x0: Math.max(0, rect.x0), y0: Math.max(0, rect.y0), x1: Math.min(g.width, rect.x1), y1: Math.min(g.height, rect.y1) };
    if (r.x1 - r.x0 < 1 || r.y1 - r.y0 < 1) throw new RangeError(`The crop box leaves nothing of page ${i + 1}`);
    page.setCropBox(...displayedRectToCropBox(g.view, g.rotation, r));
  }
  return saveEdited(doc);
}

/**
 * Crop by margins measured on the page as displayed (after /Rotate).
 * Sets /CropBox; MediaBox is unchanged.
 */
export async function cropPages(bytes, indices, { left = 0, top = 0, right = 0, bottom = 0 } = {}) {
  for (const [k, v] of Object.entries({ left, top, right, bottom })) {
    if (!Number.isFinite(v) || v < 0) throw new RangeError(`Crop margin ${k} must be a non-negative number`);
  }
  const doc = await loadPdf(bytes);
  assertPageIndices(indices, doc.getPageCount());
  for (const i of new Set(indices)) {
    const page = doc.getPage(i);
    const g = pageGeometry(page);
    const r = { x0: left, y0: top, x1: g.width - right, y1: g.height - bottom };
    if (r.x1 - r.x0 < 1 || r.y1 - r.y0 < 1) throw new RangeError(`Crop margins leave nothing of page ${i + 1}`);
    page.setCropBox(...displayedRectToCropBox(g.view, g.rotation, r));
  }
  return saveEdited(doc);
}

export async function getMetadata(bytes, { password } = {}) {
  const doc = await loadPdf(bytes, { password });
  return readMetadata(doc);
}

export async function setMetadata(bytes, meta = {}) {
  const doc = await loadPdf(bytes);
  const { title, author, subject, keywords, creator, producer = PRODUCER } = meta;
  if (title !== undefined) doc.setTitle(String(title));
  if (author !== undefined) doc.setAuthor(String(author));
  if (subject !== undefined) doc.setSubject(String(subject));
  if (keywords !== undefined) {
    const list = Array.isArray(keywords) ? keywords.map(String) : String(keywords).split(/[,;]\s*|\s+/).filter(Boolean);
    doc.setKeywords(list);
  }
  if (creator !== undefined) doc.setCreator(String(creator));
  doc.setProducer(String(producer));
  return saveEdited(doc);
}

/**
 * Build a PDF with one image per page.
 * pageSize 'fit': page = image size (1 px = 1 pt) plus margins.
 * 'A4'/'Letter': orientation follows the image; image is scaled down (never up)
 * to fit inside the margins and centred.
 */
export async function imagesToPdf(images, { pageSize = 'fit', margin = 0 } = {}) {
  if (!Array.isArray(images) || images.length === 0) throw new TypeError('imagesToPdf expects a non-empty array');
  if (pageSize !== 'fit' && !PAGE_SIZES[pageSize]) throw new RangeError(`Unknown pageSize "${pageSize}"`);
  if (!Number.isFinite(margin) || margin < 0) throw new RangeError('margin must be a non-negative number');
  const doc = await createPdf();
  for (const { bytes, type } of images) {
    let img;
    if (type === 'png') img = await doc.embedPng(bytes);
    else if (type === 'jpg' || type === 'jpeg') img = await doc.embedJpg(bytes);
    else throw new TypeError(`Unsupported image type "${type}" (use 'png' or 'jpg')`);
    const iw = img.width;
    const ih = img.height;
    let pw;
    let ph;
    if (pageSize === 'fit') {
      pw = iw + 2 * margin;
      ph = ih + 2 * margin;
    } else {
      [pw, ph] = PAGE_SIZES[pageSize];
      if (iw > ih) [pw, ph] = [ph, pw];
    }
    const availW = pw - 2 * margin;
    const availH = ph - 2 * margin;
    if (availW <= 0 || availH <= 0) throw new RangeError('margin is larger than the page');
    const s = Math.min(availW / iw, availH / ih, 1);
    const w = iw * s;
    const h = ih * s;
    const page = doc.addPage([pw, ph]);
    page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  }
  return doc.save();
}
