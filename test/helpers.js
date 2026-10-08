// Test helpers: fixture builders (pdf-lib) and pdf.js inspection/rendering.
import { PDFDocument, PDFStreamWriter, degrees, concatTransformationMatrix, decodePDFRawStream, PDFArray, PDFRawStream, PDFHexString, PDFName } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trailerSize } from '../src/core/incremental.js';

const pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
// pdf.js wants forward slashes and a trailing slash (Windows paths use backslashes).
const STANDARD_FONTS = fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)).replace(/\\/g, '/');

/** Simple doc with `n` pages of given size; page i gets a label. */
export async function makePdf(n = 3, size = [612, 792]) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) {
    const p = doc.addPage(size);
    p.drawText(`Page ${i + 1}`, { x: 50, y: 50, size: 12 });
  }
  return doc.save();
}

/**
 * Page with non-zero-origin MediaBox [50 100 450 700], smaller CropBox
 * [70 120 430 680] (visible 360x560 unrotated), the given /Rotate, and a
 * dangling `cm` in its content stream (no q/Q) to prove isolation.
 */
export async function makeGeometryFixture(rotation) {
  const doc = await PDFDocument.create();
  const p = doc.addPage([400, 600]);
  p.setMediaBox(50, 100, 400, 600);
  p.setCropBox(70, 120, 360, 560);
  p.setRotation(degrees(rotation));
  p.pushOperators(concatTransformationMatrix(2, 0, 0, 2, 13, 17));
  return doc.save();
}

export async function pdfjsDoc(bytes) {
  const pdfjs = await pdfjsPromise;
  const task = pdfjs.getDocument({ data: bytes.slice(), standardFontDataUrl: STANDARD_FONTS, verbosity: 0, isEvalSupported: false });
  const doc = await task.promise;
  doc.close = () => task.destroy();
  return doc;
}

/** Text items with their visible-space origin and direction (viewport scale 1). */
export async function visibleText(bytes, pageIndex = 0) {
  const pdfjs = await pdfjsPromise;
  const doc = await pdfjsDoc(bytes);
  const page = await doc.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const items = tc.items
    .filter((it) => it.str !== undefined && it.str !== '')
    .map((it) => {
      const m = pdfjs.Util.transform(viewport.transform, it.transform);
      return { str: it.str, x: m[4], y: m[5], dirX: m[0], dirY: m[1] };
    });
  await doc.close();
  return items;
}

/** Render a page at scale 1 and return a pixel sampler ([r,g,b,a] at visible x,y). */
export async function renderPage(bytes, pageIndex = 0, scale = 1) {
  const doc = await pdfjsDoc(bytes);
  const page = await doc.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport }).promise;
  await doc.close();
  const sample = (x, y) => Array.from(ctx.getImageData(Math.floor(x * scale), Math.floor(y * scale), 1, 1).data);
  return { sample, width: viewport.width / scale, height: viewport.height / scale };
}

/** Concatenated, decoded content streams of a page (for operator checks). */
export async function pageContent(bytes, pageIndex = 0) {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(pageIndex);
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents];
  return streams
    .map((s) => (s instanceof PDFRawStream ? Buffer.from(decodePDFRawStream(s).decode()).toString('latin1') : Buffer.from(s.getContents()).toString('latin1')))
    .join('\n');
}

export function makeImage(type, w = 40, h = 20, color = '#0000ff') {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  return new Uint8Array(c.toBuffer(type === 'png' ? 'image/png' : 'image/jpeg'));
}

export function near(actual, expected, tol, msg) {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error(`${msg}: expected ${expected} +/- ${tol}, got ${actual}`);
  }
}

export function isColor(px, [r, g, b], tol = 40) {
  return Math.abs(px[0] - r) <= tol && Math.abs(px[1] - g) <= tol && Math.abs(px[2] - b) <= tol;
}

/**
 * Signed-looking PDF (no real cryptography): a /Sig value dictionary with /ByteRange and
 * /Contents, a signature field + widget on page 1 and AcroForm /SigFlags. `signed: false` leaves
 * the field empty (no /V). Written without object streams so the raw byte-scan fallback of
 * detectSignatures can see the dictionaries too.
 */
/**
 * A PDF with a signature field. `exact`: the /ByteRange covers the whole file except the /Contents
 * hex string, as a real signer writes it (the signature value itself stays a dummy). `objectStreams`:
 * objects in an (unencoded) object stream with a cross-reference stream, as pdf-lib's default save.
 * `mdp`: certify it (catalog /Perms /DocMDP, /TransformParams /P mdp).
 */
export async function makeSignedPdf({ signed = true, sigFlags = 3, pages = 2, exact = false, objectStreams = false, mdp = null } = {}) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]).drawText(`Signed page ${i + 1}`, { x: 50, y: 700, size: 18 });
  const ctx = doc.context;
  const page = doc.getPage(0);
  const field = { FT: 'Sig', T: PDFHexString.fromText('Signature1'), Type: 'Annot', Subtype: 'Widget', Rect: [0, 0, 0, 0], F: 132, P: page.ref };
  if (signed) {
    field.V = ctx.register(ctx.obj({
      Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'adbe.pkcs7.detached',
      ByteRange: exact ? [0, 1111111111, 2222222222, 3333333333] : [0, 1000, 9192, 500], Contents: PDFHexString.of('00'.repeat(64)), M: PDFHexString.fromText('D:20261007120000Z'),
      ...(mdp != null ? { Reference: [{ Type: 'SigRef', TransformMethod: 'DocMDP', TransformParams: { Type: 'TransformParams', P: mdp, V: PDFName.of('1.2') } }] } : {}),
    }));
    if (mdp != null) doc.catalog.set(PDFName.of('Perms'), ctx.obj({ DocMDP: field.V }));
  }
  const fieldRef = ctx.register(ctx.obj(field));
  page.node.set(PDFName.of('Annots'), ctx.obj([fieldRef]));
  doc.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: [fieldRef], SigFlags: sigFlags }));
  let bytes;
  if (objectStreams) { await doc.flush(); bytes = await PDFStreamWriter.forContext(ctx, 50, false).serializeToBuffer(); } else bytes = await doc.save({ useObjectStreams: false });
  if (!exact) return bytes;
  const text = Buffer.from(bytes).toString('latin1');
  const c = text.indexOf('/Contents <00');
  const start = c + '/Contents '.length, end = text.indexOf('>', start) + 1;
  const placeholder = '[ 0 1111111111 2222222222 3333333333 ]';
  const value = `[ 0 ${start} ${end} ${bytes.length - end} ]`.padEnd(placeholder.length, ' ');
  const at = text.indexOf(placeholder);
  if (c < 0 || at < 0) throw new Error('makeSignedPdf: placeholder not found');
  bytes.set(Buffer.from(value, 'latin1'), at);
  return bytes;
}

/** `bytes` with a trailer /Encrypt entry (a Standard security handler dictionary; nothing is encrypted). */
export async function makeEncryptedPdf() {
  const doc = await PDFDocument.load(await makePdf(1));
  doc.context.trailerInfo.Encrypt = doc.context.register(doc.context.obj({ Filter: 'Standard', V: 1, R: 2, O: PDFHexString.of('00'.repeat(32)), U: PDFHexString.of('00'.repeat(32)), P: -4 }));
  return doc.save({ useObjectStreams: false });
}

/**
 * Every string a reader could recover from the file: each indirect object's dictionaries/arrays with
 * literal and hex strings decoded, and each stream decoded (Flate etc.) with the hex strings inside it
 * decoded too. Raw-byte searches miss pdf-lib's hex strings and compressed streams.
 */
export async function decodedStrings(bytes) {
  const { PDFDocument: D, PDFDict, PDFString } = await import('pdf-lib');
  const doc = await D.load(bytes, { updateMetadata: false, throwOnInvalidObject: false });
  const parts = [];
  const hexes = (s) => s.replace(/<([0-9A-Fa-f\s]+)>/g, (_, h) => Buffer.from(h.replace(/\s+/g, ''), 'hex').toString('latin1'));
  const walk = (o) => {
    if (o instanceof PDFString || o instanceof PDFHexString) { parts.push(o.decodeText()); parts.push(Buffer.from(o.asBytes()).toString('latin1')); }
    else if (o instanceof PDFArray) o.asArray().forEach(walk);
    else if (o instanceof PDFDict) for (const [, v] of o.entries()) walk(v);
  };
  for (const [, o] of doc.context.enumerateIndirectObjects()) {
    if (o instanceof PDFRawStream) {
      walk(o.dict);
      let data;
      try { data = Buffer.from(decodePDFRawStream(o).decode()); } catch { data = Buffer.from(o.contents); }
      const s = data.toString('latin1');
      parts.push(s, hexes(s));
    } else walk(o);
  }
  return parts.join('\n');
}

/**
 * `bytes` (whose latest section is a cross-reference stream) plus an incremental update written as a
 * cross-reference stream, as other tools do: a new document information dictionary (number /Size)
 * and the stream itself (/Size + 1).
 */
export async function appendXrefStreamUpdate(bytes) {
  const text = Buffer.from(bytes).toString('latin1');
  const prev = Number([...text.matchAll(/startxref\s+(\d+)/g)].pop()[1]);
  const size = trailerSize(bytes);
  const root = /\/Root\s+(\d+\s+\d+\s+R)/.exec(text.slice(prev))[1];
  let out = text.endsWith('\n') ? text : text + '\n';
  const infoAt = out.length;
  out += `${size} 0 obj\n<< /Producer (xref-stream update) >>\nendobj\n`;
  const xrefAt = out.length;
  const row = (off) => [1, (off >>> 24) & 255, (off >>> 16) & 255, (off >>> 8) & 255, off & 255, 0, 0];
  const data = Buffer.from([...row(infoAt), ...row(xrefAt)]);
  out += `${size + 1} 0 obj\n<< /Type /XRef /Size ${size + 2} /Root ${root} /Info ${size} 0 R /Prev ${prev} /W [ 1 4 2 ] /Index [ ${size} 2 ] /Length ${data.length} >>\nstream\n`;
  return new Uint8Array(Buffer.concat([Buffer.from(out, 'latin1'), data, Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`, 'latin1')]));
}

/**
 * Strict check of the update section `out` appends to `original` (throws on the first problem):
 * the final startxref points at a classic `xref` table after the original bytes, every in-use entry
 * points at `<num> <gen> obj` in the appended part, /Prev is the original's startxref and /Size is
 * at least the original's /Size and above every number in the table. Returns { prev, size, numbers }.
 */
export function checkAppendedXref(original, out) {
  const fail = (m) => { throw new Error(`appended xref: ${m}`); };
  const text = Buffer.from(out).toString('latin1');
  const startxref = (t) => { const m = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(t); if (!m) fail('no final startxref'); return Number(m[1]); };
  const prevOrig = startxref(Buffer.from(original).toString('latin1'));
  const at = startxref(text);
  if (at < original.length || !text.startsWith('xref', at)) fail(`startxref ${at} does not point at an appended "xref"`);
  let i = at + 4;
  const numbers = [];
  const ws = /\s*/y;
  const skip = () => { ws.lastIndex = i; ws.exec(text); i = ws.lastIndex; };
  skip();
  for (;;) {
    const head = /(\d+) (\d+)[ \t]*\r?\n/y; head.lastIndex = i;
    const h = head.exec(text);
    if (!h) break;
    i = head.lastIndex;
    for (let k = 0; k < Number(h[2]); k++) {
      const e = /(\d{10}) (\d{5}) ([nf])(?: \r| \n|\r\n)/y; e.lastIndex = i;
      const m = e.exec(text);
      if (!m) fail(`bad entry at ${i}`);
      i = e.lastIndex;
      const num = Number(h[1]) + k;
      numbers.push(num);
      if (m[3] === 'n') {
        const off = Number(m[1]);
        if (off < original.length) fail(`object ${num} points into the original bytes (${off})`);
        if (!text.startsWith(`${num} ${Number(m[2])} obj`, off)) fail(`object ${num} offset ${off} does not start with "${num} ${Number(m[2])} obj"`);
      }
    }
  }
  skip();
  const tr = /trailer\s*<<([\s\S]*)>>\s*startxref/y; tr.lastIndex = i;
  const t = tr.exec(text);
  if (!t) fail('no trailer after the table');
  const prev = Number(/\/Prev\s+(\d+)/.exec(t[1])?.[1]);
  if (prev !== prevOrig) fail(`/Prev ${prev} is not the original startxref ${prevOrig}`);
  const size = Number(/\/Size\s+(\d+)/.exec(t[1])?.[1]);
  const origSize = trailerSize(original);
  if (!(size >= origSize) || numbers.some((n) => n >= size)) fail(`/Size ${size} (original ${origSize}, numbers ${numbers})`);
  return { prev, size, numbers };
}

/**
 * Open with pdf.js without its xref recovery (stopAtErrors) and collect its warnings (a broken
 * table makes it log "Indexing all PDF objects" and rebuild). Returns { pages, annots, warnings }
 * with the subtypes of page `pageIndex`'s annotations.
 */
export async function pdfjsStrict(bytes, pageIndex = 0) {
  const pdfjs = await pdfjsPromise;
  const warnings = [];
  const log = console.log;
  console.log = (...a) => { const m = a.join(' '); if (/^Warning:/.test(m)) warnings.push(m); else log(...a); };
  try {
    const task = pdfjs.getDocument({ data: bytes.slice(), standardFontDataUrl: STANDARD_FONTS, verbosity: 1, isEvalSupported: false, stopAtErrors: true });
    const doc = await task.promise;
    try {
      const annots = (await (await doc.getPage(pageIndex + 1)).getAnnotations()).map((a) => a.subtype);
      return { pages: doc.numPages, annots, warnings };
    } finally { await task.destroy(); }
  } finally { console.log = log; }
}

/** `qpdf --check` of `bytes`: { ok, output } (ok = exit 0, no warnings), or null when qpdf is not installed. */
export function qpdfCheck(bytes) {
  if (spawnSync('qpdf', ['--version']).error) return null;
  const dir = mkdtempSync(join(tmpdir(), 'ash-qpdf-'));
  try {
    const file = join(dir, 'in.pdf');
    writeFileSync(file, bytes);
    const r = spawnSync('qpdf', ['--check', file], { encoding: 'utf8' });
    const output = `${r.stdout}${r.stderr}`;
    return { ok: r.status === 0 && !/warning/i.test(output), output };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
