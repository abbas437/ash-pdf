// Item 2: enumerate page objects; text objects -> text, font, size, matrix, bounds; find a word.
import { loadPdfium, openDoc, listObjects, makeFixture, OBJ, check } from './_lib.mjs';

const { m } = await loadPdfium();
const d = openDoc(m, await makeFixture(1));
const page = m.FPDF_LoadPage(d.doc, 0);
const tp = m.FPDFText_LoadPage(page);
const objs = listObjects(m, page, tp);
const r = (v) => Math.round(v * 10) / 10;
for (const o of objs) {
  const b = o.bounds ? `[${r(o.bounds.l)},${r(o.bounds.b)},${r(o.bounds.r)},${r(o.bounds.t)}]` : '-';
  if (o.type === OBJ.TEXT) console.log(`#${o.i} TEXT ${JSON.stringify(o.text)} font=${o.font} embedded=${o.embedded} size=${r(o.size)} matrix=[${o.matrix.map(r)}] bounds=${b}`);
  else console.log(`#${o.i} type=${o.type} bounds=${b}`);
}
const word = '4711';
const hits = objs.filter((o) => o.type === OBJ.TEXT && o.text.split(/\s+/).includes(word));
check(`find object containing "${word}"`, hits.length === 1, `objects #${hits.map((h) => h.i)}`);
// Char-level alternative: text page index -> owning text object
const n = m.FPDFText_CountChars(tp);
console.log(`text page chars=${n}; char 0 belongs to object #${objs.findIndex((o) => o.obj === m.FPDFText_GetTextObject(tp, 0))}`);
check('text object count', objs.filter((o) => o.type === OBJ.TEXT).length === 4);
check('image object found', objs.some((o) => o.type === OBJ.IMAGE));
m.FPDFText_ClosePage(tp); m.FPDF_ClosePage(page); d.close();
