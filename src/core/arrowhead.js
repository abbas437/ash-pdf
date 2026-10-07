// Callout leader arrowhead geometry, shared by the on-screen callout (renderer/ui/tools-callout.js)
// and the saved PDF (src/core/annotate.js) so both draw the same head. Pure: no pdf-lib, no DOM.

/**
 * Filled arrowhead for a leader from (x1,y1) to the tip (x2,y2), in visible page points (y down).
 * Head length is max(6, 4 x stroke width) capped at the leader length; half-width is 0.4 x length.
 * Returns null for a zero-length leader, else the triangle (tip, left, right) and `shaftEnd`, the
 * point the line should stop at so a thick stroke never pokes past the tip.
 */
export function calloutArrowHead(x1, y1, x2, y2, strokeWidth = 1) {
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
  if (!(len > 0)) return null;
  const ux = dx / len, uy = dy / len;
  const hl = Math.min(Math.max(6, strokeWidth * 4), len), hw = hl * 0.4;
  const bx = x2 - ux * hl, by = y2 - uy * hl;
  return {
    tip: { x: x2, y: y2 },
    left: { x: bx - uy * hw, y: by + ux * hw },
    right: { x: bx + uy * hw, y: by - ux * hw },
    shaftEnd: { x: x2 - ux * hl * 0.5, y: y2 - uy * hl * 0.5 },
  };
}
