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
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, safeStorage, screen, session, shell } from 'electron';
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, open, opendir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { registerOfficeIpc } from './office.js'; // office conversions

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
// Every app window shares one session, one app:// protocol, one set of IPC handlers and the same file
// grants (all windows are the same trusted page, so per-window grants would add no isolation).
// Per window: `ready` (the page has collected getLaunchFiles()) and `pending` (files waiting for that).
const appWindows = new Map(); // BrowserWindow -> { ready: boolean, pending: string[] }
let mainWindow = null; // the last-focused app window (target for files from the OS)
const launchFiles = []; // files that arrived before the first window exists

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

async function deliverFiles(win, paths) {
  for (const p of paths) grant(p);
  const state = appWindows.get(win);
  if (!state) return;
  if (!state.ready) {
    state.pending.push(...paths);
    return;
  }
  for (const p of paths) {
    try {
      if (!win.isDestroyed()) win.webContents.send('app:openFile', await describeFile(p));
    } catch (err) {
      console.error('open-file: cannot read', p, err.message);
    }
  }
}

function focusWindow(win) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// Files from the OS (double-click while running, macOS open-file): tabs in the last-focused window,
// or a new window when the user setting `open.target` is 'window'.
function openFromOs(paths) {
  if (!app.isReady()) {
    paths.forEach(grant);
    launchFiles.push(...paths);
    return;
  }
  if (!mainWindow || (paths.length && settings.renderer?.['open.target'] === 'window')) {
    paths.forEach(grant);
    createAppWindow(paths);
    return;
  }
  focusWindow(mainWindow);
  deliverFiles(mainWindow, paths);
}

launchFiles.push(...pdfPathsFromArgv(process.argv, process.cwd()));
launchFiles.forEach(grant);

app.on('second-instance', (_event, argv, workingDirectory) => {
  openFromOs(pdfPathsFromArgv(argv, workingDirectory));
});

app.on('open-file', (event, p) => {
  event.preventDefault();
  if (typeof p === 'string' && extname(p).toLowerCase() === '.pdf') openFromOs([p]);
});

// --- Session and recent files -----------------------------------------------------------------
// Main owns both lists. The renderer only reports which of its tabs have a granted path
// (app:sessionUpdate); a recorded path is granted again only when the user chooses to reopen it.
const sessionFile = () => join(app.getPath('userData'), 'session.json');
const recentFile = () => join(app.getPath('userData'), 'recent.json');
const RECENT_MAX = 15;
const SESSION_MAX_FILES = 200; // per window
const STARTUP_MODES = new Set(['ask', 'restore', 'new']);
const startupMode = () => (STARTUP_MODES.has(settings.renderer?.['startup.mode']) ? settings.renderer['startup.mode'] : 'ask');
const windowSessions = new Map(); // BrowserWindow -> { files: [{ path, page }], active: path | null }
const closedForQuit = new Map(); // windows closed by the quit (or the last window): saved with the session
let quitting = false;
let savedSession = []; // the previous run's windows, same shape as windowSessions' values
let sessionOffer = null; // { win, auto }: the first window may reopen savedSession once
let recent = []; // paths, newest first

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}
function writeJson(file, value) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, file);
  } catch (err) {
    console.error('save failed', file, err);
  }
}
const isPathString = (p) => typeof p === 'string' && p.length > 0 && p.length < 4096 && isAbsolute(p);
const isFile = (p) => stat(p).then((s) => s.isFile(), () => false);

// One window's state, keeping only files whose path passes `accept` (no duplicates, page 1-based).
function cleanWindowState(v, accept) {
  if (!isPlainObject(v) || !Array.isArray(v.files)) return null;
  const files = [];
  const seen = new Set();
  for (const f of v.files.slice(0, SESSION_MAX_FILES)) {
    const p = isPlainObject(f) ? f.path : null;
    if (!isPathString(p) || !accept(p) || seen.has(pathKey(p))) continue;
    seen.add(pathKey(p));
    files.push({ path: p, page: Number.isInteger(f.page) && f.page >= 1 && f.page <= 1e6 ? f.page : 1 });
  }
  const active = isPathString(v.active) && seen.has(pathKey(v.active)) ? v.active : null;
  return { files, active };
}

function loadSessionAndRecent() {
  const s = readJson(sessionFile());
  savedSession = (Array.isArray(s?.windows) ? s.windows : []).slice(0, 50)
    .map((w) => cleanWindowState(w, () => true)).filter((w) => w?.files.length);
  const r = readJson(recentFile());
  recent = (Array.isArray(r) ? r : []).filter(isPathString).slice(0, RECENT_MAX);
}

function addRecent(paths) {
  if (!paths.length) return;
  for (const p of paths) recent = [p, ...recent.filter((q) => pathKey(q) !== pathKey(p))];
  recent = recent.slice(0, RECENT_MAX);
  writeJson(recentFile(), recent);
}

function saveSession() {
  let windows = [...closedForQuit.values(), ...windowSessions.values()].filter((w) => w.files.length);
  if (!windows.length && sessionOffer) windows = savedSession; // never answered and nothing open: keep it
  writeJson(sessionFile(), { version: 1, windows });
}
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', saveSession);

// Reopens the saved session: the first saved window's files go to the caller (returned), the others
// open in new windows. Files that no longer exist (deleted, moved, temporary e-mail attachments) are
// returned in `missing`.
async function restoreSession() {
  sessionOffer = null;
  const missing = [];
  const windows = [];
  for (const w of savedSession) {
    const files = [];
    for (const f of w.files) {
      if (await isFile(f.path)) files.push(f);
      else missing.push(f.path);
    }
    if (files.length) windows.push({ ...w, files });
  }
  const meta = (w) => new Map(w.files.map((f) => [pathKey(f.path), { page: f.page, active: !!w.active && pathKey(w.active) === pathKey(f.path) }]));
  const [first, ...rest] = windows;
  for (const w of rest) {
    w.files.forEach((f) => grant(f.path));
    appWindows.get(createAppWindow(w.files.map((f) => f.path))).meta = meta(w);
  }
  const files = [];
  if (first) {
    const m = meta(first);
    for (const f of first.files) {
      grant(f.path);
      try { files.push({ ...(await describeFile(f.path)), ...m.get(pathKey(f.path)) }); } catch { missing.push(f.path); }
    }
  }
  return { files, missing };
}

// --- Window ---------------------------------------------------------------------------------
function visibleBounds(b) {
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return null;
  const onScreen = screen.getAllDisplays().some(({ workArea: w }) =>
    b.x < w.x + w.width - 50 && b.x + b.width > w.x + 50 && b.y >= w.y - 10 && b.y < w.y + w.height - 50);
  return onScreen ? { x: b.x, y: b.y, width: Math.max(900, b.width), height: Math.max(600, b.height) } : null;
}

// Every window is created here, with the same security settings. `files` (already granted) open as tabs
// once the page has loaded. The first window uses the saved bounds; later ones cascade from the focused one.
function createAppWindow(files = []) {
  const first = appWindows.size === 0;
  const saved = first ? settings.window ?? {} : {};
  let bounds = visibleBounds(saved.bounds);
  if (!first && mainWindow && !mainWindow.isDestroyed()) {
    const b = mainWindow.getNormalBounds();
    bounds = visibleBounds({ ...b, x: b.x + 30, y: b.y + 30 }) ?? visibleBounds(b);
  }
  const win = new BrowserWindow({
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
  const state = { ready: false, pending: [...files] };
  appWindows.set(win, state);
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = win;
  if (saved.maximized) win.maximize();

  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (event, url) => { if (url !== START_URL) event.preventDefault(); });
  wc.on('will-redirect', (event) => event.preventDefault());
  wc.on('will-attach-webview', (event) => event.preventDefault());
  wc.on('did-start-loading', () => { state.ready = false; });
  if (isDev) {
    wc.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        wc.toggleDevTools();
        event.preventDefault();
      }
    });
  }
  // The page <title> must not override the document title set through api.setTitle.
  win.on('page-title-updated', (event) => event.preventDefault());
  win.once('ready-to-show', () => win.show());
  win.on('focus', () => { mainWindow = win; });
  // The renderer sets a beforeunload guard while there are unsaved changes; without this handler Electron would
  // silently refuse to close the window. Ask the user instead.
  wc.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['Keep working', 'Discard changes and close'], defaultId: 0, cancelId: 0, noLink: true,
      title: 'Unsaved changes', message: 'There are unsaved changes.', detail: 'If you close now, they will be lost.',
    });
    if (choice === 1) event.preventDefault(); // preventDefault = ignore the guard and unload
    else quitting = false; // a quit stops at the first window that stays open
  });
  win.on('close', () => {
    settings.window = { bounds: win.getNormalBounds(), maximized: win.isMaximized() };
    saveSettings();
  });
  win.on('closed', () => {
    appWindows.delete(win);
    // A window closed on its own is forgotten; one closed by the quit, or the last one, is the session.
    const last = windowSessions.get(win);
    windowSessions.delete(win);
    if (last && (quitting || appWindows.size === 0)) closedForQuit.set(win, last);
    if (mainWindow === win) mainWindow = [...appWindows.keys()].at(-1) ?? null;
  });
  win.loadURL(START_URL);
  return win;
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
  const win = BrowserWindow.fromWebContents(event.sender);
  return !!win && appWindows.has(win) && event.sender === win.webContents && event.senderFrame?.url === START_URL;
}
// The window whose page made the current handle() call (survives awaits), for dialog parents etc.
const ipcCaller = new AsyncLocalStorage();
const callerWindow = () => ipcCaller.getStore() ?? mainWindow;
function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromApp(event)) throw new Error(`${channel}: rejected sender`);
    return ipcCaller.run(BrowserWindow.fromWebContents(event.sender), () => fn(...args));
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
    const { canceled, filePaths } = await dialog.showOpenDialog(callerWindow(), { properties: ['openDirectory'] });
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
    const { canceled, filePaths } = await dialog.showOpenDialog(callerWindow(), {
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
    const { canceled, filePath } = await dialog.showSaveDialog(callerWindow(), {
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
    const state = appWindows.get(callerWindow());
    state.ready = true;
    const paths = state.pending.splice(0);
    const files = [];
    for (const p of paths) {
      try { files.push({ ...(await describeFile(p)), ...state.meta?.get(pathKey(p)) }); } catch (err) { console.error('launch file unreadable', p, err.message); }
    }
    return files;
  });

  // ---- session and recent files (see "Session and recent files" above)
  // The caller's open files; entries whose path is not granted are dropped.
  handle('app:sessionUpdate', (v) => {
    const win = callerWindow();
    const next = cleanWindowState(v, isGranted);
    if (!next) throw new TypeError('sessionUpdate: { files: [{ path, page }], active } expected');
    const before = new Set((windowSessions.get(win)?.files ?? []).map((f) => pathKey(f.path)));
    windowSessions.set(win, next);
    addRecent(next.files.map((f) => f.path).filter((p) => !before.has(pathKey(p))));
    return true;
  });
  // { mode, offer: { count, auto } | null }: the offer exists for the first window only, until answered.
  handle('app:sessionInfo', () => {
    const count = savedSession.reduce((n, w) => n + w.files.length, 0);
    const offer = sessionOffer?.win === callerWindow() && count ? { count, auto: sessionOffer.auto } : null;
    return { mode: startupMode(), offer };
  });
  handle('app:sessionRestore', () => (sessionOffer?.win === callerWindow() ? restoreSession() : null));
  handle('app:sessionDismiss', () => {
    if (sessionOffer?.win === callerWindow()) sessionOffer = null;
    return true;
  });
  handle('app:recentList', () => Promise.all(recent.map(async (p) => ({ path: p, name: basename(p), folder: dirname(p), exists: await isFile(p) }))));
  // Opens an entry of the recent list: granted again after a check that it still exists; null if missing.
  handle('app:recentOpen', async (p) => {
    if (!isPathString(p) || !recent.some((q) => pathKey(q) === pathKey(p))) throw new Error('recentOpen: not in the recent files list');
    if (!(await isFile(p))) return null;
    grant(p);
    return describeFile(p);
  });
  handle('app:recentClear', () => {
    recent = [];
    writeJson(recentFile(), recent);
    return true;
  });

  handle('app:print', () => new Promise((done) => {
    callerWindow().webContents.print({ silent: false, printBackground: true }, (ok, reason) => done({ ok, reason: ok ? null : reason }));
  }));

  handle('app:version', () => app.getVersion());

  handle('app:newWindow', () => { createAppWindow(); return true; });

  // File dialog, then the chosen PDFs open as tabs in a new window. false when cancelled.
  handle('app:openInNewWindow', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(callerWindow(), {
      properties: ['openFile', 'multiSelections'],
      filters: cleanFilters(undefined),
    });
    if (canceled || !filePaths.length) return false;
    filePaths.forEach(grant);
    createAppWindow(filePaths);
    return true;
  });

  handle('app:setTitle', (title) => {
    const t = typeof title === 'string' ? title.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200) : '';
    callerWindow().setTitle(t ? `${t} — ${APP_NAME}` : APP_NAME);
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
//
// At rest the .bin is protected by the user's OS login (owner decision: the Windows login is the
// lock; the per-item password stays an optional extra): Electron safeStorage (DPAPI on Windows)
// wraps the bytes and the file is LIBRARY_MAGIC + ciphertext. A file without the magic is plain:
// written by an older version (re-wrapped on its first read) or when encryption is unavailable
// (e.g. Linux without a keyring: stored plain, reported as encrypted:false, never an error). DPAPI
// binds to the Windows user and computer, so a portable data folder moved to another PC or user
// cannot unwrap its items: library:get reports those (and corrupted files) as {unavailable: true}.
const LIBRARY_MAGIC = Buffer.from('ASE1');
const safeStorageCipher = {
  available: () => safeStorage.isEncryptionAvailable(),
  // safeStorage takes strings: carry the bytes as base64.
  encrypt: (bytes) => safeStorage.encryptString(Buffer.from(bytes).toString('base64')),
  decrypt: (data) => Buffer.from(safeStorage.decryptString(data), 'base64'),
};
// Tests only (unpackaged + ASH_TEST_FAKE_SAFESTORAGE=1): a reversible stand-in for CI machines
// without an OS keyring. Not a cipher; it only has to hide the PNG signature and reject junk.
const fakeCipher = {
  available: () => true,
  encrypt: (bytes) => Buffer.concat([Buffer.from('FAKE'), Buffer.from(bytes).map((b) => b ^ 0x5a)]),
  decrypt: (data) => {
    if (data.subarray(0, 4).toString('latin1') !== 'FAKE') throw new Error('fake safeStorage: cannot decrypt');
    return Buffer.from(data.subarray(4)).map((b) => b ^ 0x5a);
  },
};
const libraryCipher = !app.isPackaged && process.env.ASH_TEST_FAKE_SAFESTORAGE === '1' ? fakeCipher : safeStorageCipher;
const isWrapped = (data) => data.length >= LIBRARY_MAGIC.length && data.subarray(0, LIBRARY_MAGIC.length).equals(LIBRARY_MAGIC);
/** Bytes as stored: wrapped when the OS can encrypt, plain otherwise. */
function wrapLibraryBytes(bytes) {
  return libraryCipher.available() ? Buffer.concat([LIBRARY_MAGIC, libraryCipher.encrypt(bytes)]) : bytes;
}
// One library operation per file at a time, so a migrating read cannot overwrite a newer put.
const libraryQueues = new Map();
function withLibraryFile(file, fn) {
  const run = (libraryQueues.get(file) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  libraryQueues.set(file, tail);
  tail.then(() => { if (libraryQueues.get(file) === tail) libraryQueues.delete(file); });
  return run;
}
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
  // -> {id, meta, bytes, encrypted} | {id, meta, bytes: null, encrypted: true, unavailable: true} | null
  handle('library:get', async (kind, id) => {
    const metaFile = libraryFile(kind, id, '.json'), binFile = libraryFile(kind, id, '.bin');
    return withLibraryFile(binFile, async () => {
      let meta, data;
      try {
        [meta, data] = await Promise.all([readFile(metaFile, 'utf8'), readFile(binFile)]);
      } catch (err) { ignoreMissing(err); return null; }
      meta = JSON.parse(meta);
      if (isWrapped(data)) {
        try {
          return { id, meta, bytes: new Uint8Array(libraryCipher.decrypt(data.subarray(LIBRARY_MAGIC.length))), encrypted: true };
        } catch (err) {
          console.error('library: cannot decrypt', kind, id, err.message);
          return { id, meta, bytes: null, encrypted: true, unavailable: true };
        }
      }
      let encrypted = false;
      if (libraryCipher.available()) { // stored plain by an older version: protect it now
        try { await atomicWrite(binFile, wrapLibraryBytes(data)); encrypted = true; } catch (err) { console.error('library: re-encrypt failed', kind, id, err.message); }
      }
      return { id, meta, bytes: new Uint8Array(data), encrypted };
    });
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
      await withLibraryFile(binFile, () => atomicWrite(binFile, wrapLibraryBytes(bytes)));
    } else if (!existsSync(binFile)) throw new Error('library:put: no such item');
    await atomicWrite(metaFile, Buffer.from(json));
    return true;
  });
  handle('library:delete', async (kind, id) => {
    const metaFile = libraryFile(kind, id, '.json'), binFile = libraryFile(kind, id, '.bin');
    return withLibraryFile(binFile, async () => {
      await unlink(metaFile).catch(ignoreMissing);
      await unlink(binFile).catch(ignoreMissing);
      return true;
    });
  });
}
// ---- end signature library -------------------------------------------------------------------

// ---- clipboard and external links
// api.copyText: the renderer cannot use navigator.clipboard or execCommand('copy') (every
// permission check is denied, clipboard-sanitized-write included), so text goes through here.
// api.openExternal: only http:, https: and mailto: URLs reach the system browser / mail client.
import { clipboard } from 'electron';
const MAX_CLIPBOARD_CHARS = 10 * 1024 * 1024;
const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
function externalUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 8192) throw new TypeError('openExternal: url must be a string');
  let u;
  try { u = new URL(raw); } catch { throw new TypeError('openExternal: not a valid URL'); }
  if (!EXTERNAL_SCHEMES.has(u.protocol)) throw new Error(`openExternal: ${u.protocol} links are not opened`);
  return u.href;
}
app.whenReady().then(() => {
  ipcMain.handle('clipboard:writeText', (event, text) => {
    if (!fromApp(event)) throw new Error('clipboard:writeText: not allowed');
    if (typeof text !== 'string') throw new TypeError('copyText: text must be a string');
    if (text.length > MAX_CLIPBOARD_CHARS) throw new RangeError('copyText: text too large (10 MB max)');
    clipboard.writeText(text);
    return true;
  });
  ipcMain.handle('shell:openExternal', async (event, raw) => {
    if (!fromApp(event)) throw new Error('shell:openExternal: not allowed');
    await shell.openExternal(externalUrl(raw));
    return true;
  });
});
// ---- end clipboard and external links

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
  // ---- office conversions (electron/office.js): Word/Excel/PowerPoint <-> PDF through Microsoft Office
  registerOfficeIpc({ handle, dialog, getWindow: callerWindow, grant, describeFile, isPackaged: app.isPackaged });
  // ---- end office conversions
  loadSessionAndRecent();
  const fromCommandLine = launchFiles.length > 0;
  const first = createAppWindow(launchFiles.splice(0));
  // Files given at start-up take priority: the saved session is then only offered, never reopened automatically.
  const mode = startupMode();
  if (mode !== 'new' && savedSession.length) sessionOffer = { win: first, auto: mode === 'restore' && !fromCommandLine };
});

app.on('window-all-closed', () => app.quit());
