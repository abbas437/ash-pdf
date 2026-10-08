// Browser fallback for window.api.
//
// In Electron, electron/preload.js exposes window.api through contextBridge and this
// module does nothing. In a plain browser (Playwright tests, `npx serve`), it installs an
// implementation with the same shape so the renderer runs identically:
//   - files come from <input type=file> and are kept in memory under pseudo paths
//     ("browser-file:<n>/<name>") so readFile()/writeFile() behave like in Electron;
//   - saving triggers a Blob download;
//   - settings live in localStorage; the signature library lives in memory.
// Every method returns a Promise, as the IPC-backed versions do; onOpenFile returns an
// unsubscribe function.
import { ImageExportJobs, planImageExport } from '../src/core/imgexport.js';

if (!window.api) {
  const APP_NAME = 'ASH PDF Studio';
  const files = new Map(); // pseudo path -> Uint8Array
  // Like main: only paths from the open dialog or a save dialog may be written; folder grants are read-only.
  const writable = new Set();
  const imageJobs = new ImageExportJobs();
  let seq = 0;

  const extensionsOf = (filters) =>
    (Array.isArray(filters) ? filters : [])
      .flatMap((f) => (Array.isArray(f?.extensions) ? f.extensions : []))
      .filter((e) => typeof e === 'string' && e !== '*')
      .map((e) => '.' + e.replace(/^\./, ''));

  const baseName = (p) => String(p ?? '').split(/[\\/]/).pop();

  function pickFiles({ filters, multiple } = {}) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = !!multiple;
      const accept = extensionsOf(filters);
      if (accept.length) input.accept = accept.join(',');
      input.style.display = 'none';
      const done = async () => {
        input.remove();
        const picked = [];
        for (const file of input.files ?? []) {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const path = `browser-file:${++seq}/${file.name}`;
          files.set(path, bytes);
          writable.add(path);
          picked.push({ path, name: file.name, bytes });
        }
        resolve(picked);
      };
      input.addEventListener('change', done, { once: true });
      input.addEventListener('cancel', () => { input.remove(); resolve([]); }, { once: true });
      document.body.append(input);
      input.click();
    });
  }

  function download(name, bytes) {
    const url = URL.createObjectURL(new Blob([bytes], { type: name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  const settingsKey = (k) => {
    if (typeof k !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(k)) throw new TypeError('settings key must match /^[A-Za-z0-9_.-]{1,64}$/');
    return 'ash-pdf-studio:' + k;
  };

  // ---- advanced search: fake folders for tests. window.__ashShim.addFolder('/fake', [{name, bytes, mtimeMs?, dir?}])
  // makes the next openFolder() return {path: '/fake'}; files get paths '/fake[/dir]/name'.
  const folders = new Map(); // folder -> [{path, name, size, mtimeMs}]
  const cache = new Map();
  let nextFolder = null;
  // ---- clipboard and external links: recorded for tests (window.__ashShim.copied / .opened).
  // clip is the in-memory system clipboard: copyText / copyImage write it (each write replaces both
  // formats, as a real clipboard write does), readText / readImage read it. setClipboardText(t) and
  // setClipboardImage(pngBytes, text = '') stand in for another app copying.
  const copied = [];
  const opened = [];
  const clip = { text: '', image: null };
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  window.__ashShim = Object.freeze({
    addFolder(folder, list) {
      folders.set(folder, list.map((f) => {
        const path = [folder, f.dir, f.name].filter(Boolean).join('/');
        files.set(path, f.bytes);
        return { path, name: f.name, size: f.bytes.length, mtimeMs: f.mtimeMs ?? 1 };
      }));
      nextFolder = folder;
    },
    cacheKeys: () => [...cache.keys()],
    copied, opened,
    setClipboardText(t) { clip.text = String(t); clip.image = null; },
    setClipboardImage(bytes, text = '') { clip.image = new Uint8Array(bytes); clip.text = String(text); },
    clipboardText: () => clip.text,
    clipboardImage: () => (clip.image ? new Uint8Array(clip.image) : null),
  });
  const library = new Map(); // `${kind}/${id}` -> {meta, bytes}
  const libKey = (kind, id) => {
    if (kind !== 'signature' && kind !== 'stamp') throw new TypeError('invalid library kind');
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new TypeError('invalid library id');
    return `${kind}/${id}`;
  };
  const cloneJson = (v) => JSON.parse(JSON.stringify(v));

  window.api = Object.freeze({
    isElectron: false,
    async version() {
      try {
        const res = await fetch(new URL('../package.json', import.meta.url));
        return (await res.json()).version;
      } catch {
        return 'browser';
      }
    },
    openFiles: (opts) => pickFiles(opts),
    async readFile(path) {
      if (!files.has(path)) throw new Error('readFile: path was not opened in this session');
      return files.get(path).slice();
    },
    async saveFile({ defaultPath, bytes } = {}) {
      if (!(bytes instanceof Uint8Array)) throw new TypeError('saveFile: bytes must be a Uint8Array');
      const name = baseName(defaultPath) || 'document.pdf';
      download(name, bytes);
      const path = `browser-file:${++seq}/${name}`;
      files.set(path, bytes.slice());
      writable.add(path);
      return { path };
    },
    async writeFile(path, bytes) {
      if (!writable.has(path)) throw new Error('file:write: path was not opened or saved in this session');
      if (!(bytes instanceof Uint8Array)) throw new TypeError('writeFile: bytes must be a Uint8Array');
      files.set(path, bytes.slice());
      download(baseName(path), bytes);
      return { path };
    },
    // Multi-page image export: same validation as main (src/core/imgexport.js); the "folder" is a fresh
    // pseudo folder (so nothing exists to replace) and each file is downloaded.
    async imageExportBegin(req) {
      const plan = planImageExport(req);
      const folder = `browser-folder:${++seq}`;
      return { jobId: imageJobs.open('shim', { ...plan, folder }), folder, count: plan.names.length };
    },
    async imageExportWrite(jobId, index, bytes) {
      const { folder, name } = imageJobs.take('shim', jobId, index, bytes);
      files.set(`${folder}/${name}`, bytes.slice());
      download(name, bytes);
      return { name };
    },
    async imageExportEnd(jobId) { return imageJobs.close('shim', jobId); },
    async getLaunchFiles() { return []; },
    onOpenFile(cb) {
      if (typeof cb !== 'function') throw new TypeError('onOpenFile: callback required');
      return () => {};
    },
    async print() { window.print(); return { ok: true }; },
    async setFullScreen(on) {
      if (typeof on !== 'boolean') throw new TypeError('setFullScreen: boolean required');
      if (on) await document.documentElement.requestFullscreen?.();
      else if (document.fullscreenElement) await document.exitFullscreen();
      return on;
    },
    async setTitle(t) {
      const s = typeof t === 'string' ? t.trim() : '';
      document.title = s ? `${s} — ${APP_NAME}` : APP_NAME;
    },
    async showItem() { return false; },
    async newWindow() { return false; }, // windows: Electron only
    async openInNewWindow() { return false; },
    async settingsGet(k) {
      const raw = localStorage.getItem(settingsKey(k));
      return raw == null ? undefined : JSON.parse(raw);
    },
    async settingsSet(k, v) {
      const key = settingsKey(k);
      if (v === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(v));
      return true;
    },
    async openFolder() { return nextFolder ? { path: nextFolder } : null; },
    async listPdfs(folder, { recursive } = {}) {
      if (!folders.has(folder)) throw new Error('listPdfs: folder was not opened in this session');
      return folders.get(folder).filter((f) => recursive || !f.path.slice(folder.length + 1).includes('/')).map((f) => ({ ...f }));
    },
    async cacheGet(key) { return cache.get(String(key)) ?? null; },
    async cacheSet(key, value) {
      if (typeof value !== 'string') throw new TypeError('cache value must be a string');
      cache.set(String(key), value);
      return true;
    },
    async copyText(text) {
      if (typeof text !== 'string') throw new TypeError('copyText: text must be a string');
      if (text.length > 10 * 1024 * 1024) throw new RangeError('copyText: text too large (10 MB max)');
      copied.push(text);
      clip.text = text;
      clip.image = null;
      return true;
    },
    async readText() { return clip.text.length > 10 * 1024 * 1024 ? '' : clip.text; },
    async copyImage(bytes, text) {
      if (!(bytes instanceof Uint8Array)) throw new TypeError('copyImage: bytes must be a Uint8Array');
      if (bytes.length > 50 * 1024 * 1024) throw new RangeError('copyImage: image too large (50 MB max)');
      if (bytes.length < 8 || PNG_SIGNATURE.some((v, i) => bytes[i] !== v)) throw new TypeError('copyImage: not a PNG image');
      if (text !== undefined && typeof text !== 'string') throw new TypeError('copyImage: text must be a string');
      if (text?.length > 10 * 1024 * 1024) throw new RangeError('copyImage: text too large (10 MB max)');
      try { (await createImageBitmap(new Blob([bytes], { type: 'image/png' }))).close(); } catch { throw new Error('copyImage: the image could not be read'); }
      clip.image = new Uint8Array(bytes);
      clip.text = text ?? '';
      return true;
    },
    async readImage() { return clip.image && clip.image.length <= 50 * 1024 * 1024 ? new Uint8Array(clip.image) : null; },
    async openExternal(url) {
      const u = new URL(String(url));
      if (!['http:', 'https:', 'mailto:'].includes(u.protocol)) throw new Error(`openExternal: ${u.protocol} links are not opened`);
      opened.push(u.href);
      return true;
    },
    async libraryList(kind) {
      libKey(kind, 'x');
      return [...library].filter(([k]) => k.startsWith(`${kind}/`)).map(([k, v]) => ({ id: k.slice(kind.length + 1), meta: cloneJson(v.meta) }));
    },
    async libraryGet(kind, id) {
      const v = library.get(libKey(kind, id));
      return v ? { id, meta: cloneJson(v.meta), bytes: v.bytes.slice() } : null;
    },
    async libraryPut(kind, id, item) {
      const k = libKey(kind, id);
      if (!item || typeof item.meta !== 'object') throw new TypeError('library:put: {meta, bytes} required');
      if (JSON.stringify(item.meta).length > 64 * 1024) throw new RangeError('library meta too large (64 KiB max)');
      let bytes = library.get(k)?.bytes;
      if (item.bytes !== undefined) {
        if (!(item.bytes instanceof Uint8Array)) throw new TypeError('bytes must be a Uint8Array');
        if (item.bytes.length > 5 * 1024 * 1024) throw new RangeError('library item too large (5 MB max)');
        bytes = item.bytes.slice();
      }
      if (!bytes) throw new Error('library:put: no such item');
      library.set(k, { meta: cloneJson(item.meta), bytes });
      return true;
    },
    async libraryDelete(kind, id) { library.delete(libKey(kind, id)); return true; },
  });
}
