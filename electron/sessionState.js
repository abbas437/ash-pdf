// Validation of one window's last-session state (pure, unit-tested in test/sessionState.test.js).
// The renderer writes it (app:sessionUpdate) and session.json holds it, so both are untrusted:
//   { files: [{ path, page }], active: path | null, split?: { dir, ratio, files: [pathA, pathB], focus } }
import { isAbsolute, resolve } from 'node:path';
import { SPLIT_DIRS, clampRatio } from '../renderer/ui/splitview-lib.js';

export const SESSION_MAX_FILES = 200; // per window

export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isPathString = (p) => typeof p === 'string' && p.length > 0 && p.length < 4096 && isAbsolute(p);
export const pathKey = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));

/**
 * One window's state, keeping only files whose path passes `accept` (no duplicates, page 1-based).
 * `split` is kept only when it is entirely valid and both its documents are among the kept files
 * (the same document twice is allowed); otherwise it is dropped and the rest kept.
 */
export function cleanWindowState(v, accept) {
  if (!isPlainObject(v) || !Array.isArray(v.files)) return null;
  const files = [];
  const kept = new Map(); // pathKey -> the kept path
  for (const f of v.files.slice(0, SESSION_MAX_FILES)) {
    const p = isPlainObject(f) ? f.path : null;
    if (!isPathString(p) || !accept(p) || kept.has(pathKey(p))) continue;
    kept.set(pathKey(p), p);
    files.push({ path: p, page: Number.isInteger(f.page) && f.page >= 1 && f.page <= 1e6 ? f.page : 1 });
  }
  const active = isPathString(v.active) && kept.has(pathKey(v.active)) ? v.active : null;
  const split = cleanSplit(v.split, kept);
  return split ? { files, active, split } : { files, active };
}

function cleanSplit(s, kept) {
  if (!isPlainObject(s) || !SPLIT_DIRS.includes(s.dir) || typeof s.ratio !== 'number' || !Number.isFinite(s.ratio)
    || (s.focus !== 0 && s.focus !== 1) || !Array.isArray(s.files) || s.files.length !== 2
    || !s.files.every((p) => isPathString(p) && kept.has(pathKey(p)))) return null;
  return { dir: s.dir, ratio: clampRatio(s.ratio), files: s.files.map((p) => kept.get(pathKey(p))), focus: s.focus };
}
