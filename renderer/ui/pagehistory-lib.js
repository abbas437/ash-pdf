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

/**
 * Split off the objects with the given ids: `items` are droppedBy-style deep copies with their index
 * (restoreDropped puts them back), `objects` the rest. Used for `res.remove` of a page operation.
 */
export function takeObjects(objects, ids) {
  const gone = new Set(ids);
  const items = objects.flatMap((o, index) => (gone.has(o.id) ? [{ obj: structuredClone(o), index }] : []));
  return { objects: objects.filter((o) => !gone.has(o.id)), items };
}

/**
 * The overlay part of a history entry seen from the opposite stack: what `step` took out (`taken`)
 * comes back next time, and what `objs.restore` brought back goes again.
 */
export const swapObjs = (objs, taken) => ({ restore: taken, remove: objs.restore.map((it) => it.obj.id) });

// ---------------------------------------------------------------- one chronological history per tab
// The annotation history (tab.undo / tab.redo, annotations.js) and the page history (tab.bytesUndo /
// tab.bytesRedo, pagetools.js) keep their own stacks; every entry carries `seq` from one per-tab
// counter, so Undo acts on the newest entry of either kind and Redo on the oldest undone one.
// Annotation entries keep the page numbers of their time: in this strict order every page change made
// after an entry is undone before it (and redone before a later one), so they never need remapping.
const top = (s) => s?.[s.length - 1];
const seqOf = (e) => e?.seq ?? 0;

/** Stamp for a new entry; the redo entries of both kinds go (they no longer follow on). */
export function newEntry(tab) {
  if (tab.redo) tab.redo.length = 0;
  tab.bytesRedo = [];
  tab.historySeq = (tab.historySeq ?? 0) + 1;
  return tab.historySeq;
}

/** Which history the next Undo (dir 'undo') or Redo ('redo') acts on: 'ann' | 'bytes' | null. */
export function nextHistory(tab, dir) {
  const a = top(dir === 'undo' ? tab.undo : tab.redo), b = top(dir === 'undo' ? tab.bytesUndo : tab.bytesRedo);
  if (!a || !b) return a ? 'ann' : b ? 'bytes' : null;
  return (dir === 'undo' ? seqOf(a) > seqOf(b) : seqOf(a) < seqOf(b)) ? 'ann' : 'bytes';
}

/** The entry the next Undo / Redo acts on, or null. */
export function peekHistory(tab, dir) {
  const k = nextHistory(tab, dir);
  if (!k) return null;
  return top(k === 'ann' ? (dir === 'undo' ? tab.undo : tab.redo) : (dir === 'undo' ? tab.bytesUndo : tab.bytesRedo));
}

/**
 * The page history dropped `gone` (its cap): annotation undo entries older than it go too, as their page
 * numbers belong to the document before that change, which can no longer be brought back.
 */
export function dropOlderThan(tab, gone) {
  if (tab.undo && gone) tab.undo.splice(0, tab.undo.length, ...tab.undo.filter((e) => seqOf(e) > seqOf(gone)));
}

/**
 * Drop the page history (a full save made a redaction final): annotation entries that only an undo of a
 * dropped page entry could reach go with it (undo entries older than the newest one, and the redo entries).
 */
export function clearBytesHistory(tab) {
  dropOlderThan(tab, top(tab.bytesUndo));
  if (tab.bytesRedo?.length && tab.redo) tab.redo.length = 0;
  tab.bytesUndo = [];
  tab.bytesRedo = [];
}
