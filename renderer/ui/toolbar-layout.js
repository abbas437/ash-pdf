// Pure helpers for View > Customize toolbar (no DOM): the default tool groups, cleaning of the stored
// layout (settings key 'toolbar.layout') and the edits the Customize dialog makes. A layout is
//   { groupOrder: [group], order: {group: [item ids]}, hidden: [item ids], compact: [groups] }
// Every function returns a new, complete layout; the input is never changed.

/** Tool groups, left to right: [key, label, item ids]. Pages and View (Split) come early so they are the last to overflow into More. */
export const DEFAULT_GROUPS = Object.freeze([
  ['navigate', 'Navigate', ['select', 'hand']],
  ['pages', 'Pages', ['pages']],
  ['view', 'View', ['split']],
  ['edit', 'Edit', ['text', 'textedit', 'image', 'image-edit', 'whiteout', 'redact', 'forms']],
  ['comment', 'Comment', ['highlight', 'text-highlight', 'underline', 'strikeout', 'squiggly', 'note', 'callout', 'markup', 'draw', 'shapes']],
  ['sign', 'Stamp and sign', ['stamp', 'sign']],
].map((g) => Object.freeze([g[0], g[1], Object.freeze(g[2])])));

/** Items that can never be hidden. */
export const ALWAYS_SHOWN = Object.freeze(['select']);
/** Group left expanded by the global Compact switch. */
export const NEVER_AUTO_COMPACT = 'navigate';
/** Group that receives ids not listed in any group. */
export const FALLBACK_GROUP = 'edit';

const GROUP_KEYS = DEFAULT_GROUPS.map((g) => g[0]);
const KNOWN = new Map(DEFAULT_GROUPS.flatMap(([g, , ids]) => ids.map((id, i) => [id, { group: g, rank: i }])));
const DEFAULT_SEQ = DEFAULT_GROUPS.flatMap((g) => g[2]); // every id in default left-to-right order

export const groupLabel = (key) => DEFAULT_GROUPS.find((g) => g[0] === key)?.[1] ?? key;
export const isKnownItem = (id) => KNOWN.has(id);

export function defaultLayout() {
  return {
    groupOrder: [...GROUP_KEYS],
    order: Object.fromEntries(DEFAULT_GROUPS.map(([g, , ids]) => [g, [...ids]])),
    hidden: [],
    compact: [],
  };
}

const uniq = (a) => [...new Set(a)];
const strings = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []);

/**
 * A stored layout (object or JSON text) made safe: unknown groups and ids are dropped, each id is
 * placed once, Select is never hidden, and groups or ids missing from it (new in a later version)
 * appear in their default place. Anything unreadable gives the default layout.
 */
export function cleanLayout(raw) {
  let v = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return defaultLayout();
  const groupOrder = uniq(strings(v.groupOrder).filter((g) => GROUP_KEYS.includes(g)));
  // New groups go after the group that precedes them by default.
  for (const [i, g] of GROUP_KEYS.entries()) {
    if (groupOrder.includes(g)) continue;
    const prev = GROUP_KEYS.slice(0, i).reverse().find((p) => groupOrder.includes(p));
    groupOrder.splice(prev ? groupOrder.indexOf(prev) + 1 : 0, 0, g);
  }
  const src = v.order && typeof v.order === 'object' && !Array.isArray(v.order) ? v.order : {};
  const placed = new Set();
  const order = {};
  for (const g of groupOrder) {
    order[g] = [];
    for (const id of strings(src[g])) if (KNOWN.has(id) && !placed.has(id)) { placed.add(id); order[g].push(id); }
  }
  for (const id of DEFAULT_SEQ) if (!placed.has(id)) insertDefault(order, id);
  return {
    groupOrder,
    order,
    hidden: uniq(strings(v.hidden).filter((id) => KNOWN.has(id) && !ALWAYS_SHOWN.includes(id))),
    compact: uniq(strings(v.compact).filter((g) => GROUP_KEYS.includes(g))),
  };
}

// A missing id goes into its default group, after the nearest item that precedes it there by default.
function insertDefault(order, id) {
  const { group, rank } = KNOWN.get(id);
  const list = order[group];
  const before = DEFAULT_GROUPS.find((g) => g[0] === group)[2].slice(0, rank).reverse().find((p) => list.includes(p));
  list.splice(before ? list.indexOf(before) + 1 : 0, 0, id);
}

const copy = (l) => ({ groupOrder: [...l.groupOrder], order: Object.fromEntries(Object.entries(l.order).map(([g, a]) => [g, [...a]])), hidden: [...l.hidden], compact: [...l.compact] });

/** {group, index} of an item, or null. Ids no group lists (tools added at run time) go to the end of Edit. */
export function placement(layout, id) {
  for (const g of layout.groupOrder) {
    const i = layout.order[g].indexOf(id);
    if (i >= 0) return { group: g, index: i };
  }
  return KNOWN.has(id) ? null : { group: FALLBACK_GROUP, index: Infinity };
}

export const isHidden = (layout, id) => layout.hidden.includes(id);
export const isCompact = (layout, group) => layout.compact.includes(group);
/** Hideable: not Select, and listed in a group (an id added at run time has no entry to hide). */
export const canHide = (id) => !ALWAYS_SHOWN.includes(id) && KNOWN.has(id);
/** Items that are menus, not tool buttons: they never fold into a compact group. */
const MENU_ITEMS = Object.freeze(['pages', 'split', 'sign']);
/** True when a group holds at least two tool buttons, so Compact can fold it (hidden ones still count). */
export const canFold = (layout, group) => (layout.order[group] ?? []).filter((id) => !MENU_ITEMS.includes(id)).length > 1;

export function setHidden(layout, id, hidden) {
  const l = copy(layout);
  l.hidden = l.hidden.filter((x) => x !== id);
  if (hidden && canHide(id) && KNOWN.has(id)) l.hidden.push(id);
  return l;
}

/** Show (on) or hide every item of a group; Select stays shown. */
export function setGroupShown(layout, group, on) {
  let l = copy(layout);
  for (const id of l.order[group] ?? []) l = setHidden(l, id, !on);
  return l;
}

/** Move an item one place up (-1) or down (+1) inside its group. */
export function moveItem(layout, id, delta) {
  const l = copy(layout);
  const p = placement(l, id);
  if (!p || !Number.isFinite(p.index)) return l;
  const list = l.order[p.group];
  const j = p.index + delta;
  if (j < 0 || j >= list.length) return l;
  [list[p.index], list[j]] = [list[j], list[p.index]];
  return l;
}

/** Move an item to the end of another group. */
export function moveToGroup(layout, id, group) {
  const l = copy(layout);
  const p = placement(l, id);
  if (!p || !Number.isFinite(p.index) || !l.order[group] || p.group === group) return l;
  l.order[p.group].splice(p.index, 1);
  l.order[group].push(id);
  return l;
}

/** Move a whole group one place left (-1) or right (+1). */
export function moveGroup(layout, group, delta) {
  const l = copy(layout);
  const i = l.groupOrder.indexOf(group), j = i + delta;
  if (i < 0 || j < 0 || j >= l.groupOrder.length) return l;
  [l.groupOrder[i], l.groupOrder[j]] = [l.groupOrder[j], l.groupOrder[i]];
  return l;
}

export function setCompact(layout, group, on) {
  const l = copy(layout);
  l.compact = l.compact.filter((g) => g !== group);
  if (on && GROUP_KEYS.includes(group)) l.compact.push(group);
  return l;
}

/** The View menu switch: Compact folds every group except Navigate; Expanded unfolds all. */
export function setAllCompact(layout, on) {
  const l = copy(layout);
  l.compact = on ? GROUP_KEYS.filter((g) => g !== NEVER_AUTO_COMPACT) : [];
  return l;
}

/** 'expanded' | 'compact' | 'custom' for the View menu's check marks. */
export function compactMode(layout) {
  const folded = layout.compact.filter((g) => canFold(layout, g)); // a group that cannot fold is neither on nor off
  if (!folded.length) return 'expanded';
  const want = GROUP_KEYS.filter((g) => g !== NEVER_AUTO_COMPACT && canFold(layout, g));
  return want.every((g) => folded.includes(g)) && !folded.includes(NEVER_AUTO_COMPACT) ? 'compact' : 'custom';
}
