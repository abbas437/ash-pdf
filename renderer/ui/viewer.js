// Continuous-scroll PDF viewer built directly on pdf.js (no pdf_viewer.mjs).
//
// One scroll container per tab (tab.view.scrollEl) holding one div.page per PDF page.
// Pages are laid out at their final CSS size immediately; canvases, text layers and link
// layers are rendered lazily for pages near the viewport and released for far pages (LRU).
//
// Coordinate systems (see docs/UI-ARCHITECTURE.md):
//   * page box   — CSS px inside div.page, after zoom and view rotation;
//   * page space — PDF points, origin top-left of the page as displayed with its /Rotate
//                  applied, y down. This is the core library's "visible page space" and is
//                  NOT affected by zoom or by the (visual only) view rotation. The overlay
//                  SVG (svg.overlay-svg) uses this space as its viewBox.
import * as pdfjs from 'pdfjs-dist';
import { bus } from '../bus.js';
import { state } from '../state.js';
import { h } from './dom.js';
import { askPassword, showExternalLink, showError } from './dialogs.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', document.baseURI).href;
const VENDOR = new URL('./vendor/pdfjs/', document.baseURI).href;
export const PDF_TO_CSS = 96 / 72;   // 100 % zoom = real size on a 96 dpi screen
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 8;
const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6.4, 8];
const PAGE_PAD = 16;          // padding around the page column (px)
const KEEP_FAR = 4;           // rendered pages kept outside the near range (LRU)
const MAX_CANVAS_PIXELS = 16_777_216;
const SVG_NS = 'http://www.w3.org/2000/svg';

let host = null;
let resizeObs = null;

export const viewer = {
  pdfjs,
  PDF_TO_CSS,
  mount,
  openDocument,
  setViewBytes,
  build,
  activate,
  deactivate,
  destroy,
  reload,
  layout,
  scale: cssScale,
  setZoom,
  zoomIn: (tab, anchor) => setZoom(tab, stepZoom(tab.zoom, +1), anchor),
  zoomOut: (tab, anchor) => setZoom(tab, stepZoom(tab.zoom, -1), anchor),
  rotateView,
  scrollToPage,
  goToDest,
  nextPage: (tab) => scrollToPage(tab, Math.min(tab.numPages - 1, tab.currentPage + 1)),
  prevPage: (tab) => scrollToPage(tab, Math.max(0, tab.currentPage - 1)),
  getPageEl,
  getOverlayEl,
  getOverlaySvg: (tab, i) => getOverlayEl(tab, i)?.querySelector('svg.overlay-svg') ?? null,
  getPageState: (tab, i) => tab.view?.ps[i] ?? null,
  getScrollEl: (tab) => tab.view?.scrollEl ?? null,
  pageSize,
  getViewport,
  clientToPage,
  pageToClient,
  getTextContent,
  optionalContent,
  rerender: (tab) => { for (let i = 0; i < tab.numPages; i++) release(tab, i); schedule(tab); },
  renderedPages: (tab) => (tab.view ? tab.view.ps.flatMap((p, i) => (p.rendered ? [i] : [])) : []),
};

function mount(el) {
  host = el;
  resizeObs = new ResizeObserver(() => {
    const tab = state.tabs.find((t) => t.id === state.activeId);
    if (!tab?.view) return;
    if (tab.zoomMode !== 'custom') setZoom(tab, tab.zoomMode);
    else schedule(tab);
  });
  resizeObs.observe(host);
}

function cssScale(tab) { return tab.zoom * PDF_TO_CSS; }
function totalRotation(tab, i) { return (tab.pages[i].rotate + tab.viewRotation) % 360; }
function getViewport(tab, i, scale = cssScale(tab)) {
  return tab.pages[i].getViewport({ scale, rotation: totalRotation(tab, i) });
}
/** Size of page i in page space (points, /Rotate applied, view rotation NOT applied). */
function pageSize(tab, i) {
  const vp = tab.pages[i].getViewport({ scale: 1 });
  return { width: vp.width, height: vp.height };
}

function stepZoom(z, dir) {
  if (dir > 0) return ZOOM_STEPS.find((s) => s > z + 1e-3) ?? ZOOM_MAX;
  return [...ZOOM_STEPS].reverse().find((s) => s < z - 1e-3) ?? ZOOM_MIN;
}

// ---------------------------------------------------------------- loading
/** Load tab.bytes with pdf.js, asking for a password if needed. Throws {cancelled:true} on cancel. */
async function openDocument(tab) {
  const loaded = await loadDocument(tab);
  commitDocument(tab, loaded);
  return loaded.doc;
}

/** Load tab.bytes (as they are now) with pdf.js without touching the tab's document state. */
async function loadDocument(tab) {
  let needed = false;
  let cancelled = false;
  // The view copy (annotations.js): tab.bytes without the markup annotations the overlay mirrors.
  const data = viewBytes ? await viewBytes(tab) : tab.bytes;
  const task = pdfjs.getDocument({
    data: data.slice(),   // pdf.js transfers the buffer to its worker
    password: tab.password ?? undefined,
    cMapUrl: VENDOR + 'cmaps/', cMapPacked: true, standardFontDataUrl: VENDOR + 'standard_fonts/',
    wasmUrl: VENDOR + 'wasm/', iccUrl: VENDOR + 'iccs/', isEvalSupported: false, enableScripting: false,
  });
  task.onPassword = async (update, reason) => {
    needed = true;
    const pw = await askPassword(tab.name, reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD);
    if (pw == null) { cancelled = true; task.destroy(); return; }
    tab.password = pw;
    update(pw);
  };
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    if (cancelled) throw Object.assign(new Error('Opening cancelled'), { cancelled: true });
    throw err;
  }
  try {
    const meta = await doc.getMetadata().catch(() => null);
    const pages = await Promise.all(Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1)));
    const ocConfig = await doc.getOptionalContentConfig().catch(() => null);
    return { doc, meta, pages, ocConfig, encrypted: needed || !!meta?.info?.EncryptFilterName };
  } catch (err) {
    destroyDoc(doc);
    throw err;
  }
}

let viewBytes = null;
/** fn(tab) -> Promise<Uint8Array>: the bytes pdf.js renders instead of tab.bytes. */
function setViewBytes(fn) { viewBytes = fn; }

function commitDocument(tab, { doc, meta, pages, ocConfig, encrypted }) {
  // Layers (optional content): keep the user's visibility across reloads of the same document.
  if (tab.ocConfig && ocConfig) {
    for (const [id, g] of tab.ocConfig) if (ocConfig.getGroup(id) && ocConfig.getGroup(id).visible !== g.visible) ocConfig.setVisibility(id, g.visible, false);
  }
  tab.ocConfig = ocConfig;
  tab.encrypted = encrypted;
  tab.readOnly = tab.encrypted;
  tab.metadata = meta;
  tab.pdfDoc = doc;
  tab.numPages = doc.numPages;
  tab.pages = pages;
  tab.currentPage = Math.min(tab.currentPage, tab.numPages - 1);
}

/** (Re)create the scroll container and page elements of a tab. */
function build(tab) {
  const old = tab.view;
  const scrollEl = old?.scrollEl ?? h('div.viewer-scroll', { tabindex: '0', role: 'document', 'aria-label': `${tab.name}: pages`, dataset: { tabId: tab.id } });
  const pagesEl = h('div.pages');
  const ps = [];
  const pageEls = [];
  for (let i = 0; i < tab.numPages; i++) {
    const pageEl = h('div.page', { dataset: { pageIndex: String(i), label: String(i + 1) }, role: 'region', 'aria-label': `Page ${i + 1}` });
    const { width, height } = pageSize(tab, i);
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'overlay-svg');
    svg.setAttribute('viewBox', `0 0 ${round3(width)} ${round3(height)}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.dataset.pageWidth = String(width);
    svg.dataset.pageHeight = String(height);
    const overlay = h('div.page-overlay', { dataset: { pageIndex: String(i) } });
    overlay.append(svg);
    const linkLayer = h('div.linkLayer');
    pageEl.append(linkLayer, overlay);
    pagesEl.append(pageEl);
    pageEls.push(pageEl);
    ps.push({ rendered: false, scale: 0, rotation: -1, task: null, canvas: null, textLayer: null, textLayerDiv: null, linkLayer, overlay, svg, lastUsed: 0 });
  }
  if (old) {
    for (let i = 0; i < old.ps.length; i++) old.ps[i].task?.cancel();
    old.pagesEl.replaceWith(pagesEl);
  } else {
    scrollEl.append(pagesEl);
    scrollEl.addEventListener('scroll', () => schedule(tab), { passive: true });
    const unpin = () => { tab.view.navTarget = null; };
    scrollEl.addEventListener('wheel', (e) => onWheel(tab, e), { passive: false });
    scrollEl.addEventListener('pointerdown', unpin);
    scrollEl.addEventListener('keydown', (e) => { if (/^Arrow|^Page|^Home|^End|^ $/.test(e.key)) unpin(); });
    host.append(scrollEl);
  }
  tab.view = { scrollEl, pagesEl, pageEls, ps, navTarget: null, raf: 0, laidScale: 0, destroyed: false };
  layout(tab);
  bus.emit('tab:loaded', { tab, reloaded: !!old });
}

function round3(n) { return Math.round(n * 1000) / 1000; }

// ---------------------------------------------------------------- layout
/** Apply the tab's zoom/rotation to every page element (cheap; no rendering). */
function layout(tab) {
  const v = tab.view;
  if (!v) return;
  if (tab.zoomMode !== 'custom') tab.zoom = fitZoom(tab, tab.zoomMode);
  const scale = cssScale(tab);
  for (let i = 0; i < tab.numPages; i++) {
    const vp = getViewport(tab, i, scale);
    const el = v.pageEls[i];
    el.style.width = `${vp.width}px`;
    el.style.height = `${vp.height}px`;
    el.style.setProperty('--scale-factor', String(scale));
    el.style.setProperty('--total-scale-factor', String(scale * (tab.pages[i].userUnit || 1)));
    const { width, height } = pageSize(tab, i);
    const svg = v.ps[i].svg;
    svg.style.width = `${width * scale}px`;
    svg.style.height = `${height * scale}px`;
    svg.dataset.viewRotation = String(tab.viewRotation);
    const ps = v.ps[i];
    if (ps.rendered && ps.rotation !== vp.rotation) release(tab, i);
  }
  v.laidScale = scale;
  schedule(tab);
}

function fitZoom(tab, mode) {
  const sc = tab.view?.scrollEl;
  if (!sc || !sc.clientWidth || !tab.numPages) return tab.zoom || 1;
  const vp = getViewport(tab, tab.currentPage, PDF_TO_CSS);
  const availW = sc.clientWidth - PAGE_PAD * 2 - 2;
  const availH = sc.clientHeight - PAGE_PAD * 2 - 2;
  let z = availW / vp.width;
  if (mode === 'fit-page') z = Math.min(z, availH / vp.height);
  return clamp(z, ZOOM_MIN, ZOOM_MAX);
}
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/**
 * setZoom(tab, 'fit-width' | 'fit-page' | number, anchor?) — anchor = {clientX, clientY}
 * keeps that screen point over the same page region (default: viewport centre).
 */
function setZoom(tab, value, anchor) {
  if (!tab?.view) return;
  const a = captureAnchor(tab, anchor?.clientX, anchor?.clientY);
  if (value === 'fit-width' || value === 'fit-page') {
    tab.zoomMode = value;
  } else {
    tab.zoomMode = 'custom';
    tab.zoom = clamp(Number(value) || 1, ZOOM_MIN, ZOOM_MAX);
  }
  layout(tab);
  if (a) restoreAnchor(tab, a);
  if (tab.zoomMode !== 'custom') centerX(tab);
  bus.emit('zoom:changed', { tab, zoom: tab.zoom, mode: tab.zoomMode, scale: cssScale(tab) });
}

function captureAnchor(tab, clientX, clientY) {
  const sc = tab.view.scrollEl;
  if (!sc.isConnected || sc.hidden || !tab.numPages) return null;
  const r = sc.getBoundingClientRect();
  clientX ??= r.left + sc.clientWidth / 2;
  clientY ??= r.top + sc.clientHeight / 2;
  const i = pageIndexAtClientY(tab, clientY);
  const pr = tab.view.pageEls[i].getBoundingClientRect();
  return { i, fx: (clientX - pr.left) / pr.width, fy: (clientY - pr.top) / pr.height, dx: clientX - r.left, dy: clientY - r.top };
}

function restoreAnchor(tab, a) {
  const sc = tab.view.scrollEl;
  const pe = tab.view.pageEls[a.i];
  sc.scrollTop = pe.offsetTop + clamp(a.fy, 0, 1) * pe.offsetHeight - a.dy;
  sc.scrollLeft = pe.offsetLeft + clamp(a.fx, 0, 1) * pe.offsetWidth - a.dx;
}

function pageIndexAtClientY(tab, clientY) {
  const els = tab.view.pageEls;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < els.length; i++) {
    const r = els[i].getBoundingClientRect();
    if (clientY >= r.top && clientY <= r.bottom) return i;
    const d = Math.min(Math.abs(clientY - r.top), Math.abs(clientY - r.bottom));
    if (d < bestDist) { bestDist = d; best = i; }
    if (r.top > clientY && d > bestDist) break;
  }
  return best;
}

function rotateView(tab, delta) {
  if (!tab?.view) return;
  const page = tab.currentPage;
  tab.viewRotation = (((tab.viewRotation + delta) % 360) + 360) % 360;
  for (let i = 0; i < tab.numPages; i++) release(tab, i);
  layout(tab);
  scrollToPage(tab, page);
  bus.emit('rotation:changed', { tab, rotation: tab.viewRotation });
  bus.emit('zoom:changed', { tab, zoom: tab.zoom, mode: tab.zoomMode, scale: cssScale(tab) });
}

function onWheel(tab, e) {
  tab.view.navTarget = null;
  if (!e.ctrlKey) return;
  e.preventDefault();
  const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.002));
  setZoom(tab, tab.zoom * factor, { clientX: e.clientX, clientY: e.clientY });
}

// ---------------------------------------------------------------- navigation
/**
 * Scroll so page i is at the top. opts: {x, y} in page space (points) to bring that point
 * to the top-left, or {userX, userY} in PDF user space (from link destinations).
 */
function scrollToPage(tab, i, opts = {}) {
  if (!tab?.view || !tab.numPages) return;
  i = clamp(Math.trunc(i), 0, tab.numPages - 1);
  const v = tab.view;
  const pe = v.pageEls[i];
  let dy = 0;
  let dx = null;
  if (opts.userY != null || opts.userX != null) {
    const vp = getViewport(tab, i);
    const [lx, ly] = vp.convertToViewportPoint(opts.userX ?? 0, opts.userY ?? 0);
    if (opts.userY != null) dy = ly;
    if (opts.userX != null) dx = lx;
  } else if (opts.y != null || opts.x != null) {
    const p = pageToLocal(tab, i, opts.x ?? 0, opts.y ?? 0);
    if (opts.y != null) dy = p.x !== undefined ? p.y : 0;
    if (opts.x != null) dx = p.x;
  }
  v.scrollEl.scrollTop = pe.offsetTop - PAGE_PAD / 2 + Math.max(0, dy);
  if (dx != null) v.scrollEl.scrollLeft = pe.offsetLeft + dx - PAGE_PAD;
  v.navTarget = i;
  setCurrent(tab, i);
  schedule(tab);
}

async function goToDest(tab, dest) {
  try {
    const explicit = typeof dest === 'string' ? await tab.pdfDoc.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || !explicit.length) return;
    const ref = explicit[0];
    const idx = ref && typeof ref === 'object' ? await tab.pdfDoc.getPageIndex(ref) : Number.isInteger(ref) ? ref : null;
    if (idx == null) return;
    const kind = explicit[1]?.name;
    const opts = {};
    if (kind === 'XYZ') { if (explicit[3] != null) opts.userY = explicit[3]; }
    else if (kind === 'FitH' || kind === 'FitBH') { if (explicit[2] != null) opts.userY = explicit[2]; }
    else if (kind === 'FitR') opts.userY = explicit[5];
    scrollToPage(tab, idx, opts);
  } catch (err) {
    console.warn('Could not resolve destination', err);
  }
}

function setCurrent(tab, i) {
  if (tab.currentPage === i) return;
  tab.currentPage = i;
  bus.emit('page:changed', { tab, pageIndex: i });
}

// ---------------------------------------------------------------- coordinates
function getPageEl(tab, i) { return tab.view?.pageEls[i] ?? null; }
function getOverlayEl(tab, i) { return tab.view?.ps[i]?.overlay ?? null; }

/** Page-space point (points) -> CSS px offset inside the page box. */
function pageToLocal(tab, i, x, y) {
  const vp1 = tab.pages[i].getViewport({ scale: 1 });
  const [ux, uy] = vp1.convertToPdfPoint(x, y);
  const [lx, ly] = getViewport(tab, i).convertToViewportPoint(ux, uy);
  return { x: lx, y: ly };
}

/**
 * Client (screen CSS px) -> {pageIndex, x, y, inside} with x/y in page space points.
 * Uses the page under the point, or the vertically nearest page.
 */
function clientToPage(tab, clientX, clientY) {
  if (!tab?.view || !tab.numPages) return null;
  const i = pageIndexAtClientY(tab, clientY);
  const r = tab.view.pageEls[i].getBoundingClientRect();
  const vp = getViewport(tab, i);
  const [ux, uy] = vp.convertToPdfPoint(clientX - r.left, clientY - r.top);
  const [x, y] = tab.pages[i].getViewport({ scale: 1 }).convertToViewportPoint(ux, uy);
  const { width, height } = pageSize(tab, i);
  return { pageIndex: i, x, y, inside: x >= 0 && y >= 0 && x <= width && y <= height };
}

/** Page-space point -> client coordinates {clientX, clientY}. */
function pageToClient(tab, i, x, y) {
  const r = tab.view.pageEls[i].getBoundingClientRect();
  const p = pageToLocal(tab, i, x, y);
  return { clientX: r.left + p.x, clientY: r.top + p.y };
}

// ---------------------------------------------------------------- visibility & rendering
function schedule(tab) {
  const v = tab.view;
  if (!v || v.raf) return;
  v.raf = requestAnimationFrame(() => { v.raf = 0; update(tab); });
}

function update(tab) {
  const v = tab.view;
  if (!v || v.destroyed || tab.id !== state.activeId || v.scrollEl.hidden) return;
  const sc = v.scrollEl;
  const top = sc.scrollTop;
  const bottom = top + sc.clientHeight;
  let first = -1, last = -1, best = -1, bestVis = -1;
  for (let i = 0; i < v.pageEls.length; i++) {
    const el = v.pageEls[i];
    const t = el.offsetTop, b = t + el.offsetHeight;
    if (b >= top && t <= bottom) {
      if (first < 0) first = i;
      last = i;
      const vis = Math.min(b, bottom) - Math.max(t, top);
      if (vis > bestVis + 1) { bestVis = vis; best = i; }
    } else if (first >= 0) break;
  }
  if (first < 0) return;
  const pinned = v.navTarget;
  setCurrent(tab, pinned != null && pinned >= first && pinned <= last ? pinned : best);
  const now = performance.now();
  const wanted = [];
  for (let i = first; i <= last; i++) { wanted.push(i); v.ps[i].lastUsed = now; }
  if (last + 1 < tab.numPages) wanted.push(last + 1);
  if (first - 1 >= 0) wanted.push(first - 1);
  const scale = cssScale(tab);
  for (const i of wanted) {
    const ps = v.ps[i];
    if (!ps.rendered || ps.scale !== scale || ps.rotation !== totalRotation(tab, i)) enqueue(tab, i);
  }
  // Release far pages, keeping the KEEP_FAR most recently seen ones.
  const lo = first - 2, hi = last + 2;
  const far = [];
  for (let i = 0; i < v.ps.length; i++) if ((v.ps[i].rendered || v.ps[i].task) && (i < lo || i > hi)) far.push(i);
  far.sort((a, b) => v.ps[b].lastUsed - v.ps[a].lastUsed);
  for (const i of far.slice(KEEP_FAR)) release(tab, i);
}

const queue = [];
let running = 0;
const MAX_RUNNING = 2;

function enqueue(tab, i) {
  if (queue.some((j) => j.tab === tab && j.i === i)) return;
  if (tab.view.ps[i].task) return;
  queue.push({ tab, i });
  pump();
}

function pump() {
  while (running < MAX_RUNNING && queue.length) {
    const job = queue.shift();
    if (job.tab.view?.destroyed || job.tab.id !== state.activeId) continue;
    running++;
    renderPage(job.tab, job.i)
      .catch((err) => reportRenderError(job.tab, job.i, err))
      .finally(() => { running--; pump(); });
  }
}

let renderErrorShown = false;
function reportRenderError(tab, i, err) {
  if (err?.name === 'RenderingCancelledException' || /cancel/i.test(err?.message ?? '')) return;
  console.warn(`Page ${i + 1} failed to render`, err);
  if (!renderErrorShown) {
    renderErrorShown = true;
    showError('Page could not be displayed', new Error(`Page ${i + 1} of "${tab.name}" could not be rendered: ${err?.message ?? err}`)).then(() => { renderErrorShown = false; });
  }
}

/** Render params for the tab's current layer visibility (tab.ocConfig, display intent). */
function optionalContent(tab) {
  return tab.ocConfig ? { optionalContentConfigPromise: Promise.resolve(tab.ocConfig) } : {};
}

async function renderPage(tab, i) {
  const v = tab.view;
  const ps = v.ps[i];
  const scale = cssScale(tab);
  const vp = getViewport(tab, i, scale);
  if (ps.rendered && ps.scale === scale && ps.rotation === vp.rotation) return;
  const page = tab.pages[i];
  const dpr = window.devicePixelRatio || 1;
  let out = dpr;
  if (vp.width * vp.height * out * out > MAX_CANVAS_PIXELS) out = Math.sqrt(MAX_CANVAS_PIXELS / (vp.width * vp.height));
  const canvas = h('canvas.page-canvas', { 'aria-hidden': 'true' });
  canvas.width = Math.max(1, Math.floor(vp.width * out));
  canvas.height = Math.max(1, Math.floor(vp.height * out));
  const task = page.render({ canvas, viewport: vp, transform: out !== 1 ? [out, 0, 0, out, 0, 0] : undefined, annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS,
    ...optionalContent(tab) });
  ps.task = task;
  try {
    await task.promise;
  } catch (err) {
    freeCanvas(canvas);
    if (err?.name === 'RenderingCancelledException') return;
    throw err;
  } finally {
    if (ps.task === task) ps.task = null;
  }
  if (v.destroyed || tab.view !== v || cssScale(tab) !== scale || totalRotation(tab, i) !== vp.rotation) {
    freeCanvas(canvas);
    schedule(tab);
    return;
  }
  const pageEl = v.pageEls[i];
  if (ps.canvas) { ps.canvas.replaceWith(canvas); freeCanvas(ps.canvas); }
  else pageEl.prepend(canvas);
  ps.canvas = canvas;

  // Text layer (selection, copy, search highlights).
  const textContent = await getTextContent(tab, i);
  const tlDiv = h('div.textLayer');
  const tl = new pdfjs.TextLayer({ textContentSource: textContent, container: tlDiv, viewport: vp });
  await tl.render();
  if (tab.view !== v || ps.canvas !== canvas) { tl.cancel?.(); return; }
  ps.textLayerDiv?.remove();
  canvas.after(tlDiv);
  ps.textLayer = tl;
  ps.textLayerDiv = tlDiv;

  await renderLinks(tab, i, vp);
  // Released (or re-rendered) while the text/link layers were awaited: not ours to mark.
  if (tab.view !== v || ps.canvas !== canvas) return;
  ps.rendered = true;
  ps.scale = scale;
  ps.rotation = vp.rotation;
  pageEl.classList.add('rendered');
  bus.emit('page:rendered', { tab, pageIndex: i, container: pageEl, viewport: vp, scale });
}

async function renderLinks(tab, i, vp) {
  const ps = tab.view.ps[i];
  ps.linkLayer.replaceChildren();
  let annots = [];
  try { annots = await tab.pages[i].getAnnotations({ intent: 'display' }); } catch { return; }
  for (const a of annots) {
    if (a.subtype !== 'Link' || (!a.url && !a.dest && !a.action)) continue;
    // pdf.js 6 has no PageViewport.convertToViewportRectangle.
    const [x1, y1] = vp.convertToViewportPoint(a.rect[0], a.rect[1]), [x2, y2] = vp.convertToViewportPoint(a.rect[2], a.rect[3]);
    const left = Math.min(x1, x2), top = Math.min(y1, y2);
    const link = h('a.pdf-link', {
      href: '#',
      title: a.url ? a.url : 'Go to destination',
      'aria-label': a.url ? `External link: ${a.url}` : 'Internal link',
      style: {
        left: `${(left / vp.width) * 100}%`, top: `${(top / vp.height) * 100}%`,
        width: `${(Math.abs(x2 - x1) / vp.width) * 100}%`, height: `${(Math.abs(y2 - y1) / vp.height) * 100}%`,
      },
    });
    link.addEventListener('click', (e) => {
      e.preventDefault();
      if (a.url) showExternalLink(a.url);
      else if (a.dest) goToDest(tab, a.dest);
      else if (a.action === 'NextPage') viewer.nextPage(tab);
      else if (a.action === 'PrevPage') viewer.prevPage(tab);
      else if (a.action === 'FirstPage') scrollToPage(tab, 0);
      else if (a.action === 'LastPage') scrollToPage(tab, tab.numPages - 1);
    });
    ps.linkLayer.append(link);
  }
}

function freeCanvas(c) { c.width = 0; c.height = 0; c.remove(); }

function release(tab, i) {
  const ps = tab.view?.ps[i];
  if (!ps) return;
  ps.task?.cancel();
  ps.task = null;
  if (ps.canvas) { freeCanvas(ps.canvas); ps.canvas = null; }
  ps.textLayer?.cancel?.();
  ps.textLayerDiv?.remove();
  ps.textLayer = null;
  ps.textLayerDiv = null;
  ps.linkLayer.replaceChildren();
  ps.rendered = false;
  ps.scale = 0;
  ps.rotation = -1;
  tab.view.pageEls[i].classList.remove('rendered');
}

async function getTextContent(tab, i) {
  if (!tab.textCache.has(i)) tab.textCache.set(i, tab.pages[i].getTextContent());
  try {
    return await tab.textCache.get(i);
  } catch (err) {
    tab.textCache.delete(i);
    throw err;
  }
}

// ---------------------------------------------------------------- tab lifecycle
function saveScroll(tab) {
  const v = tab.view;
  if (!v || v.scrollEl.hidden || !tab.numPages) return;
  const pe = v.pageEls[tab.currentPage];
  tab.scrollState = { pageIndex: tab.currentPage, fy: (v.scrollEl.scrollTop - pe.offsetTop) / Math.max(1, pe.offsetHeight), left: v.scrollEl.scrollLeft };
}

function restoreScroll(tab) {
  const v = tab.view;
  const s = tab.scrollState;
  if (!s) return;
  const pe = v.pageEls[Math.min(s.pageIndex, tab.numPages - 1)];
  v.scrollEl.scrollTop = pe.offsetTop + s.fy * pe.offsetHeight;
  v.scrollEl.scrollLeft = s.left;
  setCurrent(tab, Math.min(s.pageIndex, tab.numPages - 1));
}

function activate(tab) {
  for (const t of state.tabs) if (t !== tab && t.view && !t.view.scrollEl.hidden) deactivate(t);
  const v = tab.view;
  if (!v) return;
  v.scrollEl.hidden = false;
  layout(tab);
  if (tab.scrollState) restoreScroll(tab);
  else centerX(tab);
  schedule(tab);
}

/** Centre the current page horizontally (pages of mixed widths widen the column). */
function centerX(tab) {
  const sc = tab.view?.scrollEl;
  const pe = tab.view?.pageEls[tab.currentPage];
  if (!sc || !pe || sc.hidden) return;
  sc.scrollLeft = pe.offsetLeft + pe.offsetWidth / 2 - sc.clientWidth / 2;
}

function deactivate(tab) {
  if (!tab.view) return;
  saveScroll(tab);
  tab.view.scrollEl.hidden = true;
}

function destroy(tab) {
  const v = tab.view;
  if (!v) return;
  v.destroyed = true;
  cancelAnimationFrame(v.raf);
  for (let i = 0; i < v.ps.length; i++) release(tab, i);
  v.scrollEl.remove();
  destroyDoc(tab.pdfDoc);
  tab.pdfDoc = null;
  tab.pages = [];
  tab.view = null;
}

/**
 * Re-open tab.bytes (after page operations), keeping the reading position. Reloads can overlap
 * (undo + redo in quick succession): each one takes a generation number and only the newest
 * may install its document; an older one that finishes later is destroyed and discarded, so
 * the view always ends up showing the latest tab.bytes.
 */
async function reload(tab) {
  if (!tab.view) return;
  const gen = (tab.reloadGen = (tab.reloadGen ?? 0) + 1);
  const current = () => gen === tab.reloadGen && !!tab.view;
  let loaded;
  try {
    loaded = await loadDocument(tab);
  } catch (err) {
    if (current() && !err?.cancelled) showError('Could not reload the document', err);
    return;
  }
  if (!current()) { destroyDoc(loaded.doc); return; }
  saveScroll(tab);
  const keep = tab.scrollState;
  const oldDoc = tab.pdfDoc;
  for (let i = 0; i < tab.view.ps.length; i++) release(tab, i);
  tab.textCache = new Map();
  commitDocument(tab, loaded);
  build(tab);
  if (keep && tab.id === state.activeId) {
    tab.scrollState = { ...keep, pageIndex: Math.min(keep.pageIndex, tab.numPages - 1) };
    restoreScroll(tab);
  }
  destroyDoc(oldDoc);
  schedule(tab);
}

// pdf.js 6 has no PDFDocumentProxy.destroy(); the loading task owns the worker transport.
function destroyDoc(doc) {
  doc?.loadingTask?.destroy().catch((err) => console.warn('Could not release the document', err));
}

bus.on('tab:bytesChanged', ({ tab }) => reload(tab));
