// Tiny synchronous event bus shared by every renderer module.
//
//   import { bus } from './bus.js';
//   const off = bus.on('page:rendered', ({ tab, pageIndex }) => { ... });
//   off();                       // or bus.off('page:rendered', fn)
//   bus.emit('tab:bytesChanged', { tab });
//
// Events emitted by the UI shell (see docs/UI-ARCHITECTURE.md for payloads):
//   tab:opened, tab:closed, tab:activated, tab:bytesChanged, tab:dirtyChanged,
//   page:rendered, page:changed, zoom:changed, rotation:changed, tool:changed,
//   state:changed, search:changed, theme:changed
// A listener that throws is reported on the console (warn level) and does not stop the others.
const listeners = new Map(); // event -> Set<fn>

export const bus = {
  on(event, fn) {
    if (typeof fn !== 'function') throw new TypeError('bus.on: listener must be a function');
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => bus.off(event, fn);
  },
  once(event, fn) {
    const off = bus.on(event, (payload) => { off(); fn(payload); });
    return off;
  },
  off(event, fn) {
    listeners.get(event)?.delete(fn);
  },
  emit(event, payload) {
    for (const fn of [...(listeners.get(event) ?? [])]) {
      try {
        const r = fn(payload);
        if (r && typeof r.catch === 'function') r.catch((err) => console.warn(`[bus] async listener for ${event} failed:`, err));
      } catch (err) {
        console.warn(`[bus] listener for ${event} failed:`, err);
      }
    }
  },
};
