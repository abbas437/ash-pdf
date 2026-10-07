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
    let { xMin, yMin, xMax, yMax } = g.view;
    switch (g.rotation) {
      case 90:
        yMin += left; yMax -= right; xMin += top; xMax -= bottom;
        break;
      case 180:
        xMax -= left; xMin += right; yMin += top; yMax -= bottom;
        break;
      case 270:
        yMax -= left; yMin += right; xMax -= top; xMin += bottom;
        break;
      default:
        xMin += left; xMax -= right; yMax -= top; yMin += bottom;
    }
    if (xMax - xMin < 1 || yMax - yMin < 1) throw new RangeError(`Crop margins leave nothing of page ${i + 1}`);
    page.setCropBox(xMin, yMin, xMax - xMin, yMax - yMin);
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
