# ASH PDF Studio — Core library API

`src/core/` is a headless, pure-ES-module library. It imports only `pdf-lib`
(`@pdf-lib/fontkit` is not needed because no custom fonts are embedded); it uses no Node built-ins, so the same files run in
Node 22 (tests) and in the Electron renderer (bare specifiers mapped by an import map).

* Input PDFs are `Uint8Array` (or `ArrayBuffer`); outputs are new `Uint8Array`s.
  Input bytes are never mutated (the library copies before parsing).
* Every function that parses or saves a PDF is `async`. `parseRanges`, `measureText`,
  `sanitizeText`, `standardFontName` and the geometry helpers are synchronous.
* Entry points: `src/core/index.js` (everything), or the individual modules
  `pdfOps.js`, `annotate.js`, `forms.js`.

## Coordinate conventions

**Visible page space** (used by overlay objects, `listFields().rect`, `cropPages`
margins and `getInfo().pages[i].width/height`):

* unit = 1 PDF point (1/72 in);
* origin at the **top-left of the page as displayed**, x right, y **down**;
* measured **after** the page's `/Rotate` is applied;
* the displayed area is CropBox ∩ MediaBox, so non-zero box origins are handled.

This is exactly what a pdf.js viewport at `scale: 1` gives
(`page.getViewport({scale:1})`); for zoom `z`, divide screen pixels by `z`.

`mediaBox` / `cropBox` in `getInfo` are raw PDF user-space arrays `[x1, y1, x2, y2]`.

## Errors

| `err.code` / class | Raised by | Meaning |
|---|---|---|
| `ENCRYPTED` (Error) | every function that loads a PDF, except `getInfo` | File has an `/Encrypt` dictionary; see below |
| `INVALID_PDF` (Error) | every loader | Bytes could not be parsed as a PDF |
| `DELETE_ALL_PAGES` (Error) | `deletePages` | Request would leave zero pages |
| `FIELD_NOT_FOUND` (Error) | `fillFields` | No field with that name |
| `FIELD_NOT_FILLABLE` (Error) | `fillFields` | Button/signature field given a value |
| `INVALID_IMAGE` (Error) | `flattenObjects` | Image bytes could not be decoded |
| `RangeError` | page indices, ranges, margins, sizes | Value out of range / malformed range string / not a permutation |
| `TypeError` | wrong argument types, unknown overlay `type`, bad colour, unknown font, unsupported image type | |

pdf-lib's own errors (for example selecting a radio option that does not exist) propagate unchanged.

## Encrypted PDFs — what is supported

pdf-lib 1.17.1 has **no decryption support**, and no crypto code was added to this library.

* **Supported:** `getInfo(bytes)` on an encrypted file. The page tree is not encrypted, so
  it returns `pageCount`, per-page sizes/rotation/boxes, `hasForm`, and `isEncrypted: true`;
  `metadata` is `null` (Info strings are encrypted).
* **Not supported:** every other operation (merge, split, rotate, flatten, forms, metadata …)
  throws `Error` with `code === 'ENCRYPTED'` and a user-readable message. This applies to
  all encryption variants (RC4 or AES, user password or owner-password-only restrictions).
  The `password` option is accepted by `getInfo`/`getMetadata` for API stability but cannot
  unlock anything today; the message says so when a password is supplied.
* Viewing an encrypted file is the viewer's job (pdf.js can open it with a password).

## Text and fonts

No font files are embedded. Text uses the standard 14 PDF fonts via pdf-lib
`StandardFonts` (Helvetica, Times-Roman, Courier with bold/italic variants), which use
WinAnsi encoding. Before measuring or drawing, text is normalised deterministically:
CRLF/CR → LF, TAB → one space, and **every character outside WinAnsi becomes `?`**
(e.g. `Δ`, CJK, emoji). `sanitizeText(text)` exposes this mapping.

## Limitations (honest list)

* The library **cannot edit the existing text or content stream of a page**. "Edit text"
  in the UI must be done as a `whiteout` object covering the old text plus a new `text`
  object on top. Covered content is hidden visually but **still present** in the file
  (it is not redaction).
* Overlay objects are burned into page content; they are not PDF annotations and are not
  editable after saving.
* `mergePdfs`, `splitPdf`, `extractPages` and `insertPagesFrom` copy pages only: bookmarks,
  document-level JavaScript, and AcroForm field linkage of the copied pages are not carried
  over (widgets stay visible but are no longer form fields).
* No Unicode/embedded fonts (see above). No encryption/decryption, no signing, no OCR.

---

## pdfOps.js

### `parseRanges(str, pageCount) → number[]`
Parses a 1-based range string such as `"1-3,5,8-"` or `"-4"` into sorted, de-duplicated,
**zero-based** indices. Tokens: `n`, `a-b`, `a-` (to last page), `-b` (from page 1),
separated by commas; whitespace is ignored. Throws `RangeError` for empty strings, empty
tokens, page 0, pages > `pageCount`, reversed ranges (`5-3`) and anything else.

### `getInfo(bytes, {password}?) → Promise<Info>`
```
{ pageCount, isEncrypted, hasForm,
  metadata: {title, author, subject, keywords, creator, producer, creationDate, modificationDate} | null,
  pages: [{ width, height, rotation, mediaBox:[x1,y1,x2,y2], cropBox:[x1,y1,x2,y2] }] }
```
`width/height` are the **visible** size in points (after rotation, CropBox ∩ MediaBox).
`rotation` is normalised to 0/90/180/270 (invalid values read as 0, like pdf.js).
`hasForm` is true when the AcroForm has at least one field.

### `mergePdfs([bytes, ...]) → Promise<Uint8Array>`
Concatenates all pages in order into a new document (Producer/Creator "ASH PDF Studio").

### `splitPdf(bytes, rangeStrings[]) → Promise<[{name:'part-1', bytes}, ...]>`
One output per range string (pages in ascending order). All ranges are validated before
any output is built.

### `extractPages(bytes, indices) → Promise<Uint8Array>`
New PDF with the given zero-based pages **in the order given** (duplicates allowed).

### `deletePages(bytes, indices) → Promise<Uint8Array>`
Removes pages in place (duplicates ignored). Throws `DELETE_ALL_PAGES` if none would remain.

### `rotatePages(bytes, indices, deltaDeg) → Promise<Uint8Array>`
`deltaDeg` must be an integer multiple of 90 (negative allowed); added to the existing
`/Rotate` and normalised to 0..270.

### `reorderPages(bytes, newOrder) → Promise<Uint8Array>`
`newOrder[k]` = old index of the page that ends up at position `k`. Must be a permutation
of `0..n-1` (`RangeError` otherwise). Done in place, so forms and metadata survive.

### `insertBlankPage(bytes, atIndex, {width, height}?) → Promise<Uint8Array>`
`atIndex` in `0..pageCount`. Default size = visible size of the page before the insertion
point (or the first page when `atIndex` is 0); A4 (595.28 × 841.89 pt) for an empty
document. The new page has `/Rotate 0`.

### `insertPagesFrom(destBytes, srcBytes, srcIndices, atIndex) → Promise<Uint8Array>`
Copies `srcIndices` (in the order given) from `srcBytes` and inserts them at `atIndex`.

### `cropPages(bytes, indices, {left, top, right, bottom}) → Promise<Uint8Array>`
Margins (points, ≥ 0) are measured on the page **as displayed**, relative to the current
visible area; the function maps them to the correct PDF edges for the page's rotation and
sets `/CropBox` (MediaBox unchanged). `RangeError` if less than 1 pt would remain.

### `getMetadata(bytes, {password}?) → Promise<Metadata>`
`{title, author, subject, keywords, creator, producer, creationDate, modificationDate}`;
missing entries are `null`, dates are `Date`.

### `setMetadata(bytes, {title, author, subject, keywords, creator, producer}) → Promise<Uint8Array>`
Only keys that are present are written. `keywords` may be an array or a string (split on
commas/semicolons/whitespace). `producer` defaults to `'ASH PDF Studio'`.

Other edit functions keep existing metadata and only update the modification date.

### `imagesToPdf([{bytes, type:'png'|'jpg'}], {pageSize:'fit'|'A4'|'Letter', margin}?) → Promise<Uint8Array>`
One page per image. `fit` (default): page = image pixel size as points + 2 × margin.
`A4`/`Letter`: landscape when the image is wider than tall; the image is scaled **down
only** to fit inside the margins and centred. `margin` defaults to 0.

---

## annotate.js

### `flattenObjects(pdfBytes, objects, opts?) → Promise<Uint8Array>`
Burns overlay objects into page content. Objects are drawn after the page's existing
content (which is isolated with `q … Q`), in **array order** (later = on top). `opts` is
reserved. Throws `TypeError` for an unknown `type` (message names it), `RangeError` for a
bad `page`.

Common fields: `{ id, page /* 0-based */, type, ... }`. All coordinates are visible page
space (above). Colours are `'#rrggbb'` (or `'#rgb'`); `null`/`'none'` means no paint.
`opacity` 0..1 (default 1). `dash`: `'solid'` (default) | `'dotted'` | `'dashed'`; with
`s = max(strokeWidth, 1)` the dash arrays are dotted `[s, 2s]`, dashed `[5s, 3s]`.
`rotation` is degrees, clockwise on screen, about the object's centre.

| type | fields (defaults) |
|---|---|
| `text` | `x,y,w,h,text,fontSize(12),font('Helvetica'│'Times'│'Courier'),bold,italic,color('#000000'),align('left'│'center'│'right'),lineHeight(1.2),opacity` — wrapped to `w`, `\n` honoured, not clipped to `h` |
| `rect`, `ellipse` | `x,y,w,h,stroke('#000000'),strokeWidth(1),fill(none),opacity,dash` (ellipse inscribed in the box) |
| `line`, `arrow` | `x1,y1,x2,y2,stroke('#000000'),strokeWidth(1),dash,opacity,headSize(max(8,4×strokeWidth))` — arrow head is a filled triangle at `(x2,y2)` |
| `polyline` (alias `ink`) | `points:[[x,y],...]` (≥2), `stroke('#000000'),strokeWidth(2),opacity,dash,smooth` — `smooth` uses a Catmull-Rom → Bézier curve through the points; round joins/caps |
| `highlight` | `x,y,w,h,color('#ffff00'),opacity(0.4, capped at 0.5)` — drawn with blend mode Multiply |
| `whiteout` | `x,y,w,h,color('#ffffff')` — opaque fill |
| `image` | `x,y,w,h,bytes,mime('image/png'│'image/jpeg'),opacity,rotation` — stretched to the box; identical `bytes` objects are embedded once |
| `callout` | `x,y,w,h,text,tx,ty,stroke('#ff0000'),fill('#ffffff'),strokeWidth(1),fontSize(10),color(=stroke),padding(4),dash` — boxed text plus a leader line from the nearest box edge point to the tip `(tx,ty)` (no line when the tip is inside the box) |
| `stamp` | `x,y,w,h,text,color('#c00000'),rotation,borderWidth(3),opacity` — single-line Helvetica-Bold text, auto-sized to fit, centred, inside an outline |

There is deliberately no revision-cloud shape; use dotted `rect`/`ellipse` + `text`/`callout`.

### `measureText(text, {font, bold, italic, fontSize, maxWidth, lineHeight}?) → {width, height, lines, lineHeight, ascent, descent, firstBaseline}`
Synchronous; uses the same metrics and wrapping as `flattenObjects`, so the UI can size
boxes identically. `lines` are the sanitised, wrapped lines; `height = lines.length ×
lineHeight` (`lineHeight` returned in points = `fontSize × lineHeight` factor). Line *i*'s
baseline is at `top + firstBaseline + i × lineHeight`. Words wider than `maxWidth` are
broken by character. Omit `maxWidth` for no wrapping.

### `sanitizeText(text) → string`, `standardFontName(font, bold, italic) → string`
Helpers described in *Text and fonts*.

---

## forms.js

### `listFields(bytes) → Promise<Field[]>`
```
{ name, type: 'text'|'checkbox'|'radio'|'dropdown'|'optionlist'|'button'|'signature',
  value, options?, readOnly, multiline?, maxLength?, pageIndex, rect: {x,y,w,h} | null }
```
`value`: text → string (`''` when empty); checkbox → boolean; radio → selected option or
`null`; dropdown → selected string (`''` when none); optionlist → string[]; button and
signature → `null`. `options` for radio/dropdown/optionlist. `multiline`/`maxLength`
(`null` = unlimited) for text. `pageIndex`/`rect` describe the field's **first** widget in
visible page space (`-1`/`null` if the widget is not on any page). Empty array if the PDF
has no AcroForm.

### `fillFields(bytes, {fieldName: value}, {flatten=false, updateAppearances=true}?) → Promise<Uint8Array>`
Values: text → string; checkbox → truthy/falsy; radio → option string (`null`/`''`
clears); dropdown → string; optionlist → string or string[]. Appearances are regenerated
with Helvetica. For text containing non-WinAnsi characters, the stored value (`/V`) keeps
the exact Unicode text, while the generated appearance shows `?` for those characters.
`flatten: true` burns the fields into the page and removes them.

### `flattenForm(bytes) → Promise<Uint8Array>`
Burns all field appearances into the pages and removes the AcroForm. No-op for PDFs without a form.

---

## pagemarks.js

Header & footer (page numbers), watermark, background and Bates numbering. Each mark is written
as its **own content stream** in the page `/Contents` array, wrapped in
`/Artifact <</Type /Pagination /Subtype /Header|/Footer|/Watermark|/Background /ASH_Mark (kind)>> BDC … EMC`,
and its stream dictionary carries `/ASH_Mark /<kind>`. Over-content marks are appended, behind
marks are inserted just before the page content, backgrounds first of all. While a page carries any
mark, its original content is bracketed by two tagged streams (`q` / `Q`) so graphics state cannot
leak either way. Resources use document-unique keys `ASH_<hf|wm|bg|bt><n>_*` (Font, XObject,
ExtGState). Positions are in visible space (after `/Rotate`, CropBox∩MediaBox), so a header is at
the top of the page as displayed. Text uses the standard 14 fonts: any character outside WinAnsi
(e.g. Arabic) is refused with `code: 'UNSUPPORTED_TEXT'` rather than drawn as `?`.

Common options: `pages` (0-based index array or range string `"1-3,5"`, default all),
`subset: 'all'|'even'|'odd'` (by page number), `replace: true` (remove this kind first, i.e. update),
`font: 'Helvetica'|'Times'|'Courier'`, `bold`, `fontSize`, `color: '#rrggbb'`.
Kinds: `'headerFooter'`, `'watermark'`, `'background'`, `'bates'` (`MARK_KINDS`).

### `addHeaderFooter(bytes, opts) → Promise<Uint8Array>`
`{header: {left, center, right}, footer: {left, center, right}, startNumber=1, numberFormat='1'|'i'|'I'|'a'|'A',
fontSize=10, margins: {top=36, bottom=36, left=54, right=54} (pt), date=new Date(), fileName, ...common}`.
Tokens: `<<page>>`, `<<pages>>` (last number of the range), `<<file>>`, `<<date>>` / `<<date:FMT>>`
(`YYYY YY MMM MM M DD D`, e.g. `<<date:DD/MM/YYYY>>`). Numbering counts from the first page of `pages`.
`formatNumber(n, style)`, `formatDate(date, fmt)` and `expandTokens(tpl, {page, pages, date, fileName})` are exported too.

### `addWatermark(bytes, opts) → Promise<Uint8Array>`
`{text | image (PNG/JPEG bytes), fontSize=48, scale (fraction of the page width; overrides fontSize; images default 0.5),
color='#ff0000', opacity=0.3, rotation=45 (deg, anticlockwise), position='center'|'top-left'|'top-center'|…|'bottom-right',
tile=false, tileGap=72, margin=36, layer='over'|'behind', ...common}`.

### `addBackground(bytes, opts) → Promise<Uint8Array>`
`{color | image (PNG/JPEG bytes; fitted with aspect kept, centred), scale=1, opacity=1, pages, subset, replace}`. Always behind content.

### `addBates(bytes, opts) → Promise<{bytes, lastNumber}>`
`{prefix='', suffix='', startNumber=1, digits=6 (zero padding), position='footer-right' ('header'|'footer' + '-left'|'-center'|'-right'),
fontSize=10, margins, ...common}`. Numbers run consecutively over the selected pages.

### `removeMarks(bytes, kind='all') → Promise<Uint8Array>`, `listMarks(bytes) → Promise<[{kind, pages}]>`
`kind` is one kind, an array of kinds or `'all'`. Removal drops exactly the tagged streams and `ASH_*`
resources; once no mark is left the original `/Contents` (single stream, array or none) is restored as it was.

## Geometry helpers (index.js)

`pageGeometry(pdfLibPage)` → `{rotation, media, crop, view, width, height}`;
`pdfToVisible(geometry, X, Y)` → `{x, y}`; `visibleUpMatrix(geometry)` → PDF `cm` matrix
from "visible, y-up" space to user space. Exposed for the UI and for tests.

## Third-party components

| Component | Licence | Use |
|---|---|---|
| pdf-lib 1.17.1 | MIT | PDF parsing/writing (only runtime dependency of `src/core`) |
| Standard 14 font metrics (bundled in pdf-lib) | as distributed with pdf-lib | Text measurement; no font program is embedded |
| pdfjs-dist, @napi-rs/canvas | Apache-2.0, MIT | Tests only (text extraction, rendering) |
