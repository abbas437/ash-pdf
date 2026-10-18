// Pure helpers for the tab strip (no DOM).

/** Moves the item at `from` so it ends up at index `to`, in place. Out-of-range indices are clamped; returns the array. */
export function moveItem(arr, from, to) {
  if (!Number.isInteger(from) || from < 0 || from >= arr.length) return arr;
  const dest = Math.max(0, Math.min(arr.length - 1, Number.isInteger(to) ? to : from));
  if (dest === from) return arr;
  arr.splice(dest, 0, arr.splice(from, 1)[0]);
  return arr;
}

/** Insertion slot (0..n) for a pointer at `x` over tabs with the given horizontal centres. */
export function dropSlot(centres, x) {
  let s = 0;
  while (s < centres.length && centres[s] < x) s++;
  return s;
}

/** Final index of the dragged tab (`from`) when dropped into insertion slot `slot`. */
export const slotToIndex = (from, slot) => (slot > from ? slot - 1 : slot);

/**
 * The tabs a "Close …" command from the tab strip's context menu closes, in strip order.
 * `which`: 'this' | 'others' | 'left' | 'right' | 'all'; `ids` the strip order, `id` the tab right-clicked.
 * An unknown id closes nothing (except 'all').
 */
export function tabsToClose(ids, id, which) {
  const k = ids.indexOf(id);
  if (which === 'all') return [...ids];
  if (k < 0) return [];
  if (which === 'this') return [id];
  if (which === 'others') return ids.filter((x) => x !== id);
  if (which === 'left') return ids.slice(0, k);
  if (which === 'right') return ids.slice(k + 1);
  return [];
}
