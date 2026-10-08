// OCR text layer (Tools > Recognize text (OCR)…): the pure parts shared by the renderer and the tests.
// The renderer draws a page with pdf.js at `scale` (pixels per PDF point, 300 dpi = 300/72) with the page's own
// /Rotate, OCRs the canvas, and hands the word boxes (device pixels) to addTextLayer, which writes them as
// invisible text (render mode 3) in PDF user space so the page becomes searchable, selectable and copyable
// while its visible content stays unchanged.
import { PDFDocument, StandardFonts, TextRenderingMode, pushGraphicsState, popGraphicsState, beginText, endText,
  setFontAndSize, setTextRenderingMode, setCharacterSqueeze, setTextMatrix, showText } from 'pdf-lib';

/**
 * Device pixel (px, py) of a page rendered by pdf.js (viewport with the page's rotation, offset 0) → PDF user space.
 * view = [x0, y0, x1, y1]: the rendered box (crop box); rotate: the page /Rotate (0/90/180/270); scale: px per pt.
 */
export function deviceToPdf(px, py, { view, rotate, scale }) {
  const [x0, y0, x1, y1] = view;
  const u = px / scale, v = py / scale;
  switch (((rotate % 360) + 360) % 360) {
    case 90: return [x0 + v, y0 + u];
    case 180: return [x1 - u, y0 + v];
    case 270: return [x1 - v, y1 - u];
    default: return [x0 + u, y1 - v];
  }
}

/**
 * Text placement for one OCR word box {x0, y0, x1, y1} (device pixels, y down): the baseline origin, the unit
 * reading direction and the up direction in PDF space, and the box width and height in points.
 */
export function wordPlacement(box, geom) {
  const o = deviceToPdf(box.x0, box.y1, geom);   // bottom-left in device space
  const r = deviceToPdf(box.x1, box.y1, geom);   // bottom-right
  const t = deviceToPdf(box.x0, box.y0, geom);   // top-left
  const width = Math.hypot(r[0] - o[0], r[1] - o[1]), height = Math.hypot(t[0] - o[0], t[1] - o[1]);
  const dir = width ? [(r[0] - o[0]) / width, (r[1] - o[1]) / width] : [1, 0];
  const up = height ? [(t[0] - o[0]) / height, (t[1] - o[1]) / height] : [0, 1];
  return { origin: o, dir, up, width, height };
}

// Font size from the box height; the baseline sits a little above the box bottom (descenders).
const SIZE_OF_HEIGHT = 1, BASELINE_RISE = 0.15;

/** Characters of `text` the standard (WinAnsi) font can encode; others become '?'. */
function encodable(font, text) {
  let out = '';
  for (const ch of text) { try { font.encodeText(ch); out += ch; } catch { out += '?'; } }
  return out;
}

/**
 * Add an invisible text layer to the given pages.
 * pages: [{ index, geom: {view, rotate, scale}, words: [{ text, bbox: {x0, y0, x1, y1} }] }].
 * Returns the new PDF bytes. Pages without words are left untouched.
 */
export async function addTextLayer(bytes, pages) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const { index, geom, words } of pages) {
    const list = (words ?? []).filter((w) => w.text?.trim());
    if (!list.length) continue;
    const page = doc.getPage(index);
    const key = page.node.newFontDictionary(font.name, font.ref);
    const ops = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
    for (const w of list) {
      const p = wordPlacement(w.bbox, geom);
      if (!(p.width > 0 && p.height > 0)) continue;
      const text = encodable(font, w.text.trim());
      const size = p.height * SIZE_OF_HEIGHT;
      const natural = font.widthOfTextAtSize(text, size);
      const x = p.origin[0] + p.up[0] * size * BASELINE_RISE, y = p.origin[1] + p.up[1] * size * BASELINE_RISE;
      ops.push(setFontAndSize(key, size), setCharacterSqueeze(natural ? (100 * p.width) / natural : 100),
        setTextMatrix(p.dir[0], p.dir[1], p.up[0], p.up[1], x, y), showText(font.encodeText(text)));
    }
    ops.push(endText(), popGraphicsState());
    // The page's own content may leave the graphics state changed (an unbalanced cm): wrap it in q … Q first so the
    // text layer, appended after it, is positioned in plain user space.
    page.node.normalize();
    const stream = (op) => doc.context.register(page.createContentStream(op));
    page.node.wrapContentStreams(stream(pushGraphicsState()), stream(popGraphicsState()));
    page.pushOperators(...ops);
  }
  return doc.save({ useObjectStreams: false });
}
