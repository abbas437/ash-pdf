// Preload for the sandboxed renderer (webPreferences.sandbox: true).
//
// Sandboxed preloads are evaluated by Electron as a plain CommonJS-style script with a
// limited `require` (only 'electron' and a few built-ins), regardless of the package's
// "type": "module" — so this file must stay CommonJS: no import/export statements.
//
// The surface below is the whole renderer <-> main contract; it is documented in
// README.md ("Renderer contract: window.api") and mirrored by renderer/shim.js.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  isElectron: true,
  version: () => ipcRenderer.invoke('app:version'),
  openFiles: (opts) => ipcRenderer.invoke('dialog:open', opts ?? {}),
  readFile: (path) => ipcRenderer.invoke('file:read', path),
  saveFile: (opts) => ipcRenderer.invoke('dialog:save', opts ?? {}),
  writeFile: (path, bytes) => ipcRenderer.invoke('file:write', path, bytes),
  getLaunchFiles: () => ipcRenderer.invoke('app:launchFiles'),
  onOpenFile: (cb) => {
    if (typeof cb !== 'function') throw new TypeError('onOpenFile: callback required');
    const listener = (_event, file) => cb(file);
    ipcRenderer.on('app:openFile', listener);
    return () => ipcRenderer.removeListener('app:openFile', listener);
  },
  print: () => ipcRenderer.invoke('app:print'),
  setTitle: (title) => ipcRenderer.invoke('app:setTitle', title),
  showItem: (path) => ipcRenderer.invoke('shell:showItem', path),
  settingsGet: (key) => ipcRenderer.invoke('app:settingsGet', key),
  settingsSet: (key, value) => ipcRenderer.invoke('app:settingsSet', key, value),
  // ---- advanced search
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  listPdfs: (folder, opts) => ipcRenderer.invoke('search:listPdfs', folder, opts ?? {}),
  cancelSearch: () => ipcRenderer.invoke('search:cancel'),
  cacheGet: (key) => ipcRenderer.invoke('search:cacheGet', key),
  cacheSet: (key, value) => ipcRenderer.invoke('search:cacheSet', key, value),
  // signature library (kind: 'signature')
  libraryList: (kind) => ipcRenderer.invoke('library:list', kind),
  libraryGet: (kind, id) => ipcRenderer.invoke('library:get', kind, id),
  libraryPut: (kind, id, item) => ipcRenderer.invoke('library:put', kind, id, item),
  libraryDelete: (kind, id) => ipcRenderer.invoke('library:delete', kind, id),
});
