// Table extraction for File > Export to Excel (renderer/ui/exports.js). Pure: no DOM, no pdf.js,
// so test/table-extract.test.js runs it in Node.
//
//   textItems(content)  pdf.js getTextContent() items -> [{str, x, y, w, size}] in PDF points
//                       (x, y = start of the baseline; empty and whitespace-only items dropped)
//   rulesFromOps(opList, OPS)  pdf.js page.getOperatorList() -> ruling lines in PDF points:
//                       {vertical: [{x, y0, y1}], horizontal: [{y, x0, x1}]} (thin filled rectangles
//                       and axis-aligned stroked segments; curves ignored)
//   extractTable(items, rules?) -> rows of cells: string | number | null (an empty cell)
//   extractLayout(items, rules?) -> {rows (as extractTable), at: where each sheet row's text starts,
//                       blocks: [{kind, start, end, lines}] (see extractLayout)}
//   pageBox / imagesFromOps / placeImages / rgbaPixels  the page's images and where they go in the sheet
//                       (see "images" below)
//
// Rows: items whose baselines are within 0.4 x font size of a row's baseline join that row.
// Cells: within a row, items closer than CELL_GAP x font size merge into one chunk ("Net amount"),
// never across a vertical rule.
// Blocks: the page is cut into blocks, in page order, before any columns are found:
//   ruled table   consecutive rows crossed by the same set of 3+ vertical rules, no chunk crossing
//                 one: the rules are the column boundaries. Where horizontal rules separate most of
//                 the block's rows, rows not separated by one are lines of the same cells (a header
//                 wrapped onto two lines) and join into one sheet row.
//   table         consecutive rows of 2+ chunks, each narrower than PROSE x the page's text width, that
//                 do not cross the block's column gaps. Columns: the block's chunks' x-extents are
//                 projected onto the x axis; overlapping extents merge into bands, so a boundary is a
//                 gap no chunk of the block crosses.
//   prose         rows of 2+ chunks with one wider than PROSE x the text width (a label + a sentence):
//                 written as label + text in two cells, or one cell.
//   Rows of a single chunk (titles, notes, paragraph lines) never start a block: they join the block
//   above (lines at the top of the page join the first block), are left out of its projection, and go
//   to the band their left edge falls in when narrow and inside a text-only table, else to column A.
//   One empty sheet row separates blocks; columns restart at A in every block.
// A cell that is a plain number (thousands separators and decimals allowed) becomes a Number.

const ROW_TOL = 0.4;  // x font size: same baseline
const CELL_GAP = 0.8; // x font size: a gap below this is inside a cell (word spacing is ~0.25-0.35)
const SPACE_GAP = 0.1; // x font size: a gap above this between merged items is a space
const PROSE = 0.4;    // x text width of the page: a wider chunk is running text, not a cell
const THIN = 3;       // pt: a filled rectangle this thin is a rule
const SAME_X = 2;     // pt: vertical rules closer than this are one boundary (double borders)

export function textItems(content) {
  const out = [];
  for (const it of content?.items ?? []) {
    if (typeof it.str !== 'string' || !it.str.trim() || !it.transform) continue;
    const [a, b, c, d, x, y] = it.transform;
    const size = Math.hypot(c, d) || Math.hypot(a, b) || it.height || 1;
    out.push({ str: it.str, x, y, w: it.width ?? 0, size, ...(it.fontName ? { font: it.fontName } : {}) });
  }
  return out;
}

const NUMBER = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?$/;
/** '1,234.50' -> 1234.5; anything that is not a plain number stays a string. */
export function cellValue(text) {
  const s = text.trim();
  if (!s) return null;
  if (/\d/.test(s) && NUMBER.test(s)) return Number(s.replace(/,/g, ''));
  return s;
}

// Matrix product m x n (pdf.js / PDF [a b c d e f] form): n applied first, then m.
const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

// pdf.js 6 operator list -> ruling lines (see the header). Paths are mapped through cm/save/restore and
// form matrices into page space, the space textItems() reports.
export function rulesFromOps({ fnArray, argsArray }, OPS) {
  const vertical = [], horizontal = [];
  const STROKE = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const FILL = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const rule = (ax, ay, bx, by) => {
    if (Math.abs(ax - bx) < 0.5 && Math.abs(ay - by) > THIN) vertical.push({ x: (ax + bx) / 2, y0: Math.min(ay, by), y1: Math.max(ay, by) });
    else if (Math.abs(ay - by) < 0.5 && Math.abs(ax - bx) > THIN) horizontal.push({ y: (ay + by) / 2, x0: Math.min(ax, bx), x1: Math.max(ax, bx) });
  };
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], args = argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (args?.[0]) ctm = mul(ctm, args[0]); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.constructPath) {
      const [paint, [data] = []] = args ?? [];
      if (!data || !(STROKE.has(paint) || FILL.has(paint))) continue;
      const subpaths = [];
      let cur = null;
      for (let k = 0; k < data.length;) {
        const op = data[k++];
        if (op === 0 || op === 1) { // moveTo, lineTo
          const [x, y] = [data[k++], data[k++]];
          const p = [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
          if (op === 0 || !cur) subpaths.push(cur = { pts: [p], curved: false });
          else cur.pts.push(p);
        } else if (op === 2) { k += 6; if (cur) cur.curved = true; } // curveTo
        else if (op === 3) { k += 4; if (cur) cur.curved = true; } // quadraticCurveTo
        else if (op === 4) { if (cur) cur.pts.push(cur.pts[0]); } // closePath
        else break;
      }
      for (const { pts, curved } of subpaths) {
        if (curved || pts.length < 2) continue;
        if (STROKE.has(paint)) for (let k = 1; k < pts.length; k++) rule(...pts[k - 1], ...pts[k]);
        if (FILL.has(paint)) {
          const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
          const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
          if (x1 - x0 <= THIN && y1 - y0 > THIN) rule((x0 + x1) / 2, y0, (x0 + x1) / 2, y1);
          else if (y1 - y0 <= THIN && x1 - x0 > THIN) rule(x0, (y0 + y1) / 2, x1, (y0 + y1) / 2);
        }
      }
    }
  }
  return { vertical, horizontal };
}

export function groupRows(items) {
  const sorted = [...items].sort((p, q) => q.y - p.y || p.x - q.x); // top of the page first
  const rows = [];
  for (const it of sorted) {
    const row = rows.at(-1);
    if (row && Math.abs(row.y - it.y) <= ROW_TOL * Math.max(row.size, it.size)) {
      row.items.push(it);
      row.size = Math.max(row.size, it.size);
    } else rows.push({ y: it.y, size: it.size, items: [it] });
  }
  for (const r of rows) r.items.sort((p, q) => p.x - q.x);
  return rows;
}

function chunks(rowItems, cuts) {
  const out = [];
  for (const it of rowItems) {
    const last = out.at(-1);
    const gap = last ? it.x - last.x1 : Infinity;
    const size = Math.max(it.size, last?.size ?? 0);
    if (last && gap < CELL_GAP * size && !cuts.some((x) => x >= last.x1 - 1 && x <= it.x + 1)) {
      last.text += (gap > SPACE_GAP * size && !/\s$/.test(last.text) && !/^\s/.test(it.str) ? ' ' : '') + it.str;
      last.x1 = Math.max(last.x1, it.x + it.w);
      last.size = size;
    } else out.push({ text: it.str, x0: it.x, x1: it.x + it.w, size: it.size });
  }
  return out;
}

// Vertical rules crossing baseline y -> their sorted x positions, near-duplicates merged.
function ruleXs(y, vertical) {
  const xs = vertical.filter((r) => r.y0 - 1 <= y && y <= r.y1 + 1).map((r) => r.x).sort((a, b) => a - b);
  return xs.filter((x, k) => !k || x - xs[k - 1] >= SAME_X);
}

// Merge chunks' x-extents into the bands list (sorted, non-overlapping).
function addSpans(bandList, chs) {
  const spans = [...bandList, ...chs.map((c) => [c.x0, c.x1])].sort((p, q) => p[0] - q[0]);
  const out = [];
  for (const [a, b] of spans) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}
// A row fits a text-only table block when none of its chunks spans two of the block's bands.
const fits = (bandList, chs) => chs.every((c) => bandList.filter(([a, b]) => c.x0 <= b && c.x1 >= a).length <= 1);

function bandOf(bandList, chunk) {
  const mid = (chunk.x0 + chunk.x1) / 2;
  let k = bandList.findIndex(([a, b]) => mid >= a && mid <= b);
  if (k < 0) k = bandList.findIndex(([a, b]) => chunk.x0 >= a && chunk.x0 <= b);
  if (k < 0) { // between bands (single-chunk rows only): the last band starting left of it
    k = 0;
    bandList.forEach(([a], i) => { if (a <= chunk.x0) k = i; });
  }
  return k;
}

const joined = (chs) => chs.map((c) => c.text.trim()).join(' ');

function proseRows(seg) {
  return seg.rows.map(({ chunks: chs }) => (chs.length === 2 ? chs.map((c) => cellValue(c.text)) : [cellValue(joined(chs))]));
}

function tableRows(seg, wide) {
  return seg.rows.map(({ chunks: chs }) => {
    if (chs.length === 1 && wide(chs[0])) return [cellValue(chs[0].text)];
    const cells = Array(seg.bands.length).fill(null).map(() => []);
    for (const c of chs) cells[bandOf(seg.bands, c)].push(c.text.trim());
    return cells.map((parts) => cellValue(parts.join(' ')));
  });
}

// Rows of a ruled block -> groups of rows that form one sheet row each (lines of the same cells joined).
function ruledGroups(seg, horizontal) {
  const xs = seg.xs;
  const grid = seg.rows.filter((r) => r.xs);
  // Rows a (above) and b are in different cells when a horizontal rule over the block lies between them.
  const hs = horizontal.filter((h) => h.x0 < xs.at(-1) && h.x1 > xs[0]);
  const apart = (a, b) => hs.some((h) => h.y > b.y + 0.5 && h.y < a.y - 0.5);
  let gaps = 0;
  for (let k = 1; k < grid.length; k++) if (apart(grid[k - 1], grid[k])) gaps++;
  const joinLines = grid.length > 1 && gaps * 2 >= grid.length - 1;
  const groups = [];
  for (const r of seg.rows) {
    const last = groups.at(-1);
    if (r.xs && joinLines && last?.xs && !apart(last.rows.at(-1), r)) last.rows.push(r);
    else groups.push({ xs: r.xs, rows: [r] });
  }
  return groups;
}

function ruledRows(seg, groups) {
  const xs = seg.xs;
  const grid = seg.rows.filter((r) => r.xs);
  const col = (c) => xs.filter((x) => x < (c.x0 + c.x1) / 2).length - 1;
  const used = [...new Set(grid.flatMap((r) => r.chunks.map(col)))].sort((a, b) => a - b);
  return groups.map((g) => {
    if (!g.xs) return [cellValue(joined(g.rows[0].chunks))];
    const cells = used.map(() => []);
    for (const r of g.rows) for (const c of r.chunks) cells[used.indexOf(col(c))].push(c.text.trim());
    return cells.map((parts) => cellValue(parts.join(' ')));
  });
}

/** Text items of one page (+ its ruling lines, optional) -> rows x columns of cell values (see the header). */
export function extractTable(items, rules = null) {
  return extractLayout(items, rules).rows;
}

/** extractTable() plus where each sheet row comes from: at[k] = {x, y}, the start of the baseline (PDF points)
 *  of row k's first text, or null for the empty row between blocks; and blocks[j] = {kind ('lines' | 'prose' |
 *  'table' | 'ruled'), start, end (its sheet rows, end exclusive), lines: [{y, single}]}: the baselines of the text
 *  rows it holds, single when the row is one chunk outside a ruled grid (a title, note or paragraph line). */
export function extractLayout(items, rules = null) {
  const vertical = rules?.vertical ?? [], horizontal = rules?.horizontal ?? [];
  const rows = groupRows(items.filter((it) => it.str.trim())).map((r) => {
    const xs = ruleXs(r.y, vertical);
    const grid = xs.length >= 3;
    const chs = chunks(r.items, grid ? xs : []);
    const inside = grid && chs.every((c) => c.x0 >= xs[0] - 1 && c.x1 <= xs.at(-1) + 1 && !xs.some((x) => x > c.x0 + 1 && x < c.x1 - 1));
    return { y: r.y, chunks: chs, xs: inside ? xs : null };
  });
  if (!rows.length) return { rows: [], at: [], blocks: [] };
  const all = rows.flatMap((r) => r.chunks);
  const textW = Math.max(...all.map((c) => c.x1)) - Math.min(...all.map((c) => c.x0));
  const wide = (c) => c.x1 - c.x0 > PROSE * textW;

  const segs = [];
  const open = (seg) => { // lines at the top of the page join the first block
    if (segs.at(-1)?.kind === 'lines') seg.rows.unshift(...segs.pop().rows);
    segs.push(seg);
  };
  for (const row of rows) {
    const cur = segs.at(-1);
    const key = row.xs?.join();
    if (key) {
      if (cur?.key === key) cur.rows.push(row);
      else open({ kind: 'ruled', key, xs: row.xs, rows: [row] });
    } else if (row.chunks.length === 1) {
      if (cur) cur.rows.push(row);
      else segs.push({ kind: 'lines', rows: [row] });
    } else if (row.chunks.some(wide)) {
      if (cur?.kind === 'prose') cur.rows.push(row);
      else open({ kind: 'prose', rows: [row] });
    } else if (cur?.kind === 'table' && fits(cur.bands, row.chunks)) {
      cur.rows.push(row);
      cur.bands = addSpans(cur.bands, row.chunks);
    } else open({ kind: 'table', rows: [row], bands: addSpans([], row.chunks) });
  }

  const out = [], at = [], blocks = [];
  segs.forEach((seg, k) => {
    if (k) { out.push([]); at.push(null); }
    const start = out.length;
    let src = seg.rows;
    if (seg.kind === 'table') out.push(...tableRows(seg, wide));
    else if (seg.kind === 'ruled') {
      const groups = ruledGroups(seg, horizontal);
      out.push(...ruledRows(seg, groups));
      src = groups.map((g) => g.rows[0]);
    } else out.push(...proseRows(seg));
    at.push(...src.map((r) => ({ x: r.chunks[0].x0, y: r.y })));
    blocks.push({ kind: seg.kind, start, end: out.length, lines: seg.rows.map((r) => ({ y: r.y, single: r.chunks.length === 1 && !r.xs })) });
  });
  const width = Math.max(1, ...out.map((r) => r.length));
  return { rows: out.map((r) => [...r, ...Array(width - r.length).fill(null)]), at, blocks };
}

// ---------------------------------------------------------------- images (Export to Excel, "Include images")
// Images float over the sheet (they never move cells): each is anchored at the sheet row after the text rows
// above its top edge and at the column its left edge falls in, with the page width mapped to the used columns
// (at least MIN_COLS) at Excel's default column width; an image that would cover one placed before it moves down.
export const COL_PX = 64; // Excel's default column width, px
export const ROW_PX = 20; // Excel's default row height (15 pt), px
const MIN_IMG = 16;       // px: an image smaller than this either side is left out (rules, dots, spacers)
const MAX_PX = 1000;      // px: an image's longer side in the sheet is capped at this
const MIN_COLS = 8;       // the page width maps to at least this many columns

/** Page view box [x0, y0, x1, y1] + /Rotate -> {m, width, height}: m maps PDF user space to the displayed page in
 *  points, origin top-left, y down (what pdf.js page.getViewport({scale: 1}).transform gives). */
export function pageBox(view, rotate = 0) {
  const r = ((rotate % 360) + 360) % 360;
  const [x0, y0, x1, y1] = view;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const [a, b, c, d] = { 0: [1, 0, 0, -1], 90: [0, 1, 1, 0], 180: [-1, 0, 0, 1], 270: [0, -1, -1, 0] }[r];
  const width = r % 180 ? y1 - y0 : x1 - x0, height = r % 180 ? x1 - x0 : y1 - y0;
  return { m: [a, b, c, d, width / 2 - a * cx - c * cy, height / 2 - b * cx - d * cy], width, height };
}

/** pdf.js operator list + pageBox() -> the page's images [{id | data, width, height, box}]: id of a paintImageXObject
 *  (its pixels are in page.objs, or page.commonObjs for "g_" ids), data of an inline image; width x height in pixels;
 *  box {left, top, right, bottom} where the image's unit square lands on the displayed page (points, y down).
 *  Images under MIN_IMG px either side, and images entirely off the page, are left out. */
export function imagesFromOps({ fnArray, argsArray }, OPS, page) {
  const out = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], args = argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (args?.[0]) ctm = mul(ctm, args[0]); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
      const inline = fn === OPS.paintInlineImageXObject;
      const width = inline ? args?.[0]?.width : args?.[1], height = inline ? args?.[0]?.height : args?.[2];
      if (!(width >= MIN_IMG && height >= MIN_IMG)) continue;
      const m = mul(page.m, ctm);
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => apply(m, x, y));
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const box = { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
      if (box.right <= 0 || box.bottom <= 0 || box.left >= page.width || box.top >= page.height) continue;
      if (box.right - box.left < 1 || box.bottom - box.top < 1) continue;
      out.push({ ...(inline ? { data: args[0] } : { id: args[0] }), width, height, box });
    }
  }
  return out;
}

/** Image boxes (displayed page, points, y down) + rowTops[k] = displayed y of sheet row k's baseline (null for the
 *  empty row between blocks) + the page width + the sheet's used column count -> [{row, col, width, height}]:
 *  row 0-based, col fractional (columns of COL_PX), width/height in px. Same order as boxes. */
export function placeImages(boxes, rowTops, pageWidth, usedCols) {
  const ys = rowTops.map((y, k) => {
    if (y !== null) return y;
    const prev = rowTops.slice(0, k).findLast((v) => v !== null), next = rowTops.slice(k + 1).find((v) => v !== null);
    return prev === undefined ? next : next === undefined ? prev : (prev + next) / 2;
  });
  const scale = (Math.max(usedCols, MIN_COLS) * COL_PX) / pageWidth; // px per point
  const order = boxes.map((_, i) => i).sort((p, q) => boxes[p].top - boxes[q].top || boxes[p].left - boxes[q].left);
  const placed = [], out = [];
  for (const i of order) {
    const b = boxes[i];
    let width = (b.right - b.left) * scale, height = (b.bottom - b.top) * scale;
    const cap = Math.min(1, MAX_PX / Math.max(width, height));
    width *= cap; height *= cap;
    const col = (Math.max(0, b.left) * scale) / COL_PX, x = col * COL_PX;
    let row = ys.filter((y) => y !== undefined && y <= b.top).length;
    for (let moved = true; moved;) {
      moved = false;
      for (const p of placed) {
        const y = row * ROW_PX;
        if (y < p.y1 && y + height > p.y0 && x < p.x1 && x + width > p.x0) { row = Math.ceil(p.y1 / ROW_PX); moved = true; }
      }
    }
    placed.push({ x0: x, x1: x + width, y0: row * ROW_PX, y1: row * ROW_PX + height });
    out[i] = { row, col, width: Math.round(width), height: Math.round(height) };
  }
  return out;
}

/** pdf.js decoded image {width, height, kind, data} -> RGBA bytes. kind 1: 1 bit per pixel, rows padded to a byte,
 *  a set bit is white; 2: RGB; 3: RGBA. */
export function rgbaPixels({ width, height, kind, data }) {
  const n = width * height;
  if (kind === 3) return data.subarray(0, n * 4);
  const out = new Uint8ClampedArray(n * 4);
  const stride = (width + 7) >> 3;
  for (let i = 0; i < n; i++) {
    if (kind === 2) { out[i * 4] = data[i * 3]; out[i * 4 + 1] = data[i * 3 + 1]; out[i * 4 + 2] = data[i * 3 + 2]; } else {
      const x = i % width, y = (i - x) / width;
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = (data[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
    }
    out[i * 4 + 3] = 255;
  }
  return out;
}
