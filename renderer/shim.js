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
if (!window.api) {
  const APP_NAME = 'ASH PDF Studio';
  const files = new Map(); // pseudo path -> Uint8Array
  // Like main: only paths from the open dialog or a save dialog may be written; folder grants are read-only.
  const writable = new Set();
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
    async getLaunchFiles() { return []; },
    onOpenFile(cb) {
      if (typeof cb !== 'function') throw new TypeError('onOpenFile: callback required');
      return () => {};
    },
    async print() { window.print(); return { ok: true }; },
    async setTitle(t) {
      const s = typeof t === 'string' ? t.trim() : '';
      document.title = s ? `${s} — ${APP_NAME}` : APP_NAME;
    },
    async showItem() { return false; },
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
