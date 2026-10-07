// Item 5: FPDF_SaveAsCopy(FPDF_INCREMENTAL) on a PDF with a /Sig field: original bytes must be a prefix.
import { loadPdfium, openDoc, saveDoc, FPDF_INCREMENTAL, wide, free, setMatrix, check } from './_lib.mjs';
import { makeSignedPdf } from '../../../test/helpers.js';

const { m } = await loadPdfium();
const orig = await makeSignedPdf();
const d = openDoc(m, orig);
console.log(`FPDF_GetSignatureCount=${m.FPDF_GetSignatureCount(d.doc)}`);
const isPrefix = (out) => out.length >= orig.length && Buffer.compare(Buffer.from(out.subarray(0, orig.length)), Buffer.from(orig)) === 0;

const noop = saveDoc(m, d.doc, FPDF_INCREMENTAL);
check('incremental save, no change: original is exact prefix', isPrefix(noop), `orig=${orig.length} out=${noop.length}`);

const page = m.FPDF_LoadPage(d.doc, 1);
const t = m.FPDFPageObj_NewTextObj(d.doc, 'Helvetica', 12);
const p = wide(m, 'Added after signing'); m.FPDFText_SetText(t, p); free(m, p);
setMatrix(m, t, [1, 0, 0, 1, 50, 600]);
m.FPDFPage_InsertObject(page, t);
m.FPDFPage_GenerateContent(page);
const inc = saveDoc(m, d.doc, FPDF_INCREMENTAL);
check('incremental save after edit: original is exact prefix', isPrefix(inc), `orig=${orig.length} out=${inc.length} appended=${inc.length - orig.length}`);
const tail = Buffer.from(inc.subarray(orig.length)).toString('latin1');
console.log(`appended section has xref/trailer: ${/xref|\/Type\s*\/XRef/.test(tail)} /Prev: ${/\/Prev/.test(tail)}`);
const full = saveDoc(m, d.doc, 0);
check('non-incremental save is NOT a prefix (control)', !isPrefix(full), `out=${full.length}`);
m.FPDF_ClosePage(page); d.close();
const re = openDoc(m, inc);
check('re-open incremental output with PDFium', m.FPDF_GetPageCount(re.doc) === 2 && m.FPDF_GetSignatureCount(re.doc) === 1);
re.close();
