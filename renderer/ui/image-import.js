// Pictures in any common format, ready to place on a page or make a page of: PNG and JPEG pass
// through unchanged; GIF (first frame), WebP, BMP and SVG are drawn on a canvas and re-encoded as
// PNG (transparency kept). SVG is drawn at twice its intrinsic size, longest side at most 4000 px,
// 1000 px square when it has no size. Unknown or undecodable files throw an Error with a user message.
import { detectImage, unsupportedImage, svgRasterSize } from './image-import-lib.js';

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
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(src, 0, 0, width, height);
  src.close?.();
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  if (!blob) throw new Error(unsupportedImage(nameHint));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png' };
}
