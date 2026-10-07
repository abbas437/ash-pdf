// Pure helpers of viewextras.js (no DOM, no pdf.js), unit-tested in test/viewextras.test.js.
import { parseRanges } from '../../src/core/pdfOps.js';

/**
 * Layer tree from a pdf.js OptionalContentConfig-like object ({getOrder(), getGroup(id)}).
 * getOrder() entries are group ids or {name, order} (a nested /Order array). A nested array
 * without a name belongs to the item before it (PDF 32000 8.11.4.3); a named one is a heading.
 * Returns [{id, name, children}] and [{id: null, name, children}] for headings; [] = no layers.
 */
export function layerTree(cfg) {
  const order = cfg?.getOrder?.() ?? null;
  if (!order) return [];
  const walk = (list) => {
    const out = [];
    for (const item of list) {
      if (typeof item === 'string') {
        const g = cfg.getGroup(item);
        if (g) out.push({ id: item, name: g.name || item, children: [] });
      } else if (item && Array.isArray(item.order)) {
        const children = walk(item.order);
        if (!children.length) continue;
        if (item.name == null && out.length && out[out.length - 1].id) out[out.length - 1].children.push(...children);
        else if (item.name == null) out.push(...children);
        else out.push({ id: null, name: String(item.name), children });
      }
    }
    return out;
  };
  return walk(order);
}

/** All group ids of a layer tree, depth first. */
export function layerIds(tree) {
  return tree.flatMap((n) => [...(n.id ? [n.id] : []), ...layerIds(n.children)]);
}

/**
 * 0-based page indices to print. mode: 'all' | 'current' | 'range' | 'odd' | 'even'
 * (odd/even by page number). Throws RangeError (from parseRanges) for a bad range.
 */
export function printPageIndices({ mode, range, current, count }) {
  const all = Array.from({ length: count }, (_, i) => i);
  switch (mode) {
    case 'current': return [Math.min(Math.max(0, current), count - 1)];
    case 'range': return parseRanges(range ?? '', count);
    case 'odd': return all.filter((i) => i % 2 === 0);
    case 'even': return all.filter((i) => i % 2 === 1);
    default: return all;
  }
}
