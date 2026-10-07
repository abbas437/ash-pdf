// Browser fallback for window.api.
//
// In Electron, electron/preload.js exposes window.api through contextBridge and this
// module does nothing. In a plain browser (Playwright tests, `npx serve`), it installs an
// implementation with the same shape so the renderer runs identically:
//   - files come from <input type=file> and are kept in memory under pseudo paths
//     ("browser-file:<n>/<name>") so readFile()/writeFile() behave like in Electron;
//   - saving triggers a Blob download;
//   - settings live in localStorage.
// Every method returns a Promise, as the IPC-backed versions do; onOpenFile returns an
// unsubscribe function.
if (!window.api) {
  const APP_NAME = 'ASH PDF Studio';
  const files = new Map(); // pseudo path -> Uint8Array
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
      return { path };
    },
    async writeFile(path, bytes) {
      if (!files.has(path)) throw new Error('writeFile: path was not opened or saved in this session');
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
  });
}
