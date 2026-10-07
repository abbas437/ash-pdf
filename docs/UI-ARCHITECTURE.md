# ASH PDF Studio - renderer architecture

For contributors working in `renderer/`. The core PDF library (`src/core/`, see
[CORE-API.md](CORE-API.md)) is UI-free; the renderer is plain ES modules (no framework), built on
pdf.js for display and the core library (pdf-lib) for every change to the file.
Everything below was checked against the code; if code and this file disagree, fix this file.

## 1. Overview and file map

One synchronous event bus and one observable state object connect independent modules. Modules
never import each other's internals; they register with `toolbar.js` / `sidebar.js` /
`app.js` and talk through `bus`. `window.ashStudio` (the `app` object) is the public handle.

| File | Role |
| --- | --- |
| `renderer/index.html`, `styles.css` | Shell markup and all CSS (overlay rotation rules live here). |
| `renderer/shim.js` | Browser fallback for `window.api` (used by Playwright and `smoke:browser`); no-op in Electron. |
| `renderer/bus.js` | Tiny synchronous event bus (`on`, `once`, `off`, `emit`). |
| `renderer/state.js` | Observable `state`, `createTab`, `activeTab`, `getTab`, `markDirty`. |
| `renderer/app.js` | Shell, menus (`registerMenuItem`), tabs, `saveTab`, shortcuts, pointer dispatch to tools, `window.ashStudio`. |
| `renderer/ui/viewer.js` | pdf.js continuous-scroll viewer, zoom, view rotation, coordinate conversion. |
| `renderer/ui/toolbar.js` | Toolbar, tool registry (`registerTool`, `setTool`), options bar. |
| `renderer/ui/sidebar.js` | Sidebar tabs (`registerSidebarTab`), Thumbnails (`thumbs` API), Outline. |
| `renderer/ui/search.js` | Find bar and search results (`search` API). |
| `renderer/ui/advsearch.js`, `advsearch-engine.js` | Advanced search panel (Edit > Advanced Search, Ctrl+Shift+F): current/open/folder scope, MiniSearch index, CSV export; the engine is DOM-free (unit-tested in Node). |
| `renderer/ui/annotations.js` | Annotation store, undo/redo, SVG rendering, select/move/resize, beforeSave flatten hook. |
| `renderer/ui/tools-shapes.js` | Select, Shapes, Draw, Highlight, Whiteout tools (use the annotations API). |
| `renderer/ui/forms.js` | AcroForm HTML control layer, forms bar, Forms tool, beforeSave fill hook. |
| `renderer/ui/pagetools.js` | Page operations: queue, undo stack, thumbnail context menu, merge/split/crop/properties dialogs. |
| `renderer/ui/dialogs.js` | `showDialog`, `showError`, `toast`, `askPassword`, `confirmDiscard`, `dialogOpen`. |
| `renderer/ui/dom.js`, `icons.js` | `h()` element builder, `isTyping`, helpers; icon SVG strings. |

Start-up order in `app.js`: shell built, `viewer.mount`, `initSidebar`, `initSearch`, menus, then
`initForms`, `initAnnotations`/`initShapeTools`, `initPageTools(app)`. The order matters for the
save hooks (section 6).

## 2. State and tabs

`state` (`state.js`) is a Proxy over a plain object. Assigning a top-level key emits
`state:changed` `{key, value, previous}` when the value changed. Nested objects (`tabs[]`,
`toolStyle`) are NOT proxied: mutate them and emit your own event.

| Key | Meaning |
| --- | --- |
| `tabs` | `Tab[]` in strip order. Replace the array (`state.tabs = [...]`) to notify. |
| `activeId` | id of the active tab or `null`; use `activeTab()` / `getTab(id)`. |
| `tool` | active tool id (change via `setTool`, not by assignment). |
| `toolStyle` | `{color, strokeWidth, dash, fontSize, opacity}` plus keys added by tools (`fill`, `hlColor`, `hlOpacity`). After mutating, `bus.emit('state:changed', {key: 'toolStyle', value: state.toolStyle})`. |
| `sidebarTab`, `sidebarOpen`, `theme` | sidebar panel id, visibility, `'light'` or `'dark'`. |
| `hooks.beforeSave` | ordered array of save hooks (section 6). |

A tab is created by `createTab({name, path, bytes, password})`:

| Field | Meaning |
| --- | --- |
| `id`, `name`, `path` | `tab-N`; display name; real path (Electron) or pseudo path (shim) or `null`. |
| `bytes` | `Uint8Array`, the CURRENT PDF bytes. This is what Save writes (after hooks). Page ops and form flatten replace it. |
| `password`, `encrypted`, `readOnly` | `readOnly` is `true` for encrypted PDFs (set in `viewer.openDocument`); all editing UI must respect it. |
| `dirty` | Unsaved changes. Set only through `markDirty(tab, flag)`, which emits `tab:dirtyChanged`. |
| `pdfDoc`, `pages[]`, `numPages` | pdf.js document, page proxies, count. Replaced on every reload. |
| `currentPage` (0-based), `zoomMode`, `zoom`, `viewRotation`, `scrollState` | View state; `viewRotation` is visual only. |
| `textCache` | `Map` pageIndex to pdf.js text content. |
| `view` | Set by `viewer.build`: `{scrollEl, pagesEl, pageEls, ps, ...}`; `null` after destroy. |
| `data` | Free slot for modules. |

Fields added lazily by modules (not in `createTab`):

| Field | Added by | Meaning |
| --- | --- | --- |
| `objects[]`, `undo[]`, `redo[]` | `annotations.js` (`ensureTab`) | Overlay objects in page-space points; annotation undo/redo commands (max 200). Lost when the tab closes; flattened only on save. |
| `forms` | `forms.js` (`loadFields`) | `{fields, widgets, values, barDismissed, ...}`; `values` holds only values changed since load/save. `null` after flatten. |
| `bytesUndo[]`, `bytesRedo[]` | `pagetools.js` | Page-operation undo stacks of `{bytes, map}`, capped at 20 each. |

Two independent undo systems exist: annotation history (`tab.undo`, objects only) and page-operation
history (`tab.bytesUndo`, whole-file snapshots). They do not know about each other; the
`pages:remapped` event keeps annotation objects attached to the right pages.

## 3. Event bus

`bus.on(event, fn)` returns an unsubscribe function; `once`, `off(event, fn)`, `emit(event, payload)`.
Delivery is synchronous in registration order. A throwing listener is logged with `console.warn`
(`[bus] ...`) and does not stop the others; async listeners that reject are logged the same way.
Note: the header comment of `bus.js` lists only some events; this table is the full list.

| Event | Payload | Emitted by | Consumed by |
| --- | --- | --- | --- |
| `state:changed` | `{key, value, previous?}` (`previous` absent for the manual `toolStyle` emit) | `state.js`; `toolbar.js`, `tools-shapes.js` (toolStyle) | `sidebar.js` (sidebarTab), `annotations.js` (toolStyle), `app.js` (sidebarOpen) |
| `tab:opened` | `{tab}` | `app.js` openBytes | `annotations.js`, `sidebar.js`, `app.js` |
| `tab:loaded` | `{tab, reloaded}` - pdf.js doc loaded and view (re)built; `reloaded` true on reload after a bytes change | `viewer.js` | `annotations.js`, `forms.js`, `search.js`, `sidebar.js`, `app.js` |
| `tab:activated` | `{tab}` (`tab` is `null` when the last tab closed) | `app.js` | `annotations.js`, `forms.js`, `search.js`, `sidebar.js`, `app.js` |
| `tab:closed` | `{tab}` | `app.js` | `forms.js`, `sidebar.js`, `app.js` |
| `tab:dirtyChanged` | `{tab, dirty}` | `state.js` markDirty | `app.js` |
| `tab:bytesChanged` | `{tab}` - `tab.bytes` was replaced, reload the document | `pagetools.js`, `forms.js` (flatten) | `viewer.js` (reloads), `sidebar.js` |
| `pages:remapped` | `{tab, map}` - `Map<oldIndex, newIndex or null>`; emitted BEFORE `tab:bytesChanged` | `pagetools.js` | `annotations.js` |
| `page:rendered` | `{tab, pageIndex, container, viewport, scale}` - canvas/text layer ready; may fire again after zoom | `viewer.js` | `annotations.js`, `forms.js`, `search.js` |
| `page:changed` | `{tab, pageIndex}` current page changed | `viewer.js` | `sidebar.js`, `app.js` |
| `zoom:changed` | `{tab, zoom, mode, scale}` (`scale` = CSS px per point) | `viewer.js` | `annotations.js`, `app.js` |
| `rotation:changed` | `{tab, rotation}` view rotation (visual only) | `viewer.js` | `forms.js` |
| `tool:changed` | `{tool, previous}` | `toolbar.js` setTool | `tools-shapes.js`, `forms.js`, `app.js` |
| `search:open` | `{}` focus the find bar | `app.js` | `search.js` |
| `search:changed` | `{tab, query, options, hits, current}` | `search.js` | `search.js` |
| `theme:changed` | `{theme}` | `app.js` | none in this tree |
| `annotations:changed` | `{tab}` objects added/changed/removed/undone | `annotations.js` | none in this tree |
| `annotations:selection` | `{tab, ids}` | `annotations.js` | none in this tree |
| `layers:changed` | `{tab}` layer (optional content) visibility changed in `tab.ocConfig` | `viewextras.js` | `sidebar.js` (re-render thumbnails in place) |
| `thumbs:rebuilt` | `{tab, count}` thumbnail list rebuilt (after any reload) | `sidebar.js` | `pagetools.js` (re-wire list, apply pending selection) |
| `thumbs:selectionChanged` | `{tab, selection}` | `sidebar.js` | none via bus (use `thumbs.onSelect`) |

## 4. Viewer API and coordinate conventions

### Coordinates

* **Page space** (what you store): PDF points, origin top-left of the page AS DISPLAYED with its
  `/Rotate` already applied, y down. This is the core library's "visible page space". It is not
  affected by zoom or by view rotation, so stored objects never need re-projecting.
* **CSS scale**: `viewer.scale(tab)` = `tab.zoom * 96/72` CSS px per point (`viewer.PDF_TO_CSS`).
  The viewer sets `--scale-factor` (and `--total-scale-factor`) on each `div.page`, so HTML layers
  can size themselves with `calc(var(--scale-factor) * Npx)` and need no re-render on zoom.
  `forms.js` does this.
* **Overlay SVG**: each page has `div.page-overlay > svg.overlay-svg`. Its `viewBox` is page space.
  The view rotation (`tab.viewRotation`, buttons View > Rotate view) is applied with CSS
  (`.overlay-svg[data-view-rotation="90"] { transform: rotate(90deg) translateY(-100%) }`, and
  likewise 180/270 and `.form-layer` in `styles.css`), not by changing the viewBox. Anything you add
  to an overlay therefore rotates with the page for free; anything you place elsewhere must do the
  same or convert with `pageToClient`.
* **Pointer input**: never compute page points from `getBoundingClientRect` yourself; use
  `viewer.clientToPage` (it undoes zoom, view rotation and `/Rotate`). `app.js` calls it for every
  pointer event and passes the result to the active tool as `ctx.hit`.

### `viewer` (also `window.ashStudio.viewer`)

Page indices are 0-based throughout.

| Member | Notes |
| --- | --- |
| `clientToPage(tab, clientX, clientY)` | returns `{pageIndex, x, y, inside}` (nearest page if outside any); `null` if no view. |
| `pageToClient(tab, i, x, y)` | returns `{clientX, clientY}`. |
| `pageSize(tab, i)` | `{width, height}` in points, visible (after `/Rotate`). |
| `getViewport(tab, i, scale?)` | pdf.js viewport including view rotation. |
| `scale(tab)` | CSS px per point. |
| `getPageEl(tab, i)`, `getOverlayEl(tab, i)`, `getOverlaySvg(tab, i)`, `getScrollEl(tab)`, `getPageState(tab, i)`, `renderedPages(tab)` | DOM access. |
| `setZoom(tab, n or 'fit-width' or 'fit-page', anchor?)`, `zoomIn`, `zoomOut` | zoom limits 0.1 to 8; emits `zoom:changed`. |
| `rotateView(tab, +-90)` | visual only; emits `rotation:changed` and `zoom:changed`. |
| `scrollToPage(tab, i)`, `nextPage`, `prevPage`, `goToDest(...)` | navigation; emits `page:changed`. |
| `getTextContent(tab, i)` | cached pdf.js text content. |
| `reload(tab)` | re-open `tab.bytes` (called automatically on `tab:bytesChanged`). |
| `rerender(tab)` | drop and redraw all page canvases. |
| `optionalContent(tab)` | render params for the current layer visibility (`{optionalContentConfigPromise}` from `tab.ocConfig`, display intent, or `{}`); spread into every `page.render` that shows the page as on screen. `tab.ocConfig` is loaded with the document and keeps its visibility across reloads. |
| `pdfjs` | the pdf.js module (e2e tests use `v.pdfjs.getDocument`). |

Pages are laid out at their final size immediately; canvases and layers are rendered lazily and
released for far pages. Always render per-page UI from `page:rendered` (and on `tab:loaded` for
already-rendered pages), never assume a page element is populated.

## 5. Registering things

Everything is reachable from `window.ashStudio` for plugins and tests: `state, bus, viewer,
registerSidebarTab, showSidebarTab, thumbs, search, openBytes, openDialog, activate, closeTab,
saveTab, printTab, showProperties, registerMenuItem, registerTool, setTool, showDialog, toast,
markDirty, setTheme`, plus `annotations` and `pageTools` (added after init).

### Tools - `registerTool(def)` (`toolbar.js`)

`def = {id, label, icon, shortcut, cursor, onActivate(tab), onDeactivate(tab), onPointerDown/Move/Up(e, ctx), options}`.
It enables the placeholder button with the same `data-tool` or appends a new one. Placeholders
without a registration (text, image, stamp, callout, pages) stay disabled with "added in next
build". `ctx = {tab, hit: viewer.clientToPage(...), viewer}`; handlers fire only for events whose
target is inside a `.page`. `options` is a list of standard controls (`'color'`, `'strokeWidth'`,
`'dash'`, `'fontSize'`, bound to `state.toolStyle`) and/or factories `(container, state) => void`.

```js
// tools-shapes.js
registerTool({ id: 'select', label: 'Select', icon: 'select', shortcut: 'V', cursor: 'auto', ...selectHandlers, options: ['color', 'strokeWidth', 'dash', fillCtl, opacityCtl, onlyWithSelection] });
const mk = (id, label, icon, shortcut, options) => {
  const c = creator(id);
  registerTool({ id, label, icon, shortcut, cursor: 'crosshair', options, onPointerDown: c.onPointerDown, onPointerMove: c.onPointerMove, onPointerUp: c.onPointerUp, onDeactivate: () => c.cancel(activeTab()) });
};
mk('draw', 'Draw (freehand)', 'draw', 'P', ['dash', 'color', 'strokeWidth', opacityCtl]);
```

### Annotation object types - `annotations.registerObjectType(type, def)` (`annotations.js`)

`def = {render(obj, svgParent) -> SVGElement, bbox(obj) -> {x,y,w,h}, handles(obj) -> [{id,x,y}], hit?(obj,x,y,tol), move(obj,dx,dy) -> patch, resize(obj,handleId,dx,dy) -> patch, style?(obj, toolStyle, changedKeys) -> patch}`.
`move`/`resize` get the object as it was when the drag started plus the TOTAL delta and must
return a patch, never mutate. The module's `boxType(render, extra)` helper builds all of this for
x/y/w/h objects (it is internal; copy its shape for your own type).

```js
// annotations.js (registerBuiltins)
registerObjectType('rect', boxType((o, p) => svgEl('rect', { x: o.x, y: o.y, width: o.w, height: o.h, fill: paint(o.fill), ...strokeAttrs(o) }, p), { style: shapeStyle }));
```

The object's `type` must also be understood by the core `flattenObjects` (`docs/CORE-API.md`),
otherwise it is shown on screen but missing from the saved file.

### Sidebar tabs - `registerSidebarTab({id, label, icon, render(container, tab)})` (`sidebar.js`)

`render` runs when the panel becomes visible, when the active tab changes, and on
`tab:loaded {reloaded: true}` while visible; `tab` may be `null`. Redraw yourself with
`refreshSidebarTab(id)`. Switch with `showSidebarTab(id)`.

```js
// sidebar.js (initSidebar)
registerSidebarTab({ id: 'thumbs', label: 'Thumbnails', icon: 'thumbs', render: renderThumbs });
registerSidebarTab({ id: 'outline', label: 'Outline', icon: 'outline', render: renderOutline });
```

The `thumbs` object (also `ashStudio.thumbs`): `getEl(i)`, `selection` (Set), `setSelection(indices)`,
`onSelect(cb)`, `onContext(cb)` (cb gets `(event, {tab, pageIndex, selection})`), `refresh()`, `listEl`.
All return an unsubscribe function where they take a callback.

### Menu items - `registerMenuItem(menu, item)` (`app.js`)

`item = {id, label, shortcut, action, enabled?: () => bool, separator?}`. A menu is created on first
use (existing: File, Edit, View, Tools, Help). `enabled` is re-evaluated when tabs/dirty/zoom change.

```js
// forms.js
registerMenuItem('Tools', { separator: true });
registerMenuItem('Tools', { id: 'forms-reset', label: 'Reset form', action: () => resetForm(activeTab()), enabled: hasForm });
```

### Dialogs and toasts (`dialogs.js`)

`showDialog({title, body, buttons, initialFocus, className})` returns a Promise of the clicked
button's `value` (the `cancel: true` button's value on Esc/backdrop, else `null`); `body` may be a
string or a DOM node. `toast(msg, {timeout})` is non-blocking and returns its element.
`showError(title, err)` for failures. `dialogOpen()` lets global shortcuts stand down.

```js
// forms.js
const ok = await showDialog({
  title: 'Flatten form',
  body: 'Flattening draws the current field values into the pages and removes the form fields. The fields can no longer be edited. Continue?',
  buttons: [{ label: 'Cancel', value: 'cancel', cancel: true }, { label: 'Flatten', value: 'flatten', primary: true }],
});
if (ok !== 'flatten') return;
```

## 6. Save pipeline

`saveTab(tab, asNew)` in `app.js`:

1. Refuses read-only (encrypted) tabs with a dialog.
2. `let bytes = tab.bytes;` then for each `hook` of `state.hooks.beforeSave`, in order:
   `out = await hook(tab, bytes)`. If `out` is a `Uint8Array`, `bytes = out`, and unless
   `hook.transient` is true, also `tab.bytes = out`. Returning `undefined` means "no change".
3. Writes `bytes` (`api.writeFile` in place when the tab has a real path, else `api.saveFile`),
   then `markDirty(tab, false)`.

Hook order is load-bearing:

* **Forms first.** `forms.js` does `state.hooks.beforeSave.unshift(saveHook)` at init. Its hook
  writes typed values into the file with `fillFields(..., {updateAppearances: true})`; it is not
  transient, so the filled bytes become the new `tab.bytes` baseline and `forms.values` is reset.
* **Annotations last, transient.** `annotations.js` keeps its hook last (`placeHook` removes and
  re-pushes it on init and on every `tab:opened`). It flattens `tab.objects` into `bytes` (the
  forms output) with `flattenObjects`, and is marked `beforeSave.transient = true`, so
  `tab.bytes` stays unflattened.
* **Never flatten from previously saved output.** If annotations replaced `tab.bytes`, the next
  save would draw the same objects again on top of the already-flattened page. The rule for any new
  hook that draws content from live editor data: set `hook.transient = true` and start from the
  `bytes` argument, not from `tab.bytes`.

A new hook that must run after annotations is not supported by the current ordering helper; discuss
before adding one. Give hooks an `id` (`hook.id = 'name'`) as `annotations.js` does.

## 7. How to add an annotation tool

Example: a hypothetical `callout` box (substitute your own object).

1. **Define the object shape** in page-space points, e.g. `{type: 'callout', page, x, y, w, h, text, stroke, ...}`.
   Check `docs/CORE-API.md` for the fields `flattenObjects` already supports; if your type is new,
   add its drawing to `src/core/annotate.js` first and cover it in `test/annotate.test.js`.
2. **Register the object type** with `annotations.registerObjectType('callout', {...})`
   (section 5): `render` draws it into the overlay SVG in page space; `bbox`, `handles`, `move`,
   `resize` make it selectable and editable by the Select tool; `style` lets the options bar edit it.
3. **Register the tool** with `registerTool({id: 'callout', ...})`. Reuse the placeholder id
   (`callout`, `text`, `image`, `stamp`) to light up the existing disabled button.
   In `onPointerDown` guard with `if (e.button !== 0 || !hit || tab.readOnly) return;`, convert with
   `annotations.toPage(tab, hit.pageIndex, e.clientX, e.clientY)`, and call
   `annotations.renderPreview(tab, page, obj)` in `onPointerMove` (pass `null` to clear). Copy the
   `creator()` pattern from `tools-shapes.js`.
4. **Commit on pointer-up** with `annotations.add(tab, {...obj, page})` then
   `annotations.select(tab, [o.id])`. `add` pushes an undo step, marks the tab dirty and emits
   `annotations:changed`. Use `annotations.batch(tab, fn)` or `addMany` when one gesture makes several objects.
5. **Clean up** in `onDeactivate` (cancel a half-drawn gesture). Add a keyboard shortcut only if it
   cannot collide: `tools-shapes.js` skips keys when `dialogOpen()`, `isTyping()` or Ctrl/Alt is held.
6. **Do nothing for save**: the shared annotations hook flattens every object in `tab.objects`.
7. **Test** with a script in the style of `test/e2e/annotations.mjs` (section 9) and a core test if
   you touched `src/core`.

Remember `tab.readOnly`: never add objects to an encrypted tab.

## 8. How to add a page operation

All page operations go through `runOp(tab, label, fn)` in `pagetools.js` (exported; also
`ashStudio.pageTools.runOp`). It serialises operations on one promise chain, so two quick clicks never
race on stale bytes, and wraps the page protocol and undo for you.

`fn(bytes, pageCount, core) -> {bytes, map, select?} | null` receives the latest `tab.bytes`, the
page count and the `pdfOps.js` module; return `null` to do nothing. `runOp` then:

1. pushes `{bytes: before, map}` on `tab.bytesUndo` (cap 20) and clears `tab.bytesRedo`;
2. `commit`: `tab.bytes = bytes; markDirty(tab)`, emits `pages:remapped {tab, map}` and then
   `tab:bytesChanged {tab}` (the viewer reloads, thumbnails rebuild, `select` is applied on
   `thumbs:rebuilt`);
3. shows an "Undo" toast. Encrypted tabs are refused with a toast.

**`map` semantics**: `Map<oldIndex, newIndex | null>` over EVERY old page. `null` means the page was
deleted (its annotations are dropped); inserted pages have no key. Examples from the file:

```js
const shiftMap = (n, at, count) => new Map(range(n).map((i) => [i, i < at ? i : i + count])); // insert `count` pages at `at`
const orderMap = (order) => new Map(order.map((old, k) => [old, k]));                          // reorder: order[k] = old index
function deleteMap(n, del) { const gone = new Set(del); let k = 0;
  return new Map(range(n).map((i) => [i, gone.has(i) ? null : k++])); }
```

A working operation (identity map because rotating keeps indices):

```js
export function rotate(tab, sel, delta) {
  return runOp(tab, 'Rotate pages', async (bytes, n, c) => ({ bytes: await c.rotatePages(bytes, sel, delta), map: shiftMap(n, n, 0), select: sel }));
}
```

Steps for a new operation:

1. Add the pure byte transform to `src/core/pdfOps.js` (bytes in, bytes out, 0-based indices) with a test in `test/pdfOps.test.js`.
2. In `pagetools.js` write a function that validates (`editable(tab)`, not all pages deleted...) and calls
   `runOp`; build the right `map`. A wrong map silently attaches annotations to the wrong pages.
3. Optionally pass `select` (new indices to select after the reload).
4. Expose it: add to the `app.pageTools = {...}` object and wire a menu item via the local `item()` helper
   (it disables the item for read-only tabs) and/or the thumbnail context menu.
5. **Undo/redo is free**, provided every change goes through `runOp`. `undo`/`redo` (`step`) restore
   stored bytes and emit the inverted map. Never assign `tab.bytes` yourself for a page change.
6. Add a case to `test/e2e/pagetools.mjs`.

Ops that change bytes but not page structure (form flatten) emit only `tab:bytesChanged`.

## 9. Testing

| Command | What it runs |
| --- | --- |
| `npm test` | `node --test "test/*.test.js"`: core unit tests (`annotate`, `forms`, `pdfOps`; helpers in `test/helpers.js`). No browser. |
| `node scripts/vendor.js` (or `npm run vendor`) | Copies pdf.js into `renderer/vendor`; required before any e2e run. |
| `npm run test:e2e` | Runs `test/e2e/run.mjs` (see below). |
| `node test/e2e/annotations.mjs` | Annotation layer and markup tools. |
| `node test/e2e/forms.mjs` | AcroForm controls, fill/reset/flatten, rotated view. |
| `node test/e2e/pagetools.mjs` | Page tools: ops, undo/redo, merge/split/insert, thumbnails, `pages:remapped`. |
| `npm run smoke:browser` | `scripts/smoke-browser.mjs`, quick load check in the browser shim. |

`run.mjs` covers the shell: open several PDFs, tabs, zoom/fit, view rotation, search, themes
(`light.png`, `dark.png`), and the `/Rotate` page. Each script prints a final "OK" line (`E2E OK`,
`PAGETOOLS OK`, ...) and exits non-zero on failure; screenshots go to `test/e2e/out/`.

Chromium: set `CHROMIUM_PATH`, default `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.
`playwright-core` only drives it; there is no bundled browser.

The pattern shared by every e2e script (copy it for a new one):

1. Start a `node:http` server over the repo root (path-traversal guarded) on port 0; load `renderer/index.html`.
   The shim (`renderer/shim.js`) provides `window.api`, so no Electron is needed.
2. Generate the PDFs in the script with `pdf-lib`, then open them via the shim's `<input type=file>`.
3. Drive the app via `page.evaluate` against `window.ashStudio`, e.g. the helper in `pagetools.mjs`:

```js
const S = 'const app = window.ashStudio, v = app.viewer, bus = app.bus, pt = app.pageTools, tab = app.state.tabs.find((t) => t.id === app.state.activeId);';
const AsyncFunction = (async () => {}).constructor;
const ev = (body, arg) => page.evaluate(new AsyncFunction('arg', `${S}\n${body}`), arg);
```

4. Collect failures: `page.on('console', ...)` records `console.error` and any `[bus]` warning (a throwing
   listener); `pageerror` is recorded too, and the script fails if `problems` is non-empty.
5. Prefer `page.waitForFunction` on state (`tab.numPages`, `tab.bytesUndo.length`) over fixed sleeps.

Verify saved output by reading `tab.bytes` / the written bytes with pdf.js, not by looking at the overlay.

## 10. Known limitations

* **Existing text cannot be edited in place.** The core library cannot change a page's content stream.
  The workaround is a `whiteout` object plus new text on top; the covered content stays in the file
  (whiteout is not redaction; its tool tip says so).
* **Annotations are burned in on save.** They are page content, not PDF annotations. A saved file
  does not make them editable again when reopened (`annotations.js` header, `CORE-API.md`).
* **Encrypted PDFs are view-only.** After a password they open with `tab.readOnly = true`; Save,
  page tools and form editing are refused (`saveTab` dialog, `RO_TIP` in `pagetools.js`).
* **Standard fonts only.** Text and form appearances use the 14 standard fonts (WinAnsi); every
  character outside WinAnsi is drawn as `?`. Form values keep the exact Unicode in `/V`, and
  `forms.js` warns while typing (`checkWinAnsi`).
* **Signatures are not implemented as cryptography.** There is no signing code in this tree; form
  signature fields are shown as "not supported" controls, no digital-signature validation happens, and
  saving a signed PDF invalidates its signature (README). Any future drawn/stamped signature would be a
  visual overlay only.
* Page merge/split/extract/insert copy pages only: bookmarks, document JavaScript and AcroForm field
  linkage of copied pages are not carried over (`CORE-API.md`).
* No OCR; PDF JavaScript is not run; XFA forms are unsupported; Windows x64 builds only (README).
* `theme:changed`, `annotations:changed`, `annotations:selection` and `thumbs:selectionChanged` have no
  in-tree consumers; they are extension points.

## 11. PDFium edit worker (`renderer/pdfium/`)

PDFium (WebAssembly, from `@embedpdf/pdfium`, vendored to `renderer/vendor/pdfium/` by
`scripts/vendor.js`) is the engine for edits pdf-lib cannot do (text objects, incremental save). See
`docs/PDFIUM-SPIKE.md` for the evaluation. Reach it through `app.pdfium` (`window.ashStudio.pdfium`).

* **RPC.** `client.js` exposes promise methods (`open(bytes)` -> doc id, `pageCount`, `textObjects`,
  `save(id, { incremental })`, `close`); `worker.js` owns the single PDFium instance and runs every call
  synchronously off the UI thread. `protocol.js` (pure, unit-tested) defines the messages:
  `{ id, method, args }` -> `{ id, ok, result }` or `{ id, ok: false, error: { name, message } }`;
  worker errors are rethrown in the page as `Error`s with the same name and message. Byte arrays are
  transferred, not cloned: `open()` copies its input first so the caller's array stays usable, and
  results (saved bytes) arrive transferred.
* **Lazy loading.** Nothing is fetched, compiled or started until the first call, so viewing never
  pays for the 4.6 MB wasm. A failed start rejects every pending call, terminates the worker and lets
  the next call retry.
* **Where the wasm is compiled, and the CSP change.** `client.js` fetches `vendor/pdfium/pdfium.wasm`
  and compiles it with `WebAssembly.compile` in the document, then posts the compiled `Module` to the
  worker in the `init` message. Compiling in the page keeps it under the page's `<meta>` CSP (a worker
  served without a CSP header is not bound by it). Compiling WebAssembly needs
  `'wasm-unsafe-eval'` in `script-src` of `renderer/index.html`; that is the only CSP change. It
  allows WebAssembly compilation only, not JavaScript `eval`. The app:// protocol
  (`electron/main.js`) serves `.wasm` as `application/wasm`.
* **Tests.** `test/pdfium-protocol.test.js` (protocol), `test/e2e/pdfium.mjs` (Chromium under the real
  CSP: lazy start, `selfTest()`, errors, no CSP violations) and `test/e2e/electron.mjs` (wasm MIME type
  and `selfTest()` in the real app).
* **Licences.** PDFium and the libraries compiled into the wasm (libpng, zlib, FreeType, OpenJPEG,
  libjpeg-turbo, Little CMS) are listed as bundled components in `scripts/licenses.js`.
