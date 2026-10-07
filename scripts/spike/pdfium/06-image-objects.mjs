// Item 6: move / scale / delete an image object; replace its bitmap.
import { loadPdfium, openDoc, makeFixture, saveDoc, getBounds, getMatrix, OBJ, check } from './_lib.mjs';
import { renderPage, isColor } from '../../../test/helpers.js';

const { m } = await loadPdfium();
const bytes = await makeFixture(1);
const findImage = (page) => { for (let i = 0; i < m.FPDFPage_CountObjects(page); i++) { const o = m.FPDFPage_GetObject(page, i); if (m.FPDFPageObj_GetType(o) === OBJ.IMAGE) return o; } return 0; };
const at = async (out, x, y) => (await renderPage(out, 0, 1)).sample(x, 792 - y); // PDF coords -> visible

// Move + scale: FPDFPageObj_Transform(obj, a,b,c,d,e,f) post-multiplies the object matrix
let d = openDoc(m, bytes), page = m.FPDF_LoadPage(d.doc, 0), img = findImage(page);
console.log(`image matrix before=[${getMatrix(m, img)}]`);
m.FPDFPageObj_Transform(img, 0.5, 0, 0, 0.5, 0, 0); // scale about origin
m.FPDFPageObj_Transform(img, 1, 0, 0, 1, -100, 200); // then move
const b = getBounds(m, img);
console.log(`image matrix after=[${getMatrix(m, img)}] bounds=[${[b.l, b.b, b.r, b.t].map(Math.round)}]`);
m.FPDFPage_GenerateContent(page);
let out = saveDoc(m, d.doc);
check('moved+scaled: blue at new centre (90,460)', isColor(await at(out, 90, 460), [0, 0, 255]));
check('moved+scaled: old centre (380,520) now white', isColor(await at(out, 380, 520), [255, 255, 255]));
m.FPDF_ClosePage(page); d.close();

// Replace bitmap: FPDFBitmap_Create + FillRect + FPDFImageObj_SetBitmap
d = openDoc(m, bytes); page = m.FPDF_LoadPage(d.doc, 0); img = findImage(page);
const bmp = m.FPDFBitmap_Create(80, 40, 0);
m.FPDFBitmap_FillRect(bmp, 0, 0, 80, 40, 0xffff0000); // ARGB red
check('FPDFImageObj_SetBitmap', m.FPDFImageObj_SetBitmap(0, 0, img, bmp));
m.FPDFBitmap_Destroy(bmp);
m.FPDFPage_GenerateContent(page);
out = saveDoc(m, d.doc);
check('bitmap replaced: red at image centre', isColor(await at(out, 380, 520), [255, 0, 0]), `px=${(await at(out, 380, 520)).slice(0, 3)}`);
m.FPDF_ClosePage(page); d.close();

// Delete
d = openDoc(m, bytes); page = m.FPDF_LoadPage(d.doc, 0); img = findImage(page);
check('FPDFPage_RemoveObject image', m.FPDFPage_RemoveObject(page, img)); m.FPDFPageObj_Destroy(img);
m.FPDFPage_GenerateContent(page);
out = saveDoc(m, d.doc);
check('deleted: image centre white', isColor(await at(out, 380, 520), [255, 255, 255]));
m.FPDF_ClosePage(page); d.close();
