// Image fixtures for the e2e tests, drawn with @napi-rs/canvas (a devDependency) instead of sharp.
import { createCanvas, loadImage } from '@napi-rs/canvas';

const css = ({ r, g, b, alpha = 1 }) => `rgba(${r}, ${g}, ${b}, ${alpha})`;

/**
 * A w x h image filled with `background` ({ r, g, b, alpha? }; null leaves it transparent), with each of `rects`
 * ({ left, top, width, height, color }) painted on top. Returns PNG bytes, or JPEG with { jpeg: quality 0-100 }.
 */
export function image(w, h, background, rects = [], { jpeg } = {}) {
  const c = createCanvas(w, h), ctx = c.getContext('2d');
  if (background) { ctx.fillStyle = css(background); ctx.fillRect(0, 0, w, h); }
  for (const { left, top, width, height, color } of rects) { ctx.fillStyle = css(color); ctx.fillRect(left, top, width, height); }
  return jpeg === undefined ? c.toBuffer('image/png') : c.toBuffer('image/jpeg', jpeg);
}

/** Decodes PNG/JPEG bytes to { data: RGBA bytes, info: { width, height, channels: 4 } }. */
export async function rgba(bytes) {
  const img = await loadImage(bytes), c = createCanvas(img.width, img.height), ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return { data: ctx.getImageData(0, 0, img.width, img.height).data, info: { width: img.width, height: img.height, channels: 4 } };
}
