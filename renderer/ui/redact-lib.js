// Pure helpers of Apply redactions (redact.js), testable in Node: the redaction areas of the
// redactMark objects in PDF user space, and the metadata scrub.
import { PDFName, PDFRef, PDFArray, PDFDict, PDFStream } from 'pdf-lib';
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

/** Delete every indirect object not reachable from the trailer's /Root and /Info (pdf-lib writes them all). */
function dropUnreachable(doc) {
  const ctx = doc.context, seen = new Set(), todo = [ctx.trailerInfo.Root, ctx.trailerInfo.Info];
  while (todo.length) {
    const o = todo.pop();
    if (o instanceof PDFRef) { if (!seen.has(o.toString())) { seen.add(o.toString()); todo.push(ctx.lookup(o)); } }
    else if (o instanceof PDFStream) todo.push(o.dict);
    else if (o instanceof PDFDict) for (const [, v] of o.entries()) todo.push(v);
    else if (o instanceof PDFArray) todo.push(...o.asArray());
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.toString())) ctx.delete(ref);
}

/** Refs (as "n g" strings) of every annotation on every page. */
function pageAnnotRefs(doc) {
  const out = new Set();
  for (const p of doc.getPages()) for (const r of p.node.Annots()?.asArray() ?? []) if (r instanceof PDFRef) out.add(r.toString());
  return out;
}
/** Full names of the fields with at least one widget on a page. */
function onPageFields(doc, on) {
  const names = new Set();
  for (const f of doc.getForm().getFields()) {
    if (f.acroField.getWidgets().some((w) => on.has(String(doc.context.getObjectRef(w.dict))))) names.add(f.getName());
  }
  return names;
}

/**
 * After PDFium removed the annotations under the redaction areas (src -> out): a form field whose
 * widgets on the pages were all removed loses its /V and /DV and leaves /AcroForm /Fields (with its
 * kids); a widget removed from a field that keeps others leaves its /Kids. A /Popup whose /Parent was
 * removed goes too, with the parent's dictionary (its /Contents). Returns { bytes, fields: [names] }.
 */
export async function pruneRedactedAnnots(src, out) {
  const before = await loadPdf(src);
  const was = onPageFields(before, pageAnnotRefs(before));
  const doc = await loadPdf(out);
  const ctx = doc.context, on = pageAnnotRefs(doc), form = doc.getForm(), fields = [];
  let changed = false;
  for (const f of form.getFields()) {
    const name = f.getName();
    if (!was.has(name)) continue;
    const widgets = f.acroField.getWidgets(), refs = widgets.map((w) => ctx.getObjectRef(w.dict));
    const gone = refs.filter((r) => r && !on.has(r.toString()));
    if (!gone.length) continue;
    changed = true;
    if (gone.length < refs.length) { // some widgets stay visible: keep the field, drop only the removed kids
      const kids = f.acroField.dict.lookup(PDFName.of('Kids'));
      if (kids instanceof PDFArray) for (const r of gone) { const k = kids.indexOf(r); if (k !== undefined) kids.remove(k); ctx.delete(r); }
      continue;
    }
    for (const d of [f.acroField.dict, ...widgets.map((w) => w.dict)]) { d.delete(PDFName.of('V')); d.delete(PDFName.of('DV')); }
    // Detach from the parent's /Kids or /AcroForm /Fields (the widgets are already off the pages).
    const holder = (f.acroField.getParent()?.dict ?? form.acroForm.dict).lookup(PDFName.of(f.acroField.getParent() ? 'Kids' : 'Fields'));
    const k = holder instanceof PDFArray ? holder.indexOf(f.ref) : undefined;
    if (k !== undefined) holder.remove(k);
    for (const r of [f.ref, ...refs]) if (r) ctx.delete(r);
    fields.push(name);
  }
  for (const p of doc.getPages()) {
    const annots = p.node.Annots();
    if (!annots) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const ref = annots.get(i), a = annots.lookup(i);
      if (!(a instanceof PDFDict) || a.get(PDFName.of('Subtype')) !== PDFName.of('Popup')) continue;
      const parent = a.get(PDFName.of('Parent'));
      if (!(parent instanceof PDFRef) || on.has(parent.toString())) continue;
      annots.remove(i);
      if (ref instanceof PDFRef) ctx.delete(ref);
      ctx.delete(parent);
      changed = true;
    }
  }
  if (changed) dropUnreachable(doc); // e.g. a removed widget's appearance stream, which shows its value
  return { bytes: changed ? await saveEdited(doc) : out, fields };
}
