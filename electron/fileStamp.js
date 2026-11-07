// What a file held when a tab read or wrote it: { mtimeNs: '<digits>', size: <bytes> } (pure, unit-tested in
// test/fileStamp.test.js). Main returns it with every read and write; the renderer keeps it on the tab that
// loaded or saved the file and sends it back as writeFile's `expect`, so only that tab's own reads count.
import { isPlainObject } from './sessionState.js';

/** The stamp of a bigint fs.Stats. */
export const stampOf = (info) => ({ mtimeNs: String(info.mtimeNs), size: Number(info.size) });

const isCount = (v) => (typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 0)
  || (typeof v === 'string' && /^\d{1,30}$/.test(v));

/** writeFile's `expect` from the renderer: undefined/null (no check) or a valid stamp; anything else throws. */
export function cleanExpect(v) {
  if (v === undefined || v === null) return null;
  if (!isPlainObject(v) || !isCount(v.mtimeNs) || !isCount(v.size)) throw new TypeError('writeFile: expect must be { mtimeNs, size }');
  return { mtimeNs: String(BigInt(v.mtimeNs)), size: Number(v.size) };
}

/** True when the file on disk (`now`, a stamp or null when it is gone) differs from what the tab expects. */
export const changedSince = (expect, now) => !!expect && !!now && (now.mtimeNs !== expect.mtimeNs || now.size !== expect.size);
