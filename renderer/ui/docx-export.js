// File > Export to Word, built-in engine ("ASH (built-in)", renderer/ui/office.js): PDF -> .docx without Microsoft Word.
// No DOM here: the caller passes the image encoder, so test/docx-export.test.js runs it in Node.
//
//   pageElements(items, rules, images, box) -> {elements, margins}: one page's content in reading order (top of the
//       displayed page first): paragraphs, tables and images.
//       Text: table-extract.js extractLayout cuts the page into blocks; a 'table' / 'ruled' block's rows of 2+ chunks
//       (from its first to its last such row) become a Word table with the block's columns (columns empty in every
//       row dropped, the first row is the header, bold); every other text row is a paragraph line.
//       Paragraphs: consecutive lines join while the baseline gap is at most PARA_GAP x the font size, the size and
//       the all-bold state stay the same and the next line is not indented (a first-line indent starts a paragraph).
//       A paragraph of at most 2 lines whose size is >= H1 (H2) x the page's body size is Heading 1 (Heading 2).
//       Runs keep bold / italic (from the font's flags or its name: Bold, Black, Heavy, Semibold, Italic, Oblique)
//       and the font size.
//       Images: imagesFromOps boxes, placed inline at their top edge, at their size on the page (capped to the
//       text width).
//       Margins: the content's distance from the page edges, clamped to MARGIN_MIN..MARGIN_MAX (72 pt when empty).
//   buildDocx(docx, pages) -> docx Document: one section per PDF page (page size and margins from the page, so
//       every PDF page starts a new Word page). pages[i] = {width, height, elements, margins, images}, images[k] =
//       {data: Uint8Array, type: 'png' | 'jpg'} | null (an image the encoder could not hand over is left out).
//   pdfToDocx(pdfDoc, {OPS, encode, textContent?}) -> Uint8Array (.docx): pdf.js document -> the two above.
import { textItems, extractLayout, groupRows, rulesFromOps, pageBox, imagesFromOps } from './table-extract.js';

const TWIP = 20;          // twips per point
const PX = 96 / 72;       // docx image sizes are pixels at 96 dpi
const PARA_GAP = 1.5;     // x font size: a larger baseline gap starts a paragraph
const SPACE_GAP = 0.1;    // x font size: a larger gap between items is a space
const H1 = 1.5, H2 = 1.2; // x body size: heading levels
const MARGIN_MIN = 18, MARGIN_MAX = 108, MARGIN_DEFAULT = 72; // pt

/** pdf.js font object (commonObjs) and its name -> {bold, italic}. */
export function fontStyle(font) {
  const name = String(font?.name ?? '');
  return {
    bold: !!font?.bold || !!font?.black || /bold|black|heavy|semibold|demibold/i.test(name),
    italic: !!font?.italic || /italic|oblique/i.test(name),
  };
}

// One text row (groupRows) -> runs [{text, bold, italic, size}]; items of the same style merge, a gap is a space.
function lineRuns(row, styles) {
  const runs = [];
  let prevEnd = null;
  for (const it of row.items) {
    const st = styles(it.font);
    const size = Math.round(it.size * 2) / 2;
    const gap = prevEnd === null ? 0 : it.x - prevEnd;
    let text = it.str;
    const last = runs.at(-1);
    if (last && gap > SPACE_GAP * it.size && !/\s$/.test(last.text) && !/^\s/.test(text)) text = ` ${text}`;
    if (last && last.bold === st.bold && last.italic === st.italic && last.size === size) last.text += text;
    else runs.push({ text, bold: st.bold, italic: st.italic, size });
    prevEnd = it.x + it.w;
  }
  return runs;
}

/** Lines (in page order) -> paragraphs [{lines: [row], runs, size}]. */
function paragraphs(lines, styles) {
  const out = [];
  for (const row of lines) {
    const runs = lineRuns(row, styles);
    const bold = runs.every((r) => r.bold);
    const x0 = row.items[0].x;
    const p = out.at(-1);
    const prev = p?.lines.at(-1);
    const joins = p && prev.y - row.y <= PARA_GAP * Math.max(row.size, prev.size) && prev.y > row.y
      && Math.abs(row.size - p.size) <= 0.5 && bold === p.bold && x0 <= p.x0 + 0.8 * row.size;
    if (joins) {
      const last = p.runs.at(-1);
      if (!/\s$/.test(last.text)) runs[0] = { ...runs[0], text: ` ${runs[0].text}` };
      for (const r of runs) {
        const l = p.runs.at(-1);
        if (l.bold === r.bold && l.italic === r.italic && l.size === r.size) l.text += r.text; else p.runs.push(r);
      }
      p.lines.push(row);
    } else out.push({ lines: [row], runs, size: row.size, bold, x0 });
  }
  return out;
}

/**
 * One page -> {elements, margins}. items: textItems() of the page (with font ids); rules: rulesFromOps() or null;
 * images: imagesFromOps() boxes; box: pageBox(); styles(fontId) -> {bold, italic}.
 * elements (reading order): {type: 'para', top, runs, heading: 0 | 1 | 2} | {type: 'table', top, rows} |
 * {type: 'image', top, index, width, height} (index into images; width/height in points). margins in points.
 */
export function pageElements(items, rules, images, box, styles = () => ({ bold: false, italic: false })) {
  const top = (x, y) => box.m[1] * x + box.m[3] * y + box.m[5];
  const layout = extractLayout(items, rules);
  const byY = new Map(groupRows(items.filter((it) => it.str.trim())).map((r) => [r.y, r]));
  const elements = [];
  let paraLines = [];
  const flush = () => { if (paraLines.length) elements.push({ lines: paraLines }); paraLines = []; };
  for (const b of layout.blocks) {
    const multi = b.lines.map((l, k) => (l.single ? -1 : k)).filter((k) => k >= 0);
    const tabular = (b.kind === 'table' || b.kind === 'ruled') && multi.length >= 2;
    const f = tabular ? multi[0] : b.lines.length, l = tabular ? multi.at(-1) : -1;
    b.lines.forEach((line, k) => { if (k < f) paraLines.push(byY.get(line.y)); });
    if (tabular) {
      flush();
      const yTop = b.lines[f].y, yBottom = b.lines[l].y;
      let rows = [];
      for (let r = b.start; r < b.end; r++) {
        const at = layout.at[r];
        if (at && at.y <= yTop + 0.01 && at.y >= yBottom - 0.01) rows.push(layout.rows[r]);
      }
      if (!rows.length) { b.lines.forEach((line, k) => { if (k >= f) paraLines.push(byY.get(line.y)); }); continue; }
      const used = rows[0].map((_, c) => rows.some((row) => row[c] !== null));
      rows = rows.map((row) => row.filter((_, c) => used[c]).map((v) => (v === null ? '' : String(v))));
      const row0 = byY.get(yTop);
      elements.push({ type: 'table', top: top(row0.items[0].x, yTop) - row0.size, rows });
      b.lines.forEach((line, k) => { if (k > l) paraLines.push(byY.get(line.y)); });
    }
  }
  flush();
  // Text groups -> paragraphs; the page's body size (most characters) decides the heading levels.
  const paras = elements.filter((e) => e.lines).flatMap((e) => paragraphs(e.lines, styles));
  const chars = new Map();
  for (const p of paras) for (const r of p.runs) chars.set(r.size, (chars.get(r.size) ?? 0) + r.text.length);
  const body = [...chars].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  const out = elements.filter((e) => e.type === 'table');
  for (const p of paras) {
    const level = !body || p.lines.length > 2 ? 0 : p.size >= H1 * body ? 1 : p.size >= H2 * body ? 2 : 0;
    const first = p.lines[0];
    out.push({ type: 'para', top: top(first.items[0].x, first.y) - first.size, runs: p.runs, heading: level });
  }
  images.forEach((img, index) => out.push({ type: 'image', top: img.box.top, index,
    width: img.box.right - img.box.left, height: img.box.bottom - img.box.top }));
  out.sort((a, b) => a.top - b.top);
  // Margins: the content's extent on the displayed page.
  const xs = [], ys = [];
  for (const it of items) {
    const a = [box.m[0] * it.x + box.m[2] * it.y + box.m[4], top(it.x, it.y)];
    const b = [box.m[0] * (it.x + it.w) + box.m[2] * (it.y + it.size) + box.m[4], top(it.x + it.w, it.y + it.size)];
    xs.push(a[0], b[0]); ys.push(a[1], b[1]);
  }
  for (const img of images) { xs.push(img.box.left, img.box.right); ys.push(img.box.top, img.box.bottom); }
  const clamp = (v) => (Number.isFinite(v) ? Math.min(MARGIN_MAX, Math.max(MARGIN_MIN, v)) : MARGIN_DEFAULT);
  const margins = xs.length
    ? { left: clamp(Math.min(...xs)), right: clamp(box.width - Math.max(...xs)), top: clamp(Math.min(...ys)), bottom: clamp(box.height - Math.max(...ys)) }
    : { left: MARGIN_DEFAULT, right: MARGIN_DEFAULT, top: MARGIN_DEFAULT, bottom: MARGIN_DEFAULT };
  return { elements: out, margins };
}

/** docx module + pages (see the header) -> docx Document. */
export function buildDocx(docx, pages) {
  const { Document, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell, WidthType, HeadingLevel, PageOrientation } = docx;
  const sections = pages.map((pg) => {
    const m = pg.margins;
    const textW = Math.max(72, pg.width - m.left - m.right);
    const children = [];
    for (const el of pg.elements) {
      if (el.type === 'para') {
        children.push(new Paragraph({
          heading: el.heading === 1 ? HeadingLevel.HEADING_1 : el.heading === 2 ? HeadingLevel.HEADING_2 : undefined,
          spacing: { after: 120 },
          children: el.runs.map((r) => new TextRun({ text: r.text, bold: r.bold, italics: r.italic, size: Math.round(r.size * 2) })),
        }));
      } else if (el.type === 'table') {
        const cols = Math.max(1, ...el.rows.map((r) => r.length));
        const colW = Math.floor((textW * TWIP) / cols);
        children.push(new Table({
          width: { size: colW * cols, type: WidthType.DXA },
          columnWidths: Array(cols).fill(colW),
          rows: el.rows.map((row, k) => new TableRow({
            tableHeader: k === 0,
            children: Array.from({ length: cols }, (_, c) => new TableCell({
              width: { size: colW, type: WidthType.DXA },
              children: [new Paragraph({ children: [new TextRun({ text: row[c] ?? '', bold: k === 0 })] })],
            })),
          })),
        }));
        children.push(new Paragraph({ children: [] })); // Word needs a paragraph between consecutive tables
      } else if (el.type === 'image') {
        const img = pg.images?.[el.index];
        if (!img) continue;
        const s = Math.min(1, textW / el.width);
        children.push(new Paragraph({ children: [new ImageRun({ type: img.type, data: img.data,
          transformation: { width: Math.max(1, Math.round(el.width * s * PX)), height: Math.max(1, Math.round(el.height * s * PX)) } })] }));
      }
    }
    const landscape = pg.width > pg.height;
    return {
      properties: { page: {
        size: { width: Math.round(Math.min(pg.width, pg.height) * TWIP), height: Math.round(Math.max(pg.width, pg.height) * TWIP),
          orientation: landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT },
        margin: { top: Math.round(m.top * TWIP), right: Math.round(m.right * TWIP), bottom: Math.round(m.bottom * TWIP), left: Math.round(m.left * TWIP) },
      } },
      children: children.length ? children : [new Paragraph({ children: [] })],
    };
  });
  return new Document({ creator: 'ASH PDF Studio', sections });
}

// An image XObject's pixels: page.objs (commonObjs for "g_" ids) once resolved; null after 5 s.
function imageObject(page, id) {
  const objs = id.startsWith('g_') ? page.commonObjs : page.objs;
  if (objs.has(id)) return Promise.resolve(objs.get(id));
  return Promise.race([new Promise((r) => objs.get(id, r)), new Promise((r) => setTimeout(() => r(null), 5000))]);
}

/**
 * pdf.js document -> .docx bytes. OPS: pdf.js OPS; encode(img) -> {data: Uint8Array, type: 'png' | 'jpg'} | null for a
 * pdf.js decoded image; textContent(pageIndex) -> getTextContent() result (default: the page's own); docxLib: the docx
 * module (default: import('docx'), the vendored build in the renderer).
 */
export async function pdfToDocx(pdfDoc, { OPS, encode, textContent, docxLib } = {}) {
  const pages = [];
  for (let i = 0; i < pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i + 1);
    let opList = null, rules = null;
    try { opList = await page.getOperatorList(); rules = rulesFromOps(opList, OPS); } catch { /* damaged page: text only */ }
    const content = textContent ? await textContent(i) : await page.getTextContent();
    const box = pageBox(page.view, page.rotate);
    const found = opList ? imagesFromOps(opList, OPS, box) : [];
    const fonts = new Map();
    const styles = (id) => {
      if (!id) return { bold: false, italic: false };
      if (!fonts.has(id)) {
        let font = null;
        try { font = page.commonObjs.has(id) ? page.commonObjs.get(id) : null; } catch { /* not loaded */ }
        fonts.set(id, fontStyle(font ?? { name: content.styles?.[id]?.fontFamily }));
      }
      return fonts.get(id);
    };
    const { elements, margins } = pageElements(textItems(content), rules, found, box, styles);
    const images = [];
    for (const f of found) {
      let enc = null;
      try {
        const img = f.data ?? await imageObject(page, f.id);
        if (img?.width && img?.height) enc = await encode(img);
      } catch { /* an image pdf.js cannot hand over is left out */ }
      images.push(enc);
    }
    pages.push({ width: box.width, height: box.height, elements, margins, images });
  }
  const docx = docxLib ?? await import('docx');
  const doc = buildDocx(docx, pages);
  return new Uint8Array(await docx.Packer.toArrayBuffer(doc));
}
