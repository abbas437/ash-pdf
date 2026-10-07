// Table extraction for File > Export to Excel (renderer/ui/exports.js). Pure: no DOM, no pdf.js,
// so test/table-extract.test.js runs it in Node.
//
//   textItems(content)  pdf.js getTextContent() items -> [{str, x, y, w, size}] in PDF points
//                       (x, y = start of the baseline; empty and whitespace-only items dropped)
//   extractTable(items) -> rows of cells: string | number | null (an empty cell)
//
// Rows: items whose baselines are within 0.4 x font size of a row's baseline join that row.
// Cells: within a row, items closer than CELL_GAP x font size merge into one chunk ("Net amount").
// Columns: every chunk's x-extent is projected onto the x axis; overlapping extents merge into
// column bands, so a boundary is a gap that no chunk of any row crosses. Rows with a single chunk
// (titles, notes) are left out of the projection so they cannot fuse the columns, and go to the
// band their left edge falls in. Chunks that land in the same band of a row are joined with a space.
// A cell that is a plain number (thousands separators and decimals allowed) becomes a Number.

const ROW_TOL = 0.4;  // x font size: same baseline
const CELL_GAP = 0.8; // x font size: a gap below this is inside a cell (word spacing is ~0.25-0.35)
const SPACE_GAP = 0.1; // x font size: a gap above this between merged items is a space

export function textItems(content) {
  const out = [];
  for (const it of content?.items ?? []) {
    if (typeof it.str !== 'string' || !it.str.trim() || !it.transform) continue;
    const [a, b, c, d, x, y] = it.transform;
    const size = Math.hypot(c, d) || Math.hypot(a, b) || it.height || 1;
    out.push({ str: it.str, x, y, w: it.width ?? 0, size });
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

function groupRows(items) {
  const sorted = [...items].sort((p, q) => q.y - p.y || p.x - q.x); // top of the page first
  const rows = [];
  for (const it of sorted) {
    const row = rows.at(-1);
    if (row && Math.abs(row.y - it.y) <= ROW_TOL * Math.max(row.size, it.size)) {
      row.items.push(it);
      row.size = Math.max(row.size, it.size);
    } else rows.push({ y: it.y, size: it.size, items: [it] });
  }
  return rows.map((r) => r.items.sort((p, q) => p.x - q.x));
}

function chunks(rowItems) {
  const out = [];
  for (const it of rowItems) {
    const last = out.at(-1);
    const gap = last ? it.x - last.x1 : Infinity;
    const size = Math.max(it.size, last?.size ?? 0);
    if (last && gap < CELL_GAP * size) {
      last.text += (gap > SPACE_GAP * size && !/\s$/.test(last.text) && !/^\s/.test(it.str) ? ' ' : '') + it.str;
      last.x1 = Math.max(last.x1, it.x + it.w);
      last.size = size;
    } else out.push({ text: it.str, x0: it.x, x1: it.x + it.w, size: it.size });
  }
  return out;
}

function bands(rowsOfChunks) {
  const multi = rowsOfChunks.filter((r) => r.length > 1);
  const spans = (multi.length ? multi : rowsOfChunks).flat().map((c) => [c.x0, c.x1]).sort((p, q) => p[0] - q[0]);
  const out = [];
  for (const [a, b] of spans) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

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

/** Text items of one page -> rows x columns of cell values (see the header). */
export function extractTable(items) {
  const rows = groupRows(items.filter((it) => it.str.trim())).map(chunks);
  if (!rows.length) return [];
  const bandList = bands(rows);
  return rows.map((row) => {
    const cells = Array(bandList.length).fill(null).map(() => []);
    for (const c of row) cells[bandOf(bandList, c)].push(c.text.trim());
    return cells.map((parts) => cellValue(parts.join(' ')));
  });
}
