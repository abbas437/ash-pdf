// Item 4: true redaction - remove text (char-precise) and images inside a rect, draw black box, save, verify.
import { loadPdfium, openDoc, listObjects, makeFixture, saveDoc, malloc, free, getBounds, pdfjsText, OBJ, check } from './_lib.mjs';
import { pageContent } from '../../../test/helpers.js';

const { m } = await loadPdfium();
const d = openDoc(m, await makeFixture(1));
const page = m.FPDF_LoadPage(d.doc, 0);
// Rect (PDF user space) over only the "99-1234" part of the "SECRET 99-1234" object (which starts at x=200,
// "99-1234" at ~x=252) and the left half of the image (300..460 x 480..560): tests sub-object precision.
const R = { l: 250, b: 470, r: 380, t: 615 };
const before = listObjects(m, page, m.FPDFText_LoadPage(page));

// Text: EPDFText_RedactInRect(page, FS_RECTF*{left,top,right,bottom}, recurseForms, drawBlackBoxes)
const rp = malloc(m, 16);
[R.l, R.t, R.r, R.b].forEach((v, i) => m.pdfium.setValue(rp + 4 * i, v, 'float'));
check('EPDFText_RedactInRect', m.EPDFText_RedactInRect(page, rp, true, false));
free(m, rp);

// Images: no char-level API; remove any image object whose bounds intersect the rect.
let removedImages = 0;
for (let i = m.FPDFPage_CountObjects(page) - 1; i >= 0; i--) {
  const o = m.FPDFPage_GetObject(page, i);
  if (m.FPDFPageObj_GetType(o) !== OBJ.IMAGE) continue;
  const b = getBounds(m, o);
  if (b.l < R.r && b.r > R.l && b.b < R.t && b.t > R.b) { m.FPDFPage_RemoveObject(page, o); m.FPDFPageObj_Destroy(o); removedImages++; }
}
// Black box: FPDFPageObj_CreateNewRect + fill
const box = m.FPDFPageObj_CreateNewRect(R.l, R.b, R.r - R.l, R.t - R.b);
m.FPDFPageObj_SetFillColor(box, 0, 0, 0, 255);
m.FPDFPath_SetDrawMode(box, 1 /* FPDF_FILLMODE_ALTERNATE */, false);
m.FPDFPage_InsertObject(page, box);
check('FPDFPage_GenerateContent', m.FPDFPage_GenerateContent(page));
const after = listObjects(m, page, m.FPDFText_LoadPage(page));
console.log(`objects before: ${before.map((o) => o.type === OBJ.TEXT ? JSON.stringify(o.text) : 't' + o.type).join(', ')}`);
console.log(`objects after : ${after.map((o) => o.type === OBJ.TEXT ? JSON.stringify(o.text) : 't' + o.type).join(', ')}; images removed=${removedImages}`);

const out = saveDoc(m, d.doc, 0); // full rewrite - an incremental save would keep the old stream in the prefix
const txt = await pdfjsText(out);
console.log('pdf.js extracts:', JSON.stringify(txt));
check('redacted chars not extractable', !txt.includes('99-1234') && !txt.includes('99-'));
check('chars of the same object outside rect kept (char-level, not object-level)', txt.includes('SECRET'));
check('text outside rect kept', txt.includes('Public line') && txt.includes('Invoice number 4711'));
const cs = await pageContent(out, 0);
check('content stream has no 99-1234 glyph run', !/99-1234/.test(cs), `stream ${cs.length} bytes`);
check('raw file has no "99-1234"', !Buffer.from(out).toString('latin1').includes('99-1234'));
d.close();
