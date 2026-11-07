// Bookmarks (/Outlines) and AcroForm fields across page copies and page removals, for pdfOps.js.
// pdf-lib's copyPages copies page dictionaries only: the source outline is left behind and the
// copied widgets are not registered in the target's /AcroForm /Fields. removePage leaves
// bookmarks to the removed page and its widgets in /Fields. These helpers repair both.
import { PDFName, PDFDict, PDFArray, PDFRef, PDFString, PDFHexString, PDFNumber, PDFNull, PDFBool, PDFObjectCopier } from 'pdf-lib';

const N = (s) => PDFName.of(s);

function get(dict, key, Type) {
  const v = dict.lookup(N(key));
  return v instanceof Type ? v : undefined;
}

function textOf(obj) {
  return obj instanceof PDFString || obj instanceof PDFHexString || obj instanceof PDFName ? obj.decodeText() : null;
}

const isWidget = (d) => d.lookup(N('Subtype')) === N('Widget');

// ------------------------------------------------------------------ destinations

/** Named destinations of `doc`: the /Names /Dests name tree and the PDF 1.1 catalog /Dests dict. */
function namedDests(doc) {
  const tree = new Map();
  const seen = new Set();
  const walk = (node) => {
    if (!(node instanceof PDFDict) || seen.has(node)) return;
    seen.add(node);
    const names = get(node, 'Names', PDFArray);
    for (let i = 0; names && i + 1 < names.size(); i += 2) {
      const k = textOf(names.lookup(i));
      if (k !== null && !tree.has(k)) tree.set(k, names.get(i + 1));
    }
    const kids = get(node, 'Kids', PDFArray);
    for (let i = 0; kids && i < kids.size(); i++) walk(kids.lookup(i));
  };
  const names = get(doc.catalog, 'Names', PDFDict);
  if (names) walk(get(names, 'Dests', PDFDict));
  return { tree, dict: get(doc.catalog, 'Dests', PDFDict) };
}

/** The raw destination of an outline item: /Dest, or /D of a /GoTo action. */
function itemDest(dict) {
  const d = dict.get(N('Dest'));
  if (d !== undefined) return d;
  const a = get(dict, 'A', PDFDict);
  return a && a.lookup(N('S')) === N('GoTo') ? a.get(N('D')) : undefined;
}

/** {array, page} for an explicit or named destination whose first element is a page ref; else null. */
function resolveDest(ctx, nd, d) {
  let v = ctx.lookup(d);
  const key = textOf(v);
  if (key !== null) {
    let t = v instanceof PDFName ? nd.dict?.get(v) ?? nd.tree.get(key) : nd.tree.get(key) ?? nd.dict?.get(N(key));
    if (t === undefined) return null;
    v = ctx.lookup(t);
  }
  if (v instanceof PDFDict) v = ctx.lookup(v.get(N('D')));
  if (!(v instanceof PDFArray) || v.size() === 0) return null;
  const page = v.get(0);
  return page instanceof PDFRef ? { array: v, page } : null;
}

const destPage = (ctx, nd, dict) => {
  const d = itemDest(dict);
  return d === undefined ? null : resolveDest(ctx, nd, d);
};

// ------------------------------------------------------------------ outline tree

/** Children of an outline node (root or item) as [{ref, dict, open, kids}], cycle-safe. */
function readOutline(ctx, parent, seen = new Set()) {
  const out = [];
  let ref = parent.get(N('First'));
  while (ref !== undefined) {
    const dict = ctx.lookup(ref);
    if (!(dict instanceof PDFDict) || seen.has(dict)) break;
    seen.add(dict);
    const count = dict.lookup(N('Count'));
    out.push({
      ref: ref instanceof PDFRef ? ref : ctx.register(dict),
      dict,
      open: !(count instanceof PDFNumber && count.asNumber() < 0),
      kids: readOutline(ctx, dict, seen),
    });
    ref = dict.get(N('Next'));
  }
  return out;
}

/** Write /Parent /First /Last /Prev /Next /Count for `nodes` under `parent`; returns the visible-item count. */
function linkOutline(parent, parentRef, nodes) {
  const set = (d, k, v) => (v === undefined ? d.delete(N(k)) : d.set(N(k), v));
  set(parent, 'First', nodes[0]?.ref);
  set(parent, 'Last', nodes[nodes.length - 1]?.ref);
  let visible = nodes.length;
  nodes.forEach((n, k) => {
    n.dict.set(N('Parent'), parentRef);
    set(n.dict, 'Prev', nodes[k - 1]?.ref);
    set(n.dict, 'Next', nodes[k + 1]?.ref);
    const sub = linkOutline(n.dict, n.ref, n.kids);
    set(n.dict, 'Count', n.kids.length ? PDFNumber.of(n.open ? sub : -sub) : undefined);
    if (n.open) visible += sub;
  });
  return visible;
}

function writeRoot(root, rootRef, nodes) {
  const visible = linkOutline(root, rootRef, nodes);
  if (visible) root.set(N('Count'), PDFNumber.of(visible));
  else root.delete(N('Count'));
}

function clearDest(ctx, dict) {
  dict.delete(N('Dest'));
  const a = get(dict, 'A', PDFDict);
  if (a && a.lookup(N('S')) === N('GoTo')) dict.delete(N('A'));
}

/**
 * Follow page replacements/removals in `doc`'s own outline. pageMap: Map<old page ref, new page ref | null>.
 * An item whose page maps to a ref gets an explicit /Dest to it; to null it is removed (kept as a
 * container without a destination if any of its children remain). Items on other pages are untouched.
 */
export function retargetOutline(doc, pageMap) {
  const ctx = doc.context;
  const root = get(doc.catalog, 'Outlines', PDFDict);
  if (!root || !pageMap.size) return;
  const nd = namedDests(doc);
  let removed = false;
  const filter = (nodes) => nodes.flatMap((n) => {
    n.kids = filter(n.kids);
    const r = destPage(ctx, nd, n.dict);
    if (!r || !pageMap.has(r.page)) return [n];
    const to = pageMap.get(r.page);
    if (to) {
      clearDest(ctx, n.dict);
      n.dict.set(N('Dest'), ctx.obj([to, ...r.array.asArray().slice(1)]));
      return [n];
    }
    removed = true;
    if (n.kids.length) { clearDest(ctx, n.dict); return [n]; }
    return [];
  });
  const nodes = filter(readOutline(ctx, root));
  if (removed) writeRoot(root, doc.catalog.get(N('Outlines')), nodes);
}

function clonePrim(v) {
  if (v instanceof PDFNumber) return PDFNumber.of(v.asNumber());
  if (v instanceof PDFName) return v;
  return PDFNull;
}

/**
 * Carry `src`'s outline items whose destination page was copied into `dest`.
 * pageMap: Map<src page ref, dest page ref>. Items keep title, /C, /F, nesting and open state;
 * an item whose page was not copied is dropped, or kept as a container without /Dest when some of its
 * children are kept. An item with no local page destination (URI, Launch, GoToR, JavaScript, Named
 * action, title only) is kept with its /A deep-copied. Destinations become explicit [destPage ...] arrays. The new items go into
 * dest's top level before the first existing item that targets a page at or after `after` (a dest
 * page index), or at the end when `after` is undefined or no such item exists.
 */
export function carryOutline(dest, src, pageMap, after) {
  const sctx = src.context;
  const dctx = dest.context;
  const sroot = get(src.catalog, 'Outlines', PDFDict);
  if (!sroot) return;
  const nd = namedDests(src);
  let copier;
  const build = (nodes) => nodes.flatMap((n) => {
    const kids = build(n.kids);
    const r = destPage(sctx, nd, n.dict);
    const to = r && pageMap.get(r.page);
    // An item that points at no page of the source (URI, Launch, GoToR, JavaScript, Named action, or
    // title only) is kept; one whose local page destination was not copied goes, unless it has kept kids.
    const a = get(n.dict, 'A', PDFDict);
    const sd = n.dict.lookup(N('Dest'));
    const local = r !== null || (a && a.lookup(N('S')) === N('GoTo')) || (sd !== undefined && !(sd instanceof PDFArray));
    const otherDest = !r && sd instanceof PDFArray;
    if (!to && !kids.length && local && !otherDest) return [];
    const dict = dctx.obj({});
    const title = n.dict.lookup(N('Title'));
    if (title instanceof PDFString || title instanceof PDFHexString) dict.set(N('Title'), title.clone());
    const c = get(n.dict, 'C', PDFArray);
    const rgb = c ? c.asArray().map((x) => sctx.lookup(x)) : [];
    if (rgb.length === 3 && rgb.every((x) => x instanceof PDFNumber)) dict.set(N('C'), dctx.obj(rgb.map(clonePrim)));
    const f = get(n.dict, 'F', PDFNumber);
    if (f) dict.set(N('F'), clonePrim(f));
    if (!r) {
      copier ??= PDFObjectCopier.for(sctx, dctx);
      if (a && a.lookup(N('S')) !== N('GoTo')) dict.set(N('A'), copier.copy(a));
      if (otherDest) dict.set(N('Dest'), copier.copy(sd));
    }
    if (to) dict.set(N('Dest'), dctx.obj([to, ...r.array.asArray().slice(1).map((x) => clonePrim(sctx.lookup(x)))]));
    return [{ ref: dctx.register(dict), dict, open: n.open, kids }];
  });
  const items = build(readOutline(sctx, sroot));
  if (!items.length) return;
  let root = get(dest.catalog, 'Outlines', PDFDict);
  let rootRef = dest.catalog.get(N('Outlines'));
  if (!root) {
    root = dctx.obj({ Type: 'Outlines' });
    rootRef = dctx.register(root);
    dest.catalog.set(N('Outlines'), rootRef);
  } else if (!(rootRef instanceof PDFRef)) {
    rootRef = dctx.register(root);
    dest.catalog.set(N('Outlines'), rootRef);
  }
  const existing = readOutline(dctx, root);
  let pos = existing.length;
  if (after !== undefined) {
    const index = new Map(dest.getPages().map((p, i) => [p.ref, i]));
    const dnd = namedDests(dest);
    const k = existing.findIndex((n) => (index.get(destPage(dctx, dnd, n.dict)?.page) ?? -1) >= after);
    if (k >= 0) pos = k;
  }
  existing.splice(pos, 0, ...items);
  writeRoot(root, rootRef, existing);
}

// ------------------------------------------------------------------ AcroForm fields

/** Map<widget dict, ref> of the widget annotations on `pages` (PDFPage[]). */
function pageWidgets(pages) {
  const out = new Map();
  for (const p of pages) {
    const annots = get(p.node, 'Annots', PDFArray);
    for (let i = 0; annots && i < annots.size(); i++) {
      const a = annots.lookup(i);
      if (a instanceof PDFDict && isWidget(a)) out.set(a, annots.get(i));
    }
  }
  return out;
}

/**
 * Remove from the field tree under `node` the widgets for which drop(widget) is true, and any field
 * left without kids. Returns false when `node` itself goes.
 */
function pruneField(ctx, node, drop, seen) {
  const kids = get(node, 'Kids', PDFArray);
  if (!kids) return !(isWidget(node) && drop(node));
  if (seen.has(node)) return true;
  seen.add(node);
  const keep = [];
  const kept = [];
  for (let i = 0; i < kids.size(); i++) {
    const kd = kids.lookup(i);
    if (!(kd instanceof PDFDict) || pruneField(ctx, kd, drop, seen)) { keep.push(kids.get(i)); kept.push(i); }
  }
  if (keep.length === kids.size()) return true;
  if (!keep.length) return false;
  // A radio group's /Opt export values are positional, one per kid: pdf-lib's select() reads them that way.
  const opt = get(node, 'Opt', PDFArray);
  if (opt && opt.size() === kids.size()) node.set(N('Opt'), ctx.obj(kept.map((i) => opt.get(i))));
  node.set(N('Kids'), ctx.obj(keep));
  return true;
}

/**
 * After pages were removed from `doc`: drop their widgets from /AcroForm /Fields (and emptied
 * parents), unless also on one of `remainingPages` (passed in: pdf-lib's removePage leaves
 * doc.getPages() stale).
 */
export function dropFieldsOf(doc, removedPages, remainingPages) {
  const af = get(doc.catalog, 'AcroForm', PDFDict);
  const fields = af && get(af, 'Fields', PDFArray);
  if (!fields) return;
  const gone = pageWidgets(removedPages);
  if (!gone.size) return;
  const still = pageWidgets(remainingPages);
  const drop = (w) => gone.has(w) && !still.has(w);
  const ctx = doc.context;
  const seen = new Set();
  const keep = [];
  for (let i = 0; i < fields.size(); i++) {
    const f = fields.lookup(i);
    if (!(f instanceof PDFDict) || pruneField(ctx, f, drop, seen)) keep.push(fields.get(i));
  }
  if (keep.length !== fields.size()) af.set(N('Fields'), ctx.obj(keep));
}

/**
 * Register in `dest`'s /AcroForm /Fields the fields of the widgets on `copiedPages` (PDFPage[] just
 * copied from `src`). Each widget's top-level field is added once, its tree pruned to the copied
 * widgets; a top-level name already used in dest gets a "_2" (or "_3"...) suffix. Creates /AcroForm
 * when dest has none; copies /DA when dest has none and the /DR fonts dest lacks; sets
 * /NeedAppearances only when the source has it. /XFA is removed, as pdf-lib's form API does.
 */
export function carryFields(dest, src, copiedPages) {
  const ctx = dest.context;
  const widgets = new Map();
  for (const p of copiedPages) {
    for (const [w, ref] of pageWidgets([p])) {
      widgets.set(w, ref);
      if (w.has(N('P'))) w.set(N('P'), p.ref);
    }
  }
  const tops = [];
  const topSeen = new Set();
  for (const [w, ref] of widgets) {
    let d = w;
    let r = ref;
    const chain = new Set([d]);
    for (;;) {
      const pr = d.get(N('Parent'));
      const p = ctx.lookup(pr);
      if (!(p instanceof PDFDict) || chain.has(p)) break;
      chain.add(p);
      d = p;
      r = pr;
    }
    if (r instanceof PDFRef && d.has(N('T')) && !topSeen.has(d)) {
      topSeen.add(d);
      tops.push({ dict: d, ref: r });
    }
  }
  if (!tops.length) return;
  const sAf = get(src.catalog, 'AcroForm', PDFDict);
  let af = get(dest.catalog, 'AcroForm', PDFDict);
  if (!af) {
    af = ctx.obj({ Fields: [] });
    dest.catalog.set(N('AcroForm'), ctx.register(af));
  }
  if (sAf) {
    const da = sAf.lookup(N('DA'));
    if (!af.has(N('DA')) && (da instanceof PDFString || da instanceof PDFHexString)) af.set(N('DA'), da.clone());
    const sDr = get(sAf, 'DR', PDFDict);
    const sFonts = sDr && get(sDr, 'Font', PDFDict);
    if (sFonts) {
      let dr = get(af, 'DR', PDFDict);
      if (!dr) { dr = ctx.obj({}); af.set(N('DR'), dr); }
      let fonts = get(dr, 'Font', PDFDict);
      if (!fonts) { fonts = ctx.obj({}); dr.set(N('Font'), fonts); }
      const copier = PDFObjectCopier.for(src.context, ctx);
      for (const [name, v] of sFonts.entries()) if (!fonts.has(name)) fonts.set(name, copier.copy(v));
    }
    if (sAf.lookup(N('NeedAppearances')) === PDFBool.True) af.set(N('NeedAppearances'), PDFBool.True);
  }
  af.delete(N('XFA'));
  let fields = get(af, 'Fields', PDFArray);
  if (!fields) { fields = ctx.obj([]); af.set(N('Fields'), fields); }
  const names = new Set();
  for (let i = 0; i < fields.size(); i++) {
    const f = fields.lookup(i);
    const t = f instanceof PDFDict ? textOf(f.lookup(N('T'))) : null;
    if (t !== null) names.add(t);
  }
  const seen = new Set();
  for (const { dict, ref } of tops) {
    pruneField(ctx, dict, (w) => !widgets.has(w), seen);
    const name = textOf(dict.lookup(N('T')));
    if (name !== null && names.has(name)) {
      let k = 2;
      while (names.has(`${name}_${k}`)) k++;
      dict.set(N('T'), PDFHexString.fromText(`${name}_${k}`));
      names.add(`${name}_${k}`);
    } else if (name !== null) names.add(name);
    fields.push(ref);
  }
}

/** Map<src page ref, dest page ref> for pages copied from src indices `srcIndices` (first copy wins). */
export function copiedPageMap(src, srcIndices, copied) {
  const map = new Map();
  srcIndices.forEach((si, k) => {
    const r = src.getPage(si).ref;
    if (!map.has(r)) map.set(r, copied[k].ref);
  });
  return map;
}
