// Pure helpers comparing annotation object states (renderer/ui/annotations.js): stable snapshots and
// the keys a gesture changed. Picture bytes (Uint8Array) are hashed, never stringified.

/** Stable JSON of an object's state (key order and `source` ignored); typed arrays are hashed. */
export function stable(v) {
  if (ArrayBuffer.isView(v)) { let x = 2166136261; for (const b of new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) x = Math.imul(x ^ b, 16777619); return `"#${v.byteLength}:${x >>> 0}"`; }
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).filter((k) => k !== 'source' && v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

/** The keys of `o` (other than id) whose value differs from `o0`'s; the same reference is equal without a deep compare. */
export function changedKeys(o, o0) {
  return Object.keys(o).filter((k) => k !== 'id' && o[k] !== o0[k] && (o[k] === undefined || o0[k] === undefined || stable(o[k]) !== stable(o0[k])));
}
