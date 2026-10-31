// Pure helpers for getting pictures and documents into a PDF (image-import.js, drops in app.js,
// Pages ▸ Insert from file…): image type from magic bytes (the extension only for SVG, whose text sniff can
// fail), the raster size an SVG is drawn at, the cap on decoded raster size, the kind of a dropped file, and plain text -> printable HTML.
// No DOM: the Node unit tests run the same code.
import { htmlPage } from './office-html.js';

export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];
export const DOC_EXTS = ['docx', 'xlsx', 'txt', 'md'];
const ext = (name) => /\.([^./\\]+)$/.exec(String(name ?? ''))?.[1].toLowerCase() ?? '';

/** Does decoded text (BOM, whitespace, XML declaration, comments, doctype allowed first) start an SVG? */
export function isSvgText(text) {
  let s = text.replace(/^﻿/, '');
  if (!/^\s*<\?xml[\s?]/.test(s) && !/^\s*<(svg|!)/i.test(s)) return false;
  s = s.replace(/^\s*<\?xml[\s\S]*?\?>/, '');
  for (let prev; prev !== s;) { prev = s; s = s.replace(/^\s*<!--[\s\S]*?-->/, '').replace(/^\s*<!DOCTYPE[^>]*>/i, ''); }
  return /^\s*<svg[\s>]/i.test(s);
}

/** 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'svg' from the bytes; a .svg name is the only extension fallback (binary formats must match their magic bytes), else null. */
export function detectImage(b, name) {
  if (b?.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  if (b?.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b?.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif'; // GIF8
  if (b?.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  if (b?.length >= 14 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  if (b?.length && isSvgText(new TextDecoder().decode(b.subarray(0, 4096)))) return 'svg';
  return ext(name) === 'svg' ? 'svg' : null;
}

export const unsupportedImage = (name) => `${name || 'The file'} is not a supported image (PNG, JPEG, GIF, WebP, BMP or SVG)`;

export const SVG_DEFAULT = 1000, SVG_MAX = 4000;
/** Raster size of an SVG with intrinsic size w×h (0 when it has none): ×2, longest side ≤ 4000, 1000 px without a size. */
export function svgRasterSize(w, h) {
  if (!(w > 0 && h > 0)) return { width: SVG_DEFAULT, height: SVG_DEFAULT };
  const s = Math.min(2, SVG_MAX / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

/** Size to decode a picture of w×h at: unchanged, or scaled down so the longest side is at most `max` px. */
export function fitRaster(w, h, max = SVG_MAX) {
  const s = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}
export const tooLarge = (name) => `${name || 'The picture'} is too large or could not be converted`;

/** What a dropped / picked file is: 'pdf' | 'image' | 'doc' | null (unsupported), by name and MIME type. */
export function fileKind({ name, type } = {}) {
  const e = ext(name);
  if (e === 'pdf' || type === 'application/pdf') return 'pdf';
  if (IMAGE_EXTS.includes(e) || /^image\/(png|jpeg|gif|webp|bmp|svg\+xml)$/.test(type ?? '')) return 'image';
  if (DOC_EXTS.includes(e)) return 'doc';
  return null;
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
/** Plain text (.txt / .md as text) -> a printable page: a paragraph per line, wrapped, `dir="auto"` so Arabic reads right to left. */
export function textToHtml(text, title = 'Document') {
  const body = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
    .map((l) => `<p dir="auto" style="margin:0;white-space:pre-wrap;overflow-wrap:anywhere">${l ? esc(l) : '&nbsp;'}</p>`).join('');
  return htmlPage({ title, body });
}
