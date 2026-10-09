// Pure helpers for the signature library (renderer/ui/signatures.js); no DOM, importable in Node.
//   encryptBytes / decryptBytes: optional password lock of a stored signature image.
//     PBKDF2-SHA256 (310,000 iterations) derives an AES-256-GCM key; salt (16 B) and iv (12 B)
//     are random per encryption and kept, base64, in the item's meta (`lock`).
//   removeBackground: makes near-white pixels of an RGBA buffer transparent and returns the
//     bounding box of what is left (the ink), for imported scans and photos.
export const PBKDF2_ITERATIONS = 310_000;

const subtle = () => globalThis.crypto.subtle;
const b64 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(password, salt, iterations) {
  const base = await subtle().importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Encrypt `bytes` with `password`; returns {lock: {alg, iter, salt, iv}, data: Uint8Array}. */
export async function encryptBytes(bytes, password) {
  if (typeof password !== 'string' || !password) throw new TypeError('password required');
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
  const data = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, bytes));
  return { lock: { alg: 'PBKDF2-SHA256/AES-256-GCM', iter: PBKDF2_ITERATIONS, salt: b64(salt), iv: b64(iv) }, data };
}

export class WrongPasswordError extends Error {
  constructor() { super('Wrong password'); this.name = 'WrongPasswordError'; }
}

/** Decrypt data written by encryptBytes. A wrong password (GCM tag mismatch) throws WrongPasswordError. */
export async function decryptBytes(lock, data, password) {
  const key = await deriveKey(String(password ?? ''), unb64(lock.salt), lock.iter);
  try {
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: unb64(lock.iv) }, key, data));
  } catch {
    throw new WrongPasswordError();
  }
}

/**
 * Background removal for an RGBA buffer (modified in place). A pixel whose darkest channel is
 * at least `threshold` (0-255) is background: alpha 0. Pixels just below it fade linearly over
 * `soft` levels so the ink edges stay smooth. Returns the ink bounding box {x, y, w, h} (alpha
 * > 8), or null when nothing is left.
 */
export function removeBackground(rgba, width, height, threshold = 200, soft = 24) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const k = (y * width + x) * 4;
      const m = Math.min(rgba[k], rgba[k + 1], rgba[k + 2]);
      if (m >= threshold) rgba[k + 3] = 0;
      else if (soft > 0 && m > threshold - soft) rgba[k + 3] = Math.round((rgba[k + 3] * (threshold - m)) / soft);
      if (rgba[k + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Date text for the signature block. */
export const DATE_FORMATS = ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'D MMMM YYYY'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function formatDate(iso, fmt) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const p = (n) => String(n).padStart(2, '0');
  switch (fmt) {
    case 'DD/MM/YYYY': return `${p(d)}/${p(m)}/${y}`;
    case 'MM/DD/YYYY': return `${p(m)}/${p(d)}/${y}`;
    case 'D MMMM YYYY': return `${d} ${MONTHS[m - 1]} ${y}`;
    default: return `${y}-${p(m)}-${p(d)}`;
  }
}

/** Page indices for "Place on pages": mode all | odd | even | range (uses parseRanges for range). */
export function targetPages(mode, numPages, rangeIndices = []) {
  const all = Array.from({ length: numPages }, (_, i) => i);
  if (mode === 'odd') return all.filter((i) => i % 2 === 0);
  if (mode === 'even') return all.filter((i) => i % 2 === 1);
  if (mode === 'range') return rangeIndices;
  return all;
}

const overlaps = (a, b) => !!a && !!b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/**
 * What "Apply signature" burns besides `core` (the selected signatures with their block groups).
 * `objects` is the tab's object list in z-order (later = drawn on top); overlays always draw above
 * page content, so any object below a burned one that overlaps it would end up drawn over it.
 * Whiteout below and overlapping is burned with it (`auto`: save burns whiteout anyway); any other
 * such object `canBurn` accepts is `covering` (the user confirms it). Covering objects are burned
 * too, so what lies below them is checked in turn. `boxOf(o)` -> {x, y, w, h} or null.
 * Returns { burn, auto, covering }: objects, `burn` in z-order (core + auto + covering).
 */
export function applyPlan(objects, core, { boxOf, canBurn }) {
  const z = new Map(objects.map((o, i) => [o.id, i]));
  const inBurn = new Set(core.map((o) => o.id)), auto = new Set(), covering = new Set();
  const todo = [...core];
  while (todo.length) {
    const top = todo.pop(), tb = boxOf(top);
    for (const o of objects.slice(0, z.get(top.id))) {
      if (inBurn.has(o.id) || o.page !== top.page || !overlaps(boxOf(o), tb)) continue;
      if (o.type === 'whiteout') { inBurn.add(o.id); auto.add(o.id); continue; }
      if (!canBurn(o)) continue;
      inBurn.add(o.id); covering.add(o.id); todo.push(o);
    }
  }
  const pick = (s) => objects.filter((o) => s.has(o.id));
  return { burn: pick(inBurn), auto: pick(auto), covering: pick(covering) };
}

const TYPE_LABEL = { rect: 'Rectangle', ellipse: 'Ellipse', cloud: 'Cloud', line: 'Line', arrow: 'Arrow', polyline: 'Polyline', ink: 'Freehand drawing',
  highlight: 'Highlight', image: 'Image', callout: 'Callout', stamp: 'Stamp', note: 'Note', text: 'Text box', underline: 'Underline',
  strikeout: 'Strikeout', squiggly: 'Squiggly underline', textHighlight: 'Text highlight' };
/** Short name of an object for the Apply signature confirmation list. */
export function objectLabel(o) {
  const name = o.type === 'image' && o.sig ? 'Signature' : TYPE_LABEL[o.type] ?? o.type;
  const t = String(o.text ?? '').replace(/\s+/g, ' ').trim();
  return t ? `${name} “${t.length > 24 ? `${t.slice(0, 23)}…` : t}”` : name;
}
