# ASH PDF Studio

A free, open-source (MIT) PDF viewer and editor for Windows, published by
ASH Technical & Project Management Services (ASH PMCS).

## Features

- **Viewer**: fast rendering (Mozilla pdf.js), zoom, search, thumbnails, print.
- **Annotate**: highlights, notes, shapes, free text, stamps.
- **Page tools**: rotate, reorder, delete, insert, extract.
- **Merge / split** documents.
- **Forms**: fill AcroForm fields and save.
- **Export**: save edited PDFs, export pages as images.

## Install or run portable

Each release has two files (x64):

| File | What it does |
| --- | --- |
| `ASH-PDF-Studio-Setup-<version>.exe` | Installer for the current user (no admin rights). Lets you choose the folder, adds Start-menu and desktop shortcuts, and registers the app in the "Open with" list for `.pdf`. It does **not** make itself the default PDF app; choose that yourself in *Settings > Apps > Default apps*. Uninstall from *Settings > Apps*. |
| `ASH-PDF-Studio-Portable-<version>.exe` | No installation. Run it from any folder or USB stick. Settings are stored in an `ASH-PDF-Studio-data` folder next to the .exe; nothing else is left on the PC. |

`SHA256SUMS.txt` lists the checksums: `Get-FileHash .\ASH-PDF-Studio-Setup-0.1.0.exe` in PowerShell must match.

**Unsigned executables.** The .exe files are not code-signed yet (that needs a paid certificate).
Windows SmartScreen will show "Windows protected your PC" on first run: click *More info* > *Run anyway*
only if you downloaded the file from this project's GitHub Releases page and the checksum matches.

**System requirements:** Windows 10 or 11, 64-bit (x64), about 400 MB of disk space.

## Build from source

Requires Node.js 22 and npm.

```sh
npm ci
npm run vendor        # copy pdf.js / pdf-lib / fontkit into renderer/vendor
npm start             # run the app (dev mode: menu bar visible, F12 = devtools)
npm test              # unit tests (node --test test/)
npm run smoke:browser # renderer smoke test in Chromium via playwright-core
npm run licenses      # regenerate THIRD-PARTY-NOTICES.md; fails on a disallowed licence
npm run dist          # Windows installer + portable exe into dist/ (run on Windows)
```

`npm run icon` regenerates `build/icon.png` (needs `sharp`; see `scripts/make-icon.js`).

## How releases are built

`.github/workflows/build.yml` runs on every push to `main`, on tags `v*` and on demand. On
`windows-latest` it runs `npm ci`, the licence check, the tests, `vendor` and `dist`, writes
`SHA256SUMS.txt` and uploads the two .exe files and the checksums as workflow artifacts. For a tag
`vX.Y.Z` it also creates a GitHub Release with those three files (`gh release create --generate-notes`).
To release: set `version` in `package.json`, commit, then `git tag v0.1.0 && git push --tags`.
A second job (`smoke`, Ubuntu) runs `npm ci`, `vendor` and the unit tests.

## Project layout

| Path | Contents |
| --- | --- |
| `electron/main.js` | Main process (window, file access, IPC). ES module. |
| `electron/preload.js` | Exposes `window.api` (CommonJS: sandboxed preloads cannot be ES modules). |
| `renderer/` | The UI: `index.html`, `app.js`, `styles.css`, `shim.js`, generated `vendor/`. |
| `src/core/` | PDF operations library (see `docs/CORE-API.md`). |
| `scripts/` | `vendor.js`, `licenses.js`, `make-icon.js`, `smoke-browser.mjs`. |
| `build/` | Icon and NSIS installer hooks (`installer.nsh`). |

## Renderer contract

### Page and modules

The renderer is served from `app://pdfstudio/renderer/index.html` (a privileged custom scheme, not
`file://`), so it has a normal origin. `index.html` sets a strict Content-Security-Policy (no inline or
remote scripts, no eval) and an import map:

| Specifier | File |
| --- | --- |
| `pdf-lib` | `./vendor/pdf-lib.esm.min.js` |
| `@pdf-lib/fontkit` | `./vendor/fontkit.esm.js` (default export) |
| `pdfjs-dist` | `./vendor/pdf.min.mjs` (pdf.js legacy build) |
| `pdfjs-worker` | `./vendor/pdf.worker.min.mjs` |

`app.js` imports the core library as `../src/core/pdfOps.js`; its bare `pdf-lib` imports resolve
through the same import map. The import map is inline, so its SHA-256 hash is part of the CSP:
if you change the map, update the hash (the browser smoke test fails and prints the new one).

Open documents with pdf.js like this:

```js
import * as pdfjs from 'pdfjs-dist';
pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', location.href).href;
const v = new URL('./vendor/pdfjs/', location.href).href;
const pdf = await pdfjs.getDocument({
  data: bytes, cMapUrl: v + 'cmaps/', cMapPacked: true, standardFontDataUrl: v + 'standard_fonts/',
  wasmUrl: v + 'wasm/', iccUrl: v + 'iccs/', isEvalSupported: false, enableScripting: false,
}).promise;
```

### `window.api`

Provided by `electron/preload.js` in the app and by `renderer/shim.js` in a plain browser (tests).
All methods return Promises except `onOpenFile`. A *file* object is `{ path, name, bytes: Uint8Array }`.

| Member | Result | Notes |
| --- | --- | --- |
| `isElectron` | `true` / `false` | `false` when the browser shim is active. |
| `version()` | `string` | App version. |
| `openFiles({ filters?, multiple? })` | `file[]` (empty if cancelled) | `filters`: `[{ name, extensions: ['pdf'] }]`; default PDF only. |
| `readFile(path)` | `Uint8Array` | Only paths already returned by `openFiles`, `saveFile`, launch or open-file events. |
| `saveFile({ defaultPath?, filters?, bytes })` | `{ path }` or `null` if cancelled | Shows Save As, writes atomically (temp file + rename). Browser: downloads. |
| `writeFile(path, bytes)` | `{ path }` | Save in place; same path rule as `readFile`. |
| `getLaunchFiles()` | `file[]` | PDFs given on the command line / "Open with". Call once at start-up. |
| `onOpenFile(cb)` | unsubscribe function | `cb(file)` for PDFs opened later (double-click while running). |
| `print()` | `{ ok, reason }` | System print dialog for the current page. Browser: `window.print()`. |
| `setTitle(text)` | — | Window title becomes `<text> — ASH PDF Studio`; empty resets it. |
| `showItem(path)` | `boolean` | Reveal a granted file in Explorer. Browser: `false`. |
| `settingsGet(key)` / `settingsSet(key, value)` | value / `true` | Key `/^[A-Za-z0-9_.-]{1,64}$/`, JSON value up to 64 KiB; `undefined` deletes. |

Restrictions the UI must respect: new windows and navigation are blocked (external links cannot be
opened), and every permission request is denied, including `navigator.clipboard` — use
`document.execCommand('copy')` or the native Ctrl+C in text selections.

## Limitations

- Cannot edit the existing text of a page in place (you can add text, annotations and form values).
- No OCR: scanned pages stay images; text search only works on PDFs that contain text.
- No digital-signature validation; signed PDFs open, but signatures are not verified, and saving changes invalidates them.
- Encrypted PDFs: password-protected files can be viewed after entering the password; editing and saving encrypted files is limited.
- PDF JavaScript is not run, and XFA forms are not supported.
- Windows x64 only for now.

## Licence

MIT — see [LICENSE](LICENSE). Bundled third-party components keep their own licences (pdf.js is
Apache-2.0, pdf-lib and fontkit MIT; Electron and Chromium notices ship with the app); the full list is
in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), and [docs/COPYRIGHT-REVIEW.md](docs/COPYRIGHT-REVIEW.md)
records the copyright and trademark review. "PDF" is used only as the name of the ISO 32000 file format;
this project is not affiliated with Adobe.
