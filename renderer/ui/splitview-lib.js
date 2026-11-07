// Pure pane-assignment rules of splitview.js (no DOM), unit-tested in test/splitview.test.js.
// A split is {ids: [pane 0 tab id, pane 1 tab id], focus: 0 | 1}; pane 0 is left / top. Both panes
// are equal: the focused pane is the one the tab strip and the tools act on. `recent` lists tab ids,
// most recently active first.

/** Orientations ('v': side by side, 'h': stacked) and the range the divider can be dragged to. */
export const SPLIT_DIRS = ['v', 'h'];
export const SPLIT_RATIO_MIN = 0.15;
export const SPLIT_RATIO_MAX = 0.85;
export const clampRatio = (r) => Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, r));

/** Most recently active first, then the rest in strip order; only open ids, without `except`. */
const byRecency = (openIds, recent, except) =>
  [...recent.filter((id) => openIds.includes(id)), ...openIds.filter((id) => !recent.includes(id))].filter((id) => id !== except);

/**
 * The pair for the plain Split command: the active document (left / top) and the previously
 * active one; with one document open, that document twice. null when nothing is open.
 */
export function defaultPair(activeId, openIds, recent = []) {
  if (!openIds.length) return null;
  const a = openIds.includes(activeId) ? activeId : openIds[0];
  return [a, byRecency(openIds, recent, a)[0] ?? a];
}

/**
 * A tab chosen in the tab strip: a tab already shown in a pane focuses that pane; any other tab
 * replaces the focused pane's document.
 */
export function chooseTab({ ids, focus }, id) {
  if (ids[focus] === id) return { ids: [...ids], focus };
  if (ids[1 - focus] === id) return { ids: [...ids], focus: 1 - focus };
  const next = [...ids];
  next[focus] = id;
  return { ids: next, focus };
}

/**
 * A document picked in pane k's header: the pane shows it and takes the focus. When that makes the
 * same document show twice, the focus stays with the pane that already showed it (its view stays put).
 */
export function pickForPane({ ids, focus }, k, id) {
  const next = [...ids];
  next[k] = id;
  return { ids: next, focus: ids[0] !== ids[1] && ids[1 - k] === id ? 1 - k : k };
}

/**
 * A tab closed (openIds: the tabs still open). Each pane showing it gets the most recently active
 * open document not shown in the other pane; null when there is none (the split closes).
 */
export function closeTabIn({ ids, focus }, closedId, openIds, recent = []) {
  if (!ids.includes(closedId)) return { ids: [...ids], focus };
  if (ids[0] === ids[1]) {
    const pick = byRecency(openIds, recent, closedId)[0];
    return pick ? { ids: [pick, pick], focus } : null;
  }
  const k = ids.indexOf(closedId);
  const pick = byRecency(openIds, recent, closedId).find((id) => id !== ids[1 - k]);
  if (!pick) return null;
  const next = [...ids];
  next[k] = pick;
  return { ids: next, focus };
}

// ---- "Scroll and zoom together": page-relative scroll sync between the two panes.
// A pane's layout is {tops, heights, lefts, widths} (page boxes in its scroll content, CSS px) and
// its client size; the two documents may differ in page sizes and page count, so the sync maps by
// page index and fraction of the page, never by raw pixels.

/**
 * Where scroll offset `top` falls: {page, fy, gap}. Each page owns the space from halfway up the gap
 * above it to halfway down the gap below it; fy is the fraction (0..1) of the page at `top`, gap the
 * px above (< 0) or below (> 0) the page when `top` is in a gap. Before the first page: page 0.
 */
export function pageAt({ tops, heights }, top) {
  let i = 0;
  for (let k = 1; k < tops.length; k++) {
    if (top >= (tops[k - 1] + heights[k - 1] + tops[k]) / 2) i = k;
    else break;
  }
  const t = tops[i], hgt = heights[i];
  if (top < t) return { page: i, fy: 0, gap: top - t };
  if (top > t + hgt) return { page: i, fy: 1, gap: top - t - hgt };
  return { page: i, fy: hgt > 0 ? (top - t) / hgt : 0, gap: 0 };
}

/**
 * The scroll offset showing position {page, fy, gap} in layout `dst`. A page past the last one
 * clamps to the end of the last page.
 */
export function topFor({ page, fy, gap }, { tops, heights }) {
  const n = tops.length;
  if (!n) return 0;
  if (page > n - 1) return tops[n - 1] + heights[n - 1];
  return tops[page] + fy * heights[page] + gap;
}

/**
 * Sync pane `dst` to pane `src` (each {tops, heights, lefts, widths, clientWidth}; src also
 * {scrollTop, scrollLeft}): {top, left, page} for dst. Vertically: the same page at the same fraction
 * of its height at the top of the pane. Horizontally: the same fraction of the page width at the pane's
 * centre line.
 */
export function syncScroll(src, dst) {
  const pos = pageAt(src, src.scrollTop);
  const top = topFor(pos, dst);
  const i = pos.page, j = Math.min(pos.page, dst.tops.length - 1);
  const fx = src.widths[i] > 0 ? (src.scrollLeft + src.clientWidth / 2 - src.lefts[i]) / src.widths[i] : 0.5;
  const left = dst.lefts[j] + fx * dst.widths[j] - dst.clientWidth / 2;
  return { top, left: Math.max(0, left), page: j };
}

/** The zoom to give the other pane: a fit mode is shared as the mode, a custom zoom as its factor. */
export const zoomToSync = ({ zoomMode, zoom }) => (zoomMode === 'custom' ? zoom : zoomMode);
