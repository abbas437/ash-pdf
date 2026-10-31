// Pictures in any common format, ready to place on a page or make a page of: PNG and JPEG pass
// through unchanged; GIF (first frame), WebP, BMP and SVG are drawn on a canvas and re-encoded as
// PNG (transparency kept), never decoded larger than 4000 px on the longest side. SVG is drawn at twice
// its intrinsic size (same cap), 1000 px square when it has no size. Unknown or undecodable files throw an Error with a user message.
import { detectImage, unsupportedImage, svgRasterSize, fitRaster, tooLarge } from './image-import-lib.js';

const MIME = { gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };

async function svgSource(bytes) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { src: img, ...svgRasterSize(img.naturalWidth, img.naturalHeight) };
  } finally { URL.revokeObjectURL(url); }
}

/** bytes (+ file name for the extension fallback and messages) -> {bytes, mime} of a PNG or JPEG. */
export async function toPlaceable(bytes, nameHint = '') {
  const kind = detectImage(bytes, nameHint);
  if (kind === 'png' || kind === 'jpeg') return { bytes, mime: `image/${kind}` };
  if (!kind) throw new Error(unsupportedImage(nameHint));
  let src, width, height;
  try {
    if (kind === 'svg') ({ src, width, height } = await svgSource(bytes));
    else { src = await createImageBitmap(new Blob([bytes], { type: MIME[kind] })); ({ width, height } = src); }
  } catch { throw new Error(unsupportedImage(nameHint)); }
  try {
    const { width: w, height: h } = fitRaster(width, height);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context'); // canvas memory exhausted
    ctx.drawImage(src, 0, 0, w, h);
    const blob = await new Promise((res, rej) => { try { canvas.toBlob(res, 'image/png'); } catch (e) { rej(e); } });
    if (!blob) throw new Error('no PNG');
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png' };
  } catch { throw new Error(tooLarge(nameHint)); } finally { src.close?.(); }
}
