// Pure helpers of Apply redactions (redact.js), testable in Node: the redaction areas of the
// redactMark objects in PDF user space, and the metadata scrub.
import { PDFName, PDFRef } from 'pdf-lib';
import { loadPdf, saveEdited, pageGeometry, visibleUpMatrix } from '../../src/core/internal.js';

/** Visible (overlay, y down) box -> [x0, y0, x1, y1] in PDF user space (rotation and crop box aware). */
function visRectToPdf(g, { x, y, w, h }) {
  const [a, b, c, d, e, f] = visibleUpMatrix(g);
  const pts = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([px, py]) => {
    const uy = g.height - py;
    return [a * px + c * uy + e, b * px + d * uy + f];
  });
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** redactMark objects {page, x, y, w, h} -> [{ pageIndex, rects }] for pdfium.redact, pages in order. */
export async function markAreas(bytes, marks) {
  const pages = (await loadPdf(bytes)).getPages();
  const by = new Map();
  for (const o of marks) {
    if (!pages[o.page] || !(o.w > 0) || !(o.h > 0)) continue;
    if (!by.has(o.page)) by.set(o.page, []);
    by.get(o.page).push(visRectToPdf(pageGeometry(pages[o.page]), o));
  }
  return [...by].sort((p, q) => p[0] - q[0]).map(([pageIndex, rects]) => ({ pageIndex, rects }));
}

const INFO_KEYS = ['Title', 'Author', 'Subject', 'Keywords'];

/** Remove the Info title, author, subject and keywords and the catalog /Metadata (XMP) stream. */
export async function scrubMetadata(bytes) {
  const doc = await loadPdf(bytes);
  const infoRef = doc.context.trailerInfo.Info;
  const info = infoRef && doc.context.lookup(infoRef);
  if (info?.delete) for (const k of INFO_KEYS) info.delete(PDFName.of(k));
  const xmp = doc.catalog.get(PDFName.of('Metadata'));
  if (xmp instanceof PDFRef) doc.context.delete(xmp); // pdf-lib writes every object it holds, referenced or not
  doc.catalog.delete(PDFName.of('Metadata'));
  return saveEdited(doc);
}
