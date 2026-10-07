# Spike: PDFium (WebAssembly) for ASH PDF Studio phase 2

Status: time-boxed technical spike, 2026-10-07. No app code changed. Package tested: `@embedpdf/pdfium@2.15.1`.

**Question.** Can PDFium compiled to WebAssembly (`@embedpdf/pdfium`) give a free MIT Electron app the
phase-2 editing features, and at what cost?

**Short answer.** Yes for 5 of 6 items. True redaction, incremental save, image editing and
load/render work. Line editing works only partly: it works when the font has the new glyphs, and it
fails silently when the font is a subset without them. Cost: about 2.1 MiB gzip (4.7 MiB raw) added
to the installer, about 130 ms to initialise, and an 18 MiB wasm heap. The CSP needs one change.

## How to reproduce

The package is **not** added to `package.json`. `node_modules` in a worktree is a symlink shared with
other checkouts, so install it into a gitignored prefix inside the worktree:

```
mkdir -p .cache/spike-pdfium && npm install --prefix .cache/spike-pdfium @embedpdf/pdfium@2.15.1
for f in scripts/spike/pdfium/0*.mjs; do echo "== $f"; node "$f"; done
```

(Or set `PDFIUM_DIR=<path to the package root>`.) Every script prints `PASS` or `FAIL` lines and exits
non-zero on any `FAIL`. Fixtures are built with pdf-lib in `_lib.mjs` (`makeFixture`) and with
`test/helpers.js` `makeSignedPdf`. Text is checked with pdf.js (`pdfjs-dist` 6.4.299, the version the
app uses).

The fixture page has these items:
- "Invoice number 4711 is overdue" in Helvetica (standard font, not embedded).
- "Total 1234" in Caveat, an **embedded subset** font.
- "Public line" and "SECRET 99-1234" on one baseline, as two text objects.
- An 80x40 blue PNG drawn at 160x80.

## Licence (from the package as installed)

- `LICENSE`: MIT, "Copyright (c) 2024 CloudPDF, Ji Chang". This covers the JS wrapper.
- `LICENSE.pdfium` (196 lines): the PDFium BSD-3-Clause notice ("Copyright 2014 PDFium Authors"),
  followed by the full Apache License 2.0 text. The README says PDFium is "licensed under the Apache
  License, Version 2.0".
- **Missing:** the package has no notices for third-party code compiled into `pdfium.wasm`. The
  binary contains strings from these libraries:
  - libpng (`png_read_image`, `png_zalloc`)
  - zlib
  - OpenJPEG ("openjpeg.h", JPEG2000 messages)
  - FreeType (`FREETYPE_PROPERTIES`)
  - JPEG decoding (FPDFImageObj_LoadJpegFile; the library is probably libjpeg-turbo, but this is unconfirmed)
- All of these are permissive licences (FTL / BSD / zlib / IJG / libpng) and compatible with MIT
  distribution. But THIRD-PARTY-NOTICES would need hand-written entries for them. `scripts/licenses.js`
  only sees the npm package. Before shipping, check this against PDFium's `third_party/` list for the
  build (the `embed-pdf-viewer` repo's `packages/pdfium/docker`).

## Results

| # | Item | Verdict |
|---|------|---------|
| 1 | Load + render | **works** |
| 2 | Text objects | **works** |
| 3 | Line editing | **partly**: fine with standard/full fonts; a subset font without the glyphs gives .notdef / U+0000 |
| 4 | True redaction | **works**: text is cut at character level; images are removed per object |
| 5 | Incremental save | **works**: the original bytes are an exact prefix |
| 6 | Image objects | **works**: move, scale, delete, replace bitmap |

### 1. Load and render: works

The API calls are:
- `init({ wasmBinary })` and `PDFiumExt_Init()`.
- `malloc` plus a `HEAPU8.set` copy, then `FPDF_LoadMemDocument(ptr, len, '')`. The wasm copy must
  outlive the document.
- `FPDF_GetPageCount`, `FPDF_LoadPage`.
- `FPDFBitmap_Create(w, h, 1)`, `FPDFBitmap_FillRect`, `FPDF_RenderPageBitmap(..., FPDF_ANNOT)`.
- `FPDFBitmap_GetBuffer` and `GetStride`. The buffer is BGRA and is swapped to RGBA in JS.

Script: `01-load-render.mjs`.
```
init 275 ms
PASS FPDF_GetPageCount :: count=3
rendered 612x792 RGBA (1938816 bytes)
PASS pixel image centre (380,272) pdfium vs pdf.js :: pdfium=0,0,255 pdfjs=0,0,255 maxdiff=0
PASS pixel blank margin (20,20) pdfium vs pdf.js :: pdfium=255,255,255 pdfjs=255,255,255 maxdiff=0
PASS pixel inside "I" of Invoice (51,87) pdfium vs pdf.js :: pdfium=74,74,74 pdfjs=74,74,74 maxdiff=0
```
Limits:
- The bitmap comes out as BGRA. The render flag `FPDF_REVERSE_BYTE_ORDER` (0x10) should give RGBA
  directly; this was not tested.
- pdf.js stays the better viewer, because it gives a text layer, progressive rendering and is already
  integrated. Using PDFium as the renderer has no benefit for phase 2.

### 2. Text objects: works

The API calls are:
- `FPDFPage_CountObjects` and `FPDFPage_GetObject`. Object types: 1 = text, 3 = image.
- `FPDFPageObj_GetType`, `FPDFPageObj_GetBounds`, `FPDFPageObj_GetMatrix`.
- `FPDFText_LoadPage`, then `FPDFTextObj_GetText(obj, textPage, buf, len)`, which returns UTF-16LE.
- `FPDFTextObj_GetFont`, `FPDFFont_GetBaseFontName`, `FPDFFont_GetIsEmbedded`, `FPDFTextObj_GetFontSize`.
- `FPDFText_GetTextObject(textPage, charIndex)` maps a character to the object that owns it.

Script: `02-text-objects.mjs`.
```
#0 TEXT "Invoice number 4711 is overdue" font=Helvetica embedded=false size=14 matrix=[1,0,0,1,50,700] bounds=[51.3,699.8,248.6,710.1]
#1 TEXT "Total 1234" font=Caveat-Regular-8450 embedded=true size=20 matrix=[1,0,0,1,50,650] bounds=[53.4,649.1,127.4,663.3]
#2 TEXT "Public line " font=Helvetica embedded=false size=12 matrix=[1,0,0,1,50,600] bounds=[51,599.8,104.2,608.6]
#3 TEXT "SECRET 99-1234" font=Helvetica embedded=false size=12 matrix=[1,0,0,1,200,600] bounds=[200.6,599.8,295.6,608.8]
#4 type=3 bounds=[300,480,460,560]
PASS find object containing "4711" :: objects #0
text page chars=70; char 0 belongs to object #0
```
Limits:
- A "line" is whatever the producer wrote as one `BT…Tj…ET` object. pdf-lib writes one object per
  `drawText`. Other producers often split runs per word or per glyph (TJ kerning), so a UI "line"
  will need grouping by baseline.
- Font size is the `Tf` size. The effective size is that value multiplied by the matrix scale.
- Text inside form XObjects needs `FPDFFormObj_*` recursion. This was not exercised.

### 3. Line editing: partly works

Three edits were tried. All three end with `FPDFPage_GenerateContent(page)`, a save, and a re-open
with pdf.js.
- (a) `FPDFText_SetText(obj, utf16)` on the Helvetica object.
- (b) The same call on the object that uses the embedded subset font.
- (c) Remove and re-add. The steps:
  1. `FPDFPageObj_NewTextObj(doc, 'Helvetica', size)`.
  2. `FPDFText_SetText` on the new object.
  3. `FPDFPageObj_SetMatrix` with the old object's matrix.
  4. `FPDFPage_InsertObject` for the new object.
  5. `FPDFPage_RemoveObject` and `FPDFPageObj_Destroy` for the old one.

Script: `03-edit-line.mjs`.
```
pdfium sees: "Invoice number 4712 is paid" (Helvetica) | "Total  a" (Caveat-Regular-8450) | "SECRET 99-1234" (Helvetica) | "Replaced line " (Helvetica)
pdf.js extracts: "Invoice number 4712 is paid  Total \u0000\u0000\u0000\u0000 \u0000\u0000\u0000\u0000a  SECRET 99-1234 Replaced line"
PASS (a) new text extracted, old gone
PASS (c) re-added text extracted, old gone
PASS (c) same position :: matrix=[1,0,0,1,50,600]
(b) subset font: pdf.js extracts "Total \u0000\u0000\u0000\u0000 \u0000\u0000\u0000\u0000a"
(b) dark pixels rendered: "Total" span=116 ; rest-of-line span=808
```
Limits:
- **Subset fonts fail silently.** `FPDFText_SetText` returns `true` even when the subset lacks the
  new glyphs ("9876 Zebra"). The characters are written as glyph 0. PDFium itself reads them back as
  dropped characters; pdf.js extracts them as U+0000 and renders them as .notdef boxes. Most real-world
  PDFs embed subsets, so phase 2 must check glyph coverage before editing, and fall back to one of:
  - the standard-14 font closest to the original (as in (c), which changes the look), or
  - a full embedded font via `FPDFText_LoadFont(doc, ttfBytes, len, FPDF_FONT_TRUETYPE, cid)`.
    This is in the build but was not exercised here.
- No reflow. The new text keeps its origin. A longer string runs past the old width, and nothing
  else on the line moves.
- `FPDFPage_GenerateContent` rewrites the whole page content stream from PDFium's object model.
  Rendering and extraction were correct here. Fidelity on complex pages (marked content, tagged
  structure, unusual operators) is unverified.

### 4. True redaction: works

The API calls are:
- `EPDFText_RedactInRect(page, FS_RECTF*{left, top, right, bottom}, recurseForms=true, drawBlackBoxes=false)`.
  This is an EmbedPDF extension, not upstream PDFium. It also has a quad variant, `EPDFText_RedactInQuads`,
  and an annotation-driven one, `EPDFPage_ApplyRedactions` / `EPDFAnnot_ApplyRedaction`.
- Images have no sub-object API. Any image object whose `FPDFPageObj_GetBounds` intersects the rect
  is removed with `FPDFPage_RemoveObject` and `FPDFPageObj_Destroy`.
- The black box is `FPDFPageObj_CreateNewRect`, `FPDFPageObj_SetFillColor(0,0,0,255)`,
  `FPDFPath_SetDrawMode(1, false)` and `FPDFPage_InsertObject`.
- Then `FPDFPage_GenerateContent` and a **full** save (flags 0).

The rect covers only the "99-1234" half of the "SECRET 99-1234" object and half of the image.

Script: `04-redact.mjs`.
```
objects before: "Invoice number 4711 is overdue", "Total 1234", "Public line ", "SECRET 99-1234", t3
objects after : "Invoice number 4711 is overdue", "Total 1234", "Public line ", "SECRET", t2; images removed=1
pdf.js extracts: "Invoice number 4711 is overdue  Total 1234  Public line   SECRET"
PASS redacted chars not extractable
PASS chars of the same object outside rect kept (char-level, not object-level)
PASS text outside rect kept
PASS content stream has no 99-1234 glyph run :: stream 517 bytes
PASS raw file has no "99-1234"
```
Limits:
- Images are removed whole, even when the rect overlaps only part of them. A pixel-level version
  would read the image (`FPDFImageObj_GetBitmap`), black out the region and write it back with
  `FPDFImageObj_SetBitmap` (the round trip proven in item 6). This was not built.
- Vector paths under the rect are not removed. Annotations, form fields and metadata are separate
  passes; `EPDFPage_ApplyRedactions` covers Redact annotations.
- The save **must be full, not incremental**. An incremental save keeps the old content stream in
  the unchanged prefix, so the redacted text would still be recoverable. Redacting a signed document
  therefore always invalidates its signatures; this is unavoidable.

### 5. Incremental save: works

The API calls are:
- `FPDF_SaveAsCopy(doc, writer, FPDF_INCREMENTAL=1)`.
- The writer is the wrapper's in-memory `FPDF_FILEWRITE`: `PDFiumExt_OpenFileWriter`, then
  `PDFiumExt_GetFileWriterSize` and `PDFiumExt_GetFileWriterData`, then `PDFiumExt_CloseFileWriter`.
  The wrapper's own `PDFiumExt_SaveAsCopy(doc, writer)` takes no flags.

Script: `05-incremental-save.mjs`. The input is `makeSignedPdf()`.
```
FPDF_GetSignatureCount=1
PASS incremental save, no change: original is exact prefix :: orig=2416 out=2965
PASS incremental save after edit: original is exact prefix :: orig=2416 out=5226 appended=2810
appended section has xref/trailer: true /Prev: true
PASS non-incremental save is NOT a prefix (control) :: out=2623
PASS re-open incremental output with PDFium
```
Limits:
- Even with no change, the save appends 549 bytes: a new xref and trailer. Phase 2 should skip the
  save when nothing changed.
- Whether a real PKCS#7 signature still *validates* in Acrobat after an appended edit depends on the
  DocMDP/FieldMDP permissions, not on bytes. The fixture has no real cryptography.

### 6. Image objects: works

The API calls are:
- Move or scale: `FPDFPageObj_Transform(obj, a, b, c, d, e, f)`, which post-multiplies the object
  matrix.
- Replace: `FPDFBitmap_Create` and `FillRect`, then `FPDFImageObj_SetBitmap(0, 0, obj, bmp)`.
  `EPDFImageObj_SetPng` and `FPDFImageObj_LoadJpegFileInline` also exist; they were not exercised.
- Delete: `FPDFPage_RemoveObject` and `FPDFPageObj_Destroy`.
- Then `FPDFPage_GenerateContent` and a save. Results were verified by rendering with pdf.js.

Script: `06-image-objects.mjs`.
```
image matrix before=[160,0,0,80,300,480]
image matrix after=[80,0,0,40,50,440] bounds=[50,440,130,480]
PASS moved+scaled: blue at new centre (90,460)
PASS moved+scaled: old centre (380,520) now white
PASS FPDFImageObj_SetBitmap
PASS bitmap replaced: red at image centre :: px=255,0,0
PASS FPDFPage_RemoveObject image
PASS deleted: image centre white
```
Limits:
- `SetBitmap` stores the image re-encoded (Flate) at the bitmap's resolution. The original's
  compression (for example DCT/JPEG) and any SMask are not preserved.
- Images inside form XObjects need recursion. This was not exercised.

## Cost

Script: `07-measure.mjs` (Node 22, Linux).
```
size pdfium.wasm: 4538 KiB raw, 2098 KiB gzip-9
size index.browser.js: 286 KiB raw, 61 KiB gzip-9
init (compile+instantiate+PDFiumExt_Init): 132 ms; wasm heap 18176 KiB; rss +16256 KiB
50-page PDF (14 KiB): open 8.4 ms, pages=50
render 50 pages @1.5x: 879 ms total, 17.6 ms/page (incl. BGRA->RGBA copy in JS); wasm heap peak 18176 KiB; rss +193004 KiB
API: 568 cwrapped C functions, all synchronous; only init() is async; single-threaded (no pthreads/SharedArrayBuffer: none found)
```
- **Installer size:** about +4.7 MiB uncompressed inside the asar (4538 + 286 KiB), and about
  2.1 MiB compressed (measured with gzip-9; the installer's LZMA was not measured). Per-file sizes are above.
- **Init time:** 130 to 275 ms per instance (first run vs warm). Initialise once per worker and keep
  the instance.
- **Memory:** the wasm heap starts at 18 MiB and did not grow while rendering 50 pages one at a
  time. Wasm memory never shrinks, so a large scanned PDF will raise the heap permanently, until the
  worker is terminated. The RSS figure includes pdf-lib fixture generation and 50 JS RGBA arrays, so
  it is not a PDFium figure. The 50-page fixture is text-light, so these timings are a lower bound.
- **API ergonomics:** low-level C through `cwrap`. You work with pointers and do manual `malloc`/`free`,
  UTF-16 out-buffers and float out-params. `_lib.mjs` shows the roughly 10 helpers needed. Every call
  is synchronous and blocks the thread it runs on, so it must not run on the renderer's UI thread or
  in the main process's event loop. The build is single-threaded and needs no cross-origin isolation.

## Worker under the app's CSP

`renderer/index.html` currently has:
```
script-src 'self' 'sha256-…'; worker-src 'self' blob:; connect-src 'self' blob: data:
```
It has **no `'wasm-unsafe-eval'`**. Chromium blocks `WebAssembly.compile` / `instantiate` in a
document whose policy lacks it.
- Dedicated workers get their policy from their own script response, not from the page's `<meta>`.
  `serveAppFile` in `electron/main.js` sends no CSP header, so a worker on `app://` is today
  effectively unrestricted. pdf.js's worker wasm (JPEG2000/JBIG2/QCMS) depends on that, or on pdf.js's
  JS fallbacks. **This was not verified in Electron during the spike.** It is the first thing to test
  in phase 2.
- Recommended changes, explicit rather than relying on the gap:
  - Add `'wasm-unsafe-eval'` to `script-src` in `renderer/index.html`.
  - Have `serveAppFile` send `Content-Security-Policy: script-src 'self' 'wasm-unsafe-eval'` with
    worker scripts, so the worker's policy is stated rather than absent.
  - `'unsafe-eval'` is **not** needed: the browser build has no `eval` / `new Function`, and
    `addFunction` compiles tiny wasm modules, which is also covered by `'wasm-unsafe-eval'`.
- Loading:
  - `vendor.js` would copy `dist/index.browser.js` and `dist/pdfium.wasm` into `renderer/vendor/pdfium/`.
  - The worker is a module worker from `'self'`: `new Worker(url, { type: 'module' })`.
  - It loads the wasm by `fetch` (allowed by `connect-src 'self'`) and passes it to `init({ wasmBinary })`,
    or relies on the build's `new URL('pdfium.wasm', import.meta.url)`.
  - The package's `DEFAULT_PDFIUM_WASM_URL` points at jsDelivr. It must never be used, because the
    app is offline.
  - `@embedpdf/engines` builds its worker from a `blob:` URL. The app should not copy that; a
    `'self'` module worker is cleaner.

## Recommendation for phase 2

**Where it runs:** a dedicated **renderer module Web Worker** that owns one PDFium instance. It talks
to the UI by messages: `open(bytes)`, `listTextObjects(page)`, `editText`, `redact(rects)`,
`image ops`, `save({ incremental })`, with transferable `ArrayBuffer`s.
- Keep pdf.js for viewing.
- Use PDFium as an edit-time engine: load the current bytes, apply the operation(s), save, then hand
  the new bytes back to the existing pdf.js/pdf-lib pipeline. This avoids keeping two engines' object
  models in sync.
- Not in the main process: synchronous calls would block IPC and window handling. An Electron
  `utilityProcess` is a viable fallback if the worker CSP route fails. Node works unchanged, as all
  these scripts show.

**Order and estimated effort (one developer):**
1. Infrastructure, about 3 days: vendoring, the worker and message protocol, the CSP change, the
   THIRD-PARTY-NOTICES entries (including the libraries bundled in the wasm), and Node tests modelled
   on these scripts.
2. True redaction, about 4 days: text at character level, image removal, black box, a forced full
   save, and a warning that signatures will be invalidated. This is the highest value, and pdf-lib
   cannot do it.
3. Incremental save for signed PDFs, about 2 days: route edits on signed documents through
   `FPDF_INCREMENTAL` and skip the save when nothing changed.
4. Image move, scale, delete and replace, about 3 days including UI.
5. Line editing, last, about 1.5 to 2 weeks:
   - grouping text objects into lines by baseline;
   - a glyph-coverage check for embedded subsets;
   - a fallback to a full embedded font via `FPDFText_LoadFont` or a standard-14 font, with a visible
     "font substituted" notice;
   - no reflow in the first version.

**Open risks to check early:**
- Worker wasm under the real Electron CSP.
- `FPDFPage_GenerateContent` fidelity on complex real-world pages (tagged PDF, marked content,
  Type 3 fonts).
- Signature validation of incrementally saved, really-signed PDFs in Acrobat.
