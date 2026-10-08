// Built-in Office -> PDF (File > Create PDF from Office…, engine "ASH (built-in)"): an Office file becomes a
// standalone HTML page here, and main prints it to PDF in a hidden window without JavaScript (office:htmlToPdf).
//   .docx  mammoth (vendored, renderer/vendor/mammoth.mjs): headings, paragraphs, lists, tables; images inline as data: URIs.
//   .xlsx  read-excel-file (vendored, renderer/vendor/read-excel-file.mjs): every sheet becomes a heading plus a table.
// No DOM and no imports: the converter is passed in, so the Node unit tests run the same code.

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** A complete HTML document for printing: A4 (landscape when asked), 15 mm margins, bordered tables. */
export function htmlPage({ title, body, landscape = false }) {
  return '<!doctype html>\n<html><head><meta charset="utf-8">'
    // Nothing but the page itself and data: images (main also blocks every other request).
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'">'
    + `<title>${esc(title)}</title><style>`
    + `@page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: 15mm; }`
    + 'body { font-family: Calibri, Carlito, Arial, sans-serif; font-size: 11pt; line-height: 1.3; color: #000; }'
    + 'table { border-collapse: collapse; margin: 6pt 0; } td, th { border: 1px solid #555; padding: 2pt 4pt; vertical-align: top; }'
    + 'img { max-width: 100%; } h1, h2, h3 { page-break-after: avoid; } tr { page-break-inside: avoid; }'
    + `</style></head><body>${body}</body></html>\n`;
}

/** .docx bytes -> {html, landscape, messages} with `mammoth` (the vendored module's default export). */
export async function docxToHtml(bytes, mammoth, title = 'Document') {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const res = await mammoth.convertToHtml({ arrayBuffer: buf }, { convertImage: mammoth.images.dataUri });
  return { html: htmlPage({ title, body: res.value }), landscape: false, messages: res.messages };
}

const LANDSCAPE_COLUMNS = 8; // a sheet wider than this prints the whole workbook landscape

// One cell -> <td>: numbers right-aligned, dates as ISO dates, everything else escaped text.
function cellHtml(v) {
  if (v === null || v === undefined || v === '') return '<td></td>';
  if (typeof v === 'number') return `<td style="text-align:right">${esc(v)}</td>`;
  if (v instanceof Date) return `<td>${Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10)}</td>`;
  return `<td>${esc(v)}</td>`;
}

/** Sheets [{sheet, data: rows of cells}] (read-excel-file) -> {html, landscape}: a section per sheet, page break between. */
export function sheetsToHtml(sheets, title = 'Workbook') {
  const landscape = sheets.some((s) => s.data.some((r) => r.length > LANDSCAPE_COLUMNS));
  const body = sheets.map((s, i) => `<section${i ? ' style="page-break-before:always"' : ''}><h2>${esc(s.sheet)}</h2>`
    + (s.data.length ? `<table>${s.data.map((r) => `<tr>${r.map(cellHtml).join('')}</tr>`).join('')}</table>` : '<p>(empty sheet)</p>')
    + '</section>').join('');
  return { html: htmlPage({ title, body, landscape }), landscape };
}
