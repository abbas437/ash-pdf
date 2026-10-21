// Group / Ungroup of selected objects and the group resize (renderer/ui/annotations.js): pure parts.
//   canGroup(objs, readOnly) / canUngroup(objs, readOnly) -> bool
//   groupPatches(objs, id) / ungroupPatches(objs) -> Map<id, patch> (one updateMany = one undo step)
//   soleGroup(objs) -> group id when objs are exactly one group (>= 2 members, one page), else null
//   groupResizeBox(box, handle, dx, dy, keepAspect) -> the dragged group box (never flips)
//   scaleMember(o, from, to, def) -> patch mapping object o from box `from` to box `to`
// Signature blocks (objects with `sig`) keep their group: they are never regrouped or ungrouped.

const MIN_SIDE = 1; // points: a group box is never dragged smaller than this

const hasSig = (objs) => objs.some((o) => o.sig);

/** Group needs 2+ objects, none of a signature block, not already exactly one group. */
export function canGroup(objs, readOnly = false) {
  if (readOnly || objs.length < 2 || hasSig(objs)) return false;
  const g = objs[0].group;
  return !(g && objs.every((o) => o.group === g));
}
export function canUngroup(objs, readOnly = false) {
  return !readOnly && !hasSig(objs) && objs.some((o) => o.group);
}
export function groupPatches(objs, id) {
  return new Map(objs.map((o) => [o.id, { group: id }]));
}
export function ungroupPatches(objs) {
  return new Map(objs.filter((o) => o.group).map((o) => [o.id, { group: undefined }]));
}
export function soleGroup(objs) {
  if (objs.length < 2) return null;
  const { group, page } = objs[0];
  return group && objs.every((o) => o.group === group && o.page === page) ? group : null;
}

/** Box after dragging `handle` by (dx, dy): the opposite edge / corner stays; keepAspect (corners) scales uniformly. */
export function groupResizeBox(b, handle, dx, dy, keepAspect = false) {
  const W = handle.includes('w'), E = handle.includes('e'), N = handle.includes('n'), S = handle.includes('s');
  let w = b.w + (E ? dx : W ? -dx : 0), h = b.h + (S ? dy : N ? -dy : 0);
  if (keepAspect && (W || E) && (N || S) && b.w > 0 && b.h > 0) {
    const s = Math.max(w / b.w, h / b.h);
    w = b.w * s; h = b.h * s;
  }
  w = Math.max(w, MIN_SIDE); h = Math.max(h, MIN_SIDE);
  return { x: W ? b.x + b.w - w : b.x, y: N ? b.y + b.h - h : b.y, w, h };
}

/**
 * Patch that maps o (as it was when the drag started) from group box `from` to `to`. `def` is the
 * object's type: fixed types (text markups) stay; types without handles (note icons) only move,
 * their bbox centre following the scale; end points and point lists scale; boxes scale their
 * position and size, and objects with text resize through the type's own `resize` (se handle, the
 * scaled size as the delta), so a text box keeps at least its text's height. Stroke widths and
 * font sizes are left alone.
 */
export function scaleMember(o, from, to, def) {
  if (def.fixed) return {};
  const sx = from.w > 0 ? to.w / from.w : 1, sy = from.h > 0 ? to.h / from.h : 1;
  const X = (x) => to.x + (x - from.x) * sx, Y = (y) => to.y + (y - from.y) * sy;
  if (!def.handles?.(o)?.length) {
    const b = def.bbox(o), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    return def.move(o, X(cx) - cx, Y(cy) - cy);
  }
  if (Number.isFinite(o.x1)) return { x1: X(o.x1), y1: Y(o.y1), x2: X(o.x2), y2: Y(o.y2) };
  if (Array.isArray(o.points)) return { points: o.points.map(([x, y]) => [X(x), Y(y)]) };
  const tip = Number.isFinite(o.tx) && Number.isFinite(o.ty) ? { tx: X(o.tx), ty: Y(o.ty) } : {};
  const w = o.w * sx, h = o.h * sy;
  const size = typeof o.text === 'string' ? def.resize(o, 'se', w - o.w, h - o.h) : { w, h };
  return { ...size, x: X(o.x), y: Y(o.y), ...tip };
}
