// Pure helpers for the page-operation undo stack (pagetools.js). A page map is
// Map<oldIndex, newIndex|null>: null = the page is gone, pages the operation inserted have no key.
// Annotation objects on a page the map removes are dropped by annotations.remapPages; the history
// entry keeps deep copies of them so the Undo (or Redo) that brings the page back brings them back.

const range = (n) => Array.from({ length: n }, (_, i) => i);

/** Inverse of an old→new page map, for a document that now has `newCount` pages (inserted pages → null). */
export function invertMap(map, newCount) {
  const inv = new Map(range(newCount).map((i) => [i, null]));
  for (const [o, nw] of map) if (nw != null) inv.set(nw, o);
  return inv;
}

/** Deep copies of the objects `map` removes (their page maps to null), with their index in `objects`. */
export function droppedBy(objects, map) {
  return objects.flatMap((o, index) => (map.has(o.page) && map.get(o.page) == null ? [{ obj: structuredClone(o), index }] : []));
}

/**
 * `objects` with the `items` of droppedBy put back at their former indices (so the stacking order
 * comes back too). Ids already present are skipped; the items are copied, never shared.
 */
export function restoreDropped(objects, items) {
  const out = [...objects], have = new Set(out.map((o) => o.id));
  for (const it of [...items].sort((a, b) => a.index - b.index)) {
    if (have.has(it.obj.id)) continue;
    out.splice(Math.min(it.index, out.length), 0, structuredClone(it.obj));
    have.add(it.obj.id);
  }
  return out;
}
