// Where a file or folder dialog starts (pure, unit-tested in test/dialogPaths.test.js).
// The main process remembers the folder of the last file opened or saved through a dialog (or the
// last folder picked) as settings.lastDir; settings.json is untrusted, so lastDir is checked here.
import { basename, join } from 'node:path';
import { isPathString } from './sessionState.js';

/**
 * The defaultPath to give a dialog, from the remembered folder `lastDir` and the caller's `requested`
 * defaultPath (undefined, a bare file name, or a path). `isDir(p)` tells whether `p` is an existing folder.
 *   - a requested path with a folder part (Save As of a file that has a path) is kept as is;
 *   - otherwise, when lastDir is an existing folder: the bare name inside it, or the folder itself;
 *   - otherwise the request unchanged (undefined: the OS default).
 */
export function dialogDefaultPath(lastDir, requested, isDir) {
  const name = typeof requested === 'string' && requested.length > 0 ? requested : undefined;
  if (name !== undefined && basename(name) !== name) return name;
  if (!isPathString(lastDir) || !isDir(lastDir)) return name;
  return name === undefined ? lastDir : join(lastDir, name);
}
