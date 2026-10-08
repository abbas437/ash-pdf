// Pure helpers for cut/copy/paste of annotation objects (renderer/ui/copytext.js, annotations.js).
// The app keeps its own object clipboard; the system clipboard gets a text/plain summary. Paste
// uses the objects only while the system clipboard still holds exactly that summary, so anything
// copied elsewhere afterwards (text in another app) wins.

/** text/plain stand-in for copied objects: their texts, else a count. */
export function objectsSummary(objs) {
  const texts = objs.map((o) => (typeof o.text === 'string' ? o.text.trim() : '')).filter(Boolean);
  if (texts.length) return texts.join('\n');
  return `${objs.length} object${objs.length === 1 ? '' : 's'} (ASH PDF Studio)`;
}

/** True when the system clipboard text is still what the object copy wrote. */
export function clipboardMatches(stored, systemText) {
  return typeof stored === 'string' && stored !== '' && systemText === stored;
}

/** Union of boxes {x,y,w,h}; null for none. */
export function unionBox(boxes) {
  if (!boxes.length) return null;
  const x0 = Math.min(...boxes.map((b) => b.x)), y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w)), y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Move for pasted objects whose union box is `box` (on page `fromPage`): centred on `target`
 * {page, x, y}, kept inside the target page {width, height}; when that would land exactly on the
 * originals (same page, under 1 pt away) it is shifted by `offset` so the copy stays visible.
 */
export function pasteDelta(box, fromPage, target, pageSize, offset = 12) {
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  const x = clamp(target.x - box.w / 2, 0, pageSize.width - box.w), y = clamp(target.y - box.h / 2, 0, pageSize.height - box.h);
  let dx = x - box.x, dy = y - box.y;
  if (target.page === fromPage && Math.abs(dx) < 1 && Math.abs(dy) < 1) { dx += offset; dy += offset; }
  return { dx, dy };
}

/**
 * Size in page points for an image pasted from the system clipboard: its pixel size at 96 dpi, scaled
 * down (never up) to fit within half the page {width, height}, aspect kept.
 */
export function pastedImageSize(nw, nh, pageSize) {
  const w = Math.max(1, nw) * 0.75, h = Math.max(1, nh) * 0.75;
  const k = Math.min(1, pageSize.width / 2 / w, pageSize.height / 2 / h);
  return { w: w * k, h: h * k };
}
