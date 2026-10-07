// ASH PDF Studio — Electron main process (ES module; the package is "type": "module").
//
// Security model
//   - Renderer: contextIsolation, no nodeIntegration, sandbox; it only sees window.api
//     (electron/preload.js).
//   - The renderer is served from the privileged custom scheme app://pdfstudio/, confined
//     to the renderer/ and src/ folders of the app. This gives the page a real origin, so
//     CSP 'self', ES-module workers, import maps and fetch() behave as on a web server
//     (file:// gives an opaque origin and breaks pdf.js asset loading).
//   - Filesystem access is by capability: a path is readable/writable only after it came
//     from an open/save dialog, the command line or an OS open-file event in this session.
//   - No new windows, no navigation away from the app page, every permission request denied.
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, screen, session, shell } from 'electron';
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, open, opendir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_NAME = 'ASH PDF Studio';
const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'); // app.asar root when packaged
const SCHEME = 'app';
const HOST = 'pdfstudio';
const START_URL = `${SCHEME}://${HOST}/renderer/index.html`;
const SERVED_DIRS = ['renderer', 'src'].map((d) => join(APP_ROOT, d) + sep);
const isDev = process.argv.includes('--dev');
const MAX_FILE_BYTES = 1024 * 1024 * 1024; // 1 GiB: refuse to slurp anything larger into the renderer

// --- Portable build: keep all app data next to the exe -----------------------------------
// electron-builder's portable target sets PORTABLE_EXECUTABLE_DIR to the folder holding
// the .exe. Must run before 'ready' so Chromium's profile (cache, local storage) moves too.
if (process.env.PORTABLE_EXECUTABLE_DIR) {
  const dataDir = join(process.env.PORTABLE_EXECUTABLE_DIR, 'ASH-PDF-Studio-data');
  mkdirSync(dataDir, { recursive: true });
  app.setPath('userData', dataDir);
}

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// --- Settings (small JSON file in userData) -----------------------------------------------
const settingsFile = () => join(app.getPath('userData'), 'settings.json');
let settings = {};
function loadSettings() {
  try {
    const parsed = JSON.parse(readFileSync(settingsFile(), 'utf8'));
    settings = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    // Renderer keys live in a null-prototype object, so no key can reach Object.prototype.
    settings.renderer = Object.assign(Object.create(null), isPlainObject(settings.renderer) ? settings.renderer : {});
  } catch {
    settings = {};
  }
}
function saveSettings() {
  try {
    const file = settingsFile();
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(settings, null, 2));
    renameSync(tmp, file);
  } catch (err) {
    console.error('settings: save failed', err);
  }
}

// --- File capabilities ----------------------------------------------------------------------
const pathKey = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
const grantedPaths = new Set();
const grant = (p) => grantedPaths.add(pathKey(p));
const isGranted = (p) => typeof p === 'string' && p.length > 0 && p.length < 4096 && isAbsolute(p) && grantedPaths.has(pathKey(p));

// Reads through one FileHandle, so the checks and the read see the same file. O_NONBLOCK: opening a
// FIFO must not park a threadpool thread. `check(fh, info)` (folder grants) runs after the open.
async function readGranted(p, check = null) {
  const fh = await open(p, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
  try {
    const info = await fh.stat({ bigint: true });
    if (!info.isFile()) throw new Error('Not a file');
    if (info.size > BigInt(MAX_FILE_BYTES)) throw new Error('File is larger than 1 GiB');
    if (check) await check(info);
    const buf = Buffer.alloc(Number(info.size));
    let off = 0;
    for (let n; off < buf.length && (n = (await fh.read(buf, off, buf.length - off, off)).bytesRead) > 0;) off += n;
    return new Uint8Array(buf.buffer, buf.byteOffset, off);
  } finally {
    await fh.close();
  }
}
async function describeFile(p) {
  return { path: p, name: basename(p), bytes: await readGranted(p) };
}

// Write to a temp file in the target folder, then rename over the target, so a failed
// write never leaves a truncated document behind.
async function atomicWrite(target, bytes) {
  const tmp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, bytes, { flag: 'wx' });
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

// --- Launch files (argv / second instance / macOS open-file) ----------------------------------
let mainWindow = null;
let rendererReady = false; // true once the page has collected getLaunchFiles()
const pendingFiles = [];

function pdfPathsFromArgv(argv, cwd) {
  // Packaged: argv = [exe, ...args]; dev: argv = [electron, '.', ...args]. Chromium may add --flags.
  const args = argv.slice(app.isPackaged ? 1 : 2);
  const found = [];
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.startsWith('-')) continue;
    const p = resolve(cwd || process.cwd(), arg);
    if (extname(p).toLowerCase() !== '.pdf') continue;
    try {
      if (statSync(p).isFile()) found.push(p);
    } catch { /* missing file: ignore */ }
  }
  return found;
}

async function deliverFiles(paths) {
  for (const p of paths) grant(p);
  if (!rendererReady || !mainWindow) {
    pendingFiles.push(...paths);
    return;
  }
  for (const p of paths) {
    try {
      mainWindow.webContents.send('app:openFile', await describeFile(p));
    } catch (err) {
      console.error('open-file: cannot read', p, err.message);
    }
  }
}

function focusWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

pendingFiles.push(...pdfPathsFromArgv(process.argv, process.cwd()));
pendingFiles.forEach(grant);

app.on('second-instance', (_event, argv, workingDirectory) => {
  focusWindow();
  deliverFiles(pdfPathsFromArgv(argv, workingDirectory));
});

app.on('open-file', (event, p) => {
  event.preventDefault();
  if (typeof p === 'string' && extname(p).toLowerCase() === '.pdf') deliverFiles([p]);
});

// --- Window ---------------------------------------------------------------------------------
function visibleBounds(b) {
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return null;
  const onScreen = screen.getAllDisplays().some(({ workArea: w }) =>
    b.x < w.x + w.width - 50 && b.x + b.width > w.x + 50 && b.y >= w.y - 10 && b.y < w.y + w.height - 50);
  return onScreen ? { x: b.x, y: b.y, width: Math.max(900, b.width), height: Math.max(600, b.height) } : null;
}

function createWindow() {
  const saved = settings.window ?? {};
  const bounds = visibleBounds(saved.bounds);
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    ...(bounds ?? {}),
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    show: false,
    autoHideMenuBar: !isDev,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: join(APP_ROOT, 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: isDev,
      spellcheck: false,
    },
  });
  if (saved.maximized) mainWindow.maximize();

  const wc = mainWindow.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (event, url) => { if (url !== START_URL) event.preventDefault(); });
  wc.on('will-redirect', (event) => event.preventDefault());
  wc.on('will-attach-webview', (event) => event.preventDefault());
  wc.on('did-start-loading', () => { rendererReady = false; });
  if (isDev) {
    wc.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        wc.toggleDevTools();
        event.preventDefault();
      }
    });
  }
  // The page <title> must not override the document title set through api.setTitle.
  mainWindow.on('page-title-updated', (event) => event.preventDefault());
  mainWindow.once('ready-to-show', () => mainWindow.show());
  // The renderer sets a beforeunload guard while there are unsaved changes; without this handler Electron would
  // silently refuse to close the window. Ask the user instead.
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning', buttons: ['Keep working', 'Discard changes and close'], defaultId: 0, cancelId: 0, noLink: true,
      title: 'Unsaved changes', message: 'There are unsaved changes.', detail: 'If you close now, they will be lost.',
    });
    if (choice === 1) event.preventDefault(); // preventDefault = ignore the guard and unload
  });
  mainWindow.on('close', () => {
    settings.window = { bounds: mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized() };
    saveSettings();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadURL(START_URL);
}

// --- app:// protocol: serve renderer/ and src/ only ------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
};
async function serveAppFile(request) {
  const url = new URL(request.url);
  if (url.host !== HOST) return new Response('Not found', { status: 404 });
  const file = resolve(APP_ROOT, '.' + decodeURIComponent(url.pathname));
  if (!SERVED_DIRS.some((d) => file.startsWith(d))) return new Response('Not found', { status: 404 });
  try {
    const body = await readFile(file);
    return new Response(body, {
      headers: {
        'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

// --- IPC ------------------------------------------------------------------------------------
// Every handler first checks the sender is our own top-level page.
function fromApp(event) {
  return !!mainWindow && event.sender === mainWindow.webContents && event.senderFrame?.url === START_URL;
}
function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromApp(event)) throw new Error(`${channel}: rejected sender`);
    return fn(...args);
  });
}
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function cleanFilters(filters) {
  if (filters === undefined) return [{ name: 'PDF document', extensions: ['pdf'] }];
  if (!Array.isArray(filters) || filters.length > 20) throw new TypeError('filters must be an array');
  return filters.map((f) => {
    if (!isPlainObject(f) || typeof f.name !== 'string' || f.name.length > 100 || !Array.isArray(f.extensions)
      || f.extensions.length > 20 || !f.extensions.every((e) => typeof e === 'string' && /^(\*|[A-Za-z0-9]{1,10})$/.test(e))) {
      throw new TypeError('filter must be {name:string, extensions:string[]}');
    }
    return { name: f.name, extensions: [...f.extensions] };
  });
}
function toBytes(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  throw new TypeError('bytes must be a Uint8Array');
}
const SETTINGS_KEY = /^[A-Za-z0-9_.-]{1,64}$/;
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const isSettingsKey = (key) => typeof key === 'string' && SETTINGS_KEY.test(key) && !RESERVED_KEYS.has(key);

// ---- advanced search: folder grants, PDF listing, search-index cache (renderer/ui/advsearch.js)
// A folder chosen in api.openFolder() grants READ access to the PDF files (real path ends in .pdf)
// under its real path, nothing else.
const grantedFolders = new Set(); // pathKey(realpath)
const MAX_LISTED = 20000;
// Walk budget: entries visited (of any type) and directory depth. ASH_SEARCH_MAX_ENTRIES lets tests use a small budget.
const MAX_VISITED = Number(process.env.ASH_SEARCH_MAX_ENTRIES) > 0 ? Number(process.env.ASH_SEARCH_MAX_ENTRIES) : 200000;
const MAX_DEPTH = 32;
const CACHE_CAP = 100 * 1024 * 1024;
const cacheDir = () => join(app.getPath('userData'), 'search-index'); // userData follows portable mode
const within = (realKey, rootKey) => realKey === rootKey || realKey.startsWith(rootKey.endsWith(sep) ? rootKey : rootKey + sep);
async function grantedRoot(p) {
  if (typeof p !== 'string' || !p || p.length >= 4096 || !isAbsolute(p)) return null;
  let real;
  try { real = pathKey(await realpath(p)); } catch { return null; }
  for (const root of grantedFolders) if (within(real, root)) return root;
  return null;
}
// A folder-derived read: the real path must be a .pdf inside the root, checked before the open and again
// on the open handle (same file as the real path), so a swapped symlink/junction cannot redirect the read.
async function folderPdfReal(p, root) {
  const real = await realpath(p);
  if (!within(pathKey(real), root)) throw new Error('file:read: path is outside the opened folder');
  if (extname(real).toLowerCase() !== '.pdf') throw new Error('file:read: only PDF files can be read from an opened folder');
  return real;
}
async function readFolderPdf(p, root) {
  await folderPdfReal(p, root);
  return readGranted(p, async (info) => {
    const now = await stat(await folderPdfReal(p, root), { bigint: true });
    if (now.dev !== info.dev || now.ino !== info.ino) throw new Error('file:read: file changed while it was being opened');
  });
}
const walks = new Map(); // root -> AbortController of the listing in flight (one per root)
async function listPdfs(folder, recursive) {
  const root = await grantedRoot(folder);
  if (!root) throw new Error('listPdfs: folder was not opened in this session');
  walks.get(root)?.abort(); // a new request for the same folder replaces the old one
  const ctl = new AbortController();
  walks.set(root, ctl);
  const out = [];
  const seen = new Set();
  let visited = 0, truncated = false;
  const stop = () => {
    if (ctl.signal.aborted || visited >= MAX_VISITED || out.length >= MAX_LISTED) truncated = true;
    return truncated;
  };
  const walk = async (dir, depth) => {
    const real = pathKey(await realpath(dir));
    if (seen.has(real) || !within(real, root)) return; // loops and symlinks leaving the folder
    seen.add(real);
    let entries;
    try { entries = await opendir(dir); } catch { return; }
    for await (const e of entries) { // breaking out closes the directory
      if (stop()) break;
      visited++;
      const p = join(dir, e.name);
      try {
        let isDir = e.isDirectory(), isFile = e.isFile(), real = p;
        if (e.isSymbolicLink()) {
          real = await realpath(p);
          if (!within(pathKey(real), root)) continue;
          const st = await stat(p); isDir = st.isDirectory(); isFile = st.isFile();
        }
        if (isDir && recursive) {
          if (depth >= MAX_DEPTH) truncated = true;
          else await walk(p, depth + 1);
        } else if (isFile && extname(e.name).toLowerCase() === '.pdf' && extname(real).toLowerCase() === '.pdf') { // as file:read requires
          const st = await stat(p);
          out.push({ path: p, name: e.name, size: st.size, mtimeMs: st.mtimeMs });
        }
      } catch { /* vanished or unreadable entry: skip */ }
    }
  };
  try {
    await walk(folder, 0);
  } finally {
    if (walks.get(root) === ctl) walks.delete(root);
  }
  return { files: out, truncated };
}
const cacheFile = (key) => join(cacheDir(), createHash('sha256').update(key).digest('hex') + '.json');
async function cacheSet(key, value) {
  if (typeof key !== 'string' || !key || key.length > 8192) throw new TypeError('invalid cache key');
  if (typeof value !== 'string') throw new TypeError('cache value must be a string');
  if (Buffer.byteLength(value) > CACHE_CAP) throw new RangeError('cache value too large (100 MB max)');
  await mkdir(cacheDir(), { recursive: true });
  const file = cacheFile(key);
  await atomicWrite(file, value);
  // Evict least recently written entries until the folder fits in the cap.
  const files = [];
  for (const name of await readdir(cacheDir())) {
    if (!name.endsWith('.json')) continue;
    try { const st = await lstat(join(cacheDir(), name)); files.push({ p: join(cacheDir(), name), size: st.size, t: st.mtimeMs }); } catch { /* raced */ }
  }
  let total = files.reduce((a, f) => a + f.size, 0);
  for (const f of files.sort((a, b) => a.t - b.t)) {
    if (total <= CACHE_CAP) break;
    if (f.p === file) continue;
    await unlink(f.p).catch(() => {});
    total -= f.size;
  }
  return true;
}
function registerAdvancedSearchIpc() {
  handle('dialog:openFolder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (canceled || !filePaths[0]) return null;
    grantedFolders.add(pathKey(await realpath(filePaths[0])));
    return { path: filePaths[0] };
  });
  handle('search:listPdfs', (folder, opts = {}) => listPdfs(folder, !!(isPlainObject(opts) && opts.recursive)));
  handle('search:cancel', () => { for (const ctl of walks.values()) ctl.abort(); return true; });
  handle('search:cacheGet', async (key) => {
    if (typeof key !== 'string' || !key || key.length > 8192) throw new TypeError('invalid cache key');
    try { return await readFile(cacheFile(key), 'utf8'); } catch { return null; }
  });
  handle('search:cacheSet', (key, value) => cacheSet(key, value));
}
// ---- end advanced search

function registerIpc() {
  registerAdvancedSearchIpc();
  handle('dialog:open', async (opts = {}) => {
    if (!isPlainObject(opts)) throw new TypeError('dialog:open options must be an object');
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: opts.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: cleanFilters(opts.filters),
    });
    if (canceled) return [];
    filePaths.forEach(grant);
    return Promise.all(filePaths.map(describeFile));
  });

  handle('file:read', async (p) => {
    if (isGranted(p)) return readGranted(p);
    const root = await grantedRoot(p);
    if (!root) throw new Error('file:read: path was not opened in this session');
    return readFolderPdf(p, root);
  });

  handle('dialog:save', async (opts) => {
    if (!isPlainObject(opts)) throw new TypeError('dialog:save options must be an object');
    const bytes = toBytes(opts.bytes);
    if (opts.defaultPath !== undefined && (typeof opts.defaultPath !== 'string' || opts.defaultPath.length > 1024)) {
      throw new TypeError('defaultPath must be a string');
    }
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: opts.defaultPath,
      filters: cleanFilters(opts.filters),
    });
    if (canceled || !filePath) return null;
    await atomicWrite(filePath, bytes);
    grant(filePath);
    return { path: filePath };
  });

  handle('file:write', async (p, bytes) => {
    if (!isGranted(p)) throw new Error('file:write: path was not opened or saved in this session');
    await atomicWrite(p, toBytes(bytes));
    return { path: p };
  });

  handle('app:launchFiles', async () => {
    rendererReady = true;
    const paths = pendingFiles.splice(0);
    const files = [];
    for (const p of paths) {
      try { files.push(await describeFile(p)); } catch (err) { console.error('launch file unreadable', p, err.message); }
    }
    return files;
  });

  handle('app:print', () => new Promise((done) => {
    mainWindow.webContents.print({ silent: false, printBackground: true }, (ok, reason) => done({ ok, reason: ok ? null : reason }));
  }));

  handle('app:version', () => app.getVersion());

  handle('app:setTitle', (title) => {
    const t = typeof title === 'string' ? title.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200) : '';
    mainWindow.setTitle(t ? `${t} — ${APP_NAME}` : APP_NAME);
  });

  handle('shell:showItem', (p) => {
    if (!isGranted(p) || !existsSync(p)) return false;
    shell.showItemInFolder(p);
    return true;
  });

  handle('app:settingsGet', (key) => {
    if (!isSettingsKey(key)) throw new TypeError('invalid settings key');
    return settings.renderer && Object.hasOwn(settings.renderer, key) ? settings.renderer[key] : undefined;
  });

  handle('app:settingsSet', (key, value) => {
    if (!isSettingsKey(key)) throw new TypeError('invalid settings key');
    const json = value === undefined ? undefined : JSON.stringify(value);
    if (json !== undefined && json.length > 64 * 1024) throw new RangeError('settings value too large (64 KiB max)');
    settings.renderer ??= Object.create(null);
    if (json === undefined) delete settings.renderer[key];
    else settings.renderer[key] = JSON.parse(json);
    saveSettings();
    return true;
  });
}

// ---- signature library -----------------------------------------------------------------------
// Image items the renderer keeps across sessions (too big for settings.json). Stored under the
// userData dir (the portable data dir in portable mode) as library/<kind>/<id>.bin (image bytes;
// AES-GCM ciphertext when the item is password-locked, done in the renderer) and <id>.json (meta).
// Add a kind (e.g. 'stamp') to LIBRARY_KINDS to reuse the storage.
const LIBRARY_KINDS = new Set(['signature', 'stamp']);
const LIBRARY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const LIBRARY_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i; // Windows device names
const LIBRARY_MAX_BYTES = 5 * 1024 * 1024;
const LIBRARY_MAX_ITEMS = 500; // per kind
const isLibraryId = (id) => typeof id === 'string' && LIBRARY_ID.test(id) && !LIBRARY_RESERVED.test(id);
function libraryFile(kind, id, ext) {
  if (!LIBRARY_KINDS.has(kind)) throw new TypeError('invalid library kind');
  if (!isLibraryId(id)) throw new TypeError('invalid library id');
  return join(app.getPath('userData'), 'library', kind, id + ext);
}
const ignoreMissing = (err) => { if (err?.code !== 'ENOENT') throw err; };
function registerLibraryIpc() {
  handle('library:list', async (kind) => {
    const dir = dirname(libraryFile(kind, 'x', '.json'));
    const names = await readdir(dir).catch((err) => { ignoreMissing(err); return []; });
    const metas = new Set(names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)));
    // Image bytes whose meta is gone (e.g. a delete interrupted half way). Only stale ones: library:put
    // writes the .bin just before the .json, and a list in between must not delete it.
    for (const n of names) {
      if (!n.endsWith('.bin') || metas.has(n.slice(0, -4))) continue;
      const f = join(dir, n);
      try { if (Date.now() - (await lstat(f)).mtimeMs > 60_000) await unlink(f); } catch { /* raced */ }
    }
    const out = [];
    for (const n of names) {
      if (out.length >= LIBRARY_MAX_ITEMS) break;
      const id = n.endsWith('.json') ? n.slice(0, -5) : null;
      if (!id || !isLibraryId(id)) continue;
      try { out.push({ id, meta: JSON.parse(await readFile(join(dir, n), 'utf8')) }); } catch (err) { console.error('library: unreadable meta', n, err.message); }
    }
    return out;
  });
  handle('library:get', async (kind, id) => {
    const metaFile = libraryFile(kind, id, '.json'), binFile = libraryFile(kind, id, '.bin');
    try {
      const [meta, bytes] = await Promise.all([readFile(metaFile, 'utf8'), readFile(binFile)]);
      return { id, meta: JSON.parse(meta), bytes: new Uint8Array(bytes) };
    } catch (err) { ignoreMissing(err); return null; }
  });
  // item = {meta, bytes?}: without bytes only the meta is replaced (the item must exist).
  handle('library:put', async (kind, id, item) => {
    const metaFile = libraryFile(kind, id, '.json'), binFile = libraryFile(kind, id, '.bin');
    if (!isPlainObject(item) || !isPlainObject(item.meta)) throw new TypeError('library:put: {meta, bytes} required');
    const json = JSON.stringify(item.meta);
    if (json.length > 64 * 1024) throw new RangeError('library meta too large (64 KiB max)');
    await mkdir(dirname(metaFile), { recursive: true });
    if (!existsSync(metaFile) && (await readdir(dirname(metaFile))).filter((n) => n.endsWith('.json')).length >= LIBRARY_MAX_ITEMS) {
      throw new RangeError(`library is full (${LIBRARY_MAX_ITEMS} items max)`);
    }
    if (item.bytes !== undefined) {
      const bytes = toBytes(item.bytes);
      if (bytes.length > LIBRARY_MAX_BYTES) throw new RangeError('library item too large (5 MB max)');
      await atomicWrite(binFile, bytes);
    } else if (!existsSync(binFile)) throw new Error('library:put: no such item');
    await atomicWrite(metaFile, Buffer.from(json));
    return true;
  });
  handle('library:delete', async (kind, id) => {
    const metaFile = libraryFile(kind, id, '.json'), binFile = libraryFile(kind, id, '.bin');
    await unlink(metaFile).catch(ignoreMissing);
    await unlink(binFile).catch(ignoreMissing);
    return true;
  });
}
// ---- end signature library -------------------------------------------------------------------

// --- Lifecycle ------------------------------------------------------------------------------
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => { if (url !== START_URL) event.preventDefault(); });
});

app.whenReady().then(() => {
  loadSettings();
  if (!isDev) Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  protocol.handle(SCHEME, serveAppFile);
  registerIpc();
  registerLibraryIpc(); // signature library
  createWindow();
});

app.on('window-all-closed', () => app.quit());
