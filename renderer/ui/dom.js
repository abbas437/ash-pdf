// DOM helpers used by every UI module.

/**
 * h('button.btn#open', {title: 'Open', onclick: fn, 'aria-label': 'Open'}, child, ...)
 * Tag string supports .class and #id suffixes. Props: on* functions become listeners,
 * `dataset`/`style` objects are merged, `html` sets innerHTML (only for our own SVG
 * strings), other keys become attributes (false/null skipped, true => "").
 */
export function h(spec, props = {}, ...children) {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(spec);
  const el = document.createElement(m?.[1] || 'div');
  for (const part of (m?.[2] ?? '').match(/[.#][\w-]+/g) ?? []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'className') el.className = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const isMac = /Mac/.test(navigator.platform);

/** True when the keyboard focus is in a text entry, so global shortcuts must not fire. */
export function isTyping(target = document.activeElement) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true;
  return target.tagName === 'INPUT' && !/^(button|checkbox|radio|range|color|submit|reset)$/i.test(target.type);
}

/** Copy text without navigator.clipboard (permission requests are denied in the app). */
export function copyText(text) {
  const ta = h('textarea', { style: { position: 'fixed', left: '-9999px', top: '0' }, 'aria-hidden': 'true' });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Keep an open popover (toolbar dropdown) inside the window: capped to the window width
 * and to the height left below its top (then it scrolls); when it runs past the right edge it is
 * right-aligned to its `anchor` button, then shifted to stay `margin` px from either edge. Call after
 * un-hiding and filling it; the CSS placement stays the base, only a `translate` is added.
 */
export function fitPopover(el, anchor, margin = 8) {
  el.style.translate = '';
  el.style.maxWidth = `${Math.max(0, innerWidth - 2 * margin)}px`;
  let r = el.getBoundingClientRect();
  el.style.maxHeight = `${Math.max(80, innerHeight - margin - r.top)}px`;
  el.style.overflowY = 'auto';
  r = el.getBoundingClientRect();
  let dx = 0;
  if (r.right > innerWidth - margin) dx = (anchor ? Math.min(anchor.getBoundingClientRect().right, innerWidth - margin) : innerWidth - margin) - r.right;
  dx = Math.max(dx, margin - r.left);
  if (dx) el.style.translate = `${Math.round(dx)}px 0`;
}
