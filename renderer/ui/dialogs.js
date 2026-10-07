// Modal dialogs and toasts (never window.alert/confirm/prompt).
import { h, copyText } from './dom.js';
import { icon } from './icons.js';

let dialogSeq = 0;
const openDialogs = [];

/**
 * showDialog({title, body, buttons, initialFocus, className}) → Promise<value>
 *   body: string | Node | (dialogEl) => Node
 *   buttons: [{label, value, primary?, danger?}] (default: [{label:'OK', value:'ok', primary:true}])
 *   Escape / backdrop resolve with the value of the button marked {cancel:true}, else null.
 * A button with {validate: (dialogEl) => boolean|Promise<boolean>} keeps the dialog open
 * when validate returns false.
 */
export function showDialog({ title, body, buttons, initialFocus, className } = {}) {
  buttons = buttons?.length ? buttons : [{ label: 'OK', value: 'ok', primary: true }];
  const id = `dlg-${++dialogSeq}`;
  const previousFocus = document.activeElement;
  return new Promise((resolve) => {
    const cancelValue = buttons.find((b) => b.cancel)?.value ?? null;
    const bodyEl = h('div.dialog-body', { id: `${id}-body` });
    const dialog = h('div.dialog', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': `${id}-title`, 'aria-describedby': `${id}-body`, className: `dialog ${className ?? ''}` });
    const footer = h('div.dialog-buttons');
    const backdrop = h('div.dialog-backdrop', {}, dialog);
    const finish = (value) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      openDialogs.splice(openDialogs.indexOf(backdrop), 1);
      if (previousFocus && previousFocus.isConnected) previousFocus.focus?.();
      resolve(value);
    };
    for (const b of buttons) {
      const btn = h(`button.btn${b.primary ? '.primary' : ''}${b.danger ? '.danger' : ''}`, { type: 'button', dataset: { value: String(b.value) } }, b.label);
      btn.addEventListener('click', async () => {
        if (b.validate && !(await b.validate(dialog))) return;
        finish(b.value);
      });
      footer.append(btn);
    }
    const content = typeof body === 'function' ? body(dialog) : body;
    if (content instanceof Node) bodyEl.append(content);
    else if (content != null) bodyEl.append(h('p', {}, String(content)));
    dialog.append(h('h2.dialog-title', { id: `${id}-title` }, title ?? ''), bodyEl, footer);

    function onKey(e) {
      if (openDialogs[openDialogs.length - 1] !== backdrop) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(cancelValue); return; }
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
        e.preventDefault();
        footer.querySelector('button.primary')?.click();
        return;
      }
      if (e.key === 'Tab') {
        const f = [...dialog.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"]), a[href]')].filter((x) => !x.disabled && x.offsetParent !== null);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        else if (!dialog.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener('keydown', onKey, true);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop && cancelValue !== null) finish(cancelValue); });
    openDialogs.push(backdrop);
    document.body.append(backdrop);
    const focusEl = (initialFocus && dialog.querySelector(initialFocus)) || dialog.querySelector('input') || footer.querySelector('button.primary') || footer.querySelector('button');
    focusEl?.focus();
  });
}

export const dialogOpen = () => openDialogs.length > 0;

/** Error dialog: never leaves the user with a blank screen. */
export function showError(title, err) {
  const msg = err?.message ?? String(err ?? 'Unknown error');
  return showDialog({ title, body: h('div', {}, h('p', {}, msg)), buttons: [{ label: 'Close', value: 'ok', primary: true, cancel: true }], className: 'error' });
}

/** Ask for a password; resolves to the string or null when cancelled. */
export async function askPassword(fileName, retry) {
  const input = h('input.input', { type: 'password', id: 'password-input', 'aria-label': 'Password', autocomplete: 'off' });
  const body = h('div', {},
    h('p', {}, retry ? 'The password is incorrect. Try again.' : `"${fileName}" is protected. Enter the password to open it.`),
    h('label.field', {}, h('span', {}, 'Password'), input));
  const v = await showDialog({
    title: retry ? 'Incorrect password' : 'Password required',
    body,
    buttons: [{ label: 'Cancel', value: 'cancel', cancel: true }, { label: 'Open', value: 'ok', primary: true }],
    initialFocus: '#password-input',
    className: 'password-dialog',
  });
  return v === 'ok' ? input.value : null;
}

export function confirmDiscard(name) {
  return showDialog({
    title: 'Unsaved changes',
    body: `"${name}" has unsaved changes. Save them before closing?`,
    buttons: [
      { label: 'Cancel', value: 'cancel', cancel: true },
      { label: "Don't save", value: 'discard', danger: true },
      { label: 'Save', value: 'save', primary: true },
    ],
  });
}

/** Saving rewrites the whole file: ask before overwriting a digitally signed original. */
export function confirmSignedOverwrite(name) {
  return showDialog({
    title: 'This document is digitally signed',
    body: h('div', {},
      h('p', {}, `"${name}" carries a digital signature. Saving your changes over it rewrites the file, which invalidates the signature and removes the earlier signed revisions.`),
      h('p', {}, 'Save the edited document as a separate copy to keep the signed original intact.')),
    buttons: [
      { label: 'Cancel', value: 'cancel', cancel: true },
      { label: 'Overwrite original', value: 'overwrite', danger: true },
      { label: 'Save as a copy…', value: 'copy', primary: true },
    ],
    className: 'signed-dialog',
  });
}

export function showExternalLink(url) {
  const field = h('input.input.url-field', { type: 'text', readonly: true, value: url, 'aria-label': 'Link address' });
  const status = h('span.copy-status', { role: 'status' });
  const copyBtn = h('button.btn', { type: 'button', html: icon('copy', 16) + '<span>Copy</span>' });
  copyBtn.addEventListener('click', () => { status.textContent = copyText(url) ? 'Copied' : 'Copy failed: select the text and press Ctrl+C'; });
  return showDialog({
    title: 'External link',
    body: h('div', {}, h('p', {}, 'This link points outside the document. For your safety it is not opened automatically; copy the address into your browser if you trust it.'),
      h('div.row', {}, field, copyBtn), status),
    buttons: [{ label: 'Close', value: 'ok', primary: true, cancel: true }],
    className: 'link-dialog',
  });
}

let toastHost = null;
/** Brief non-blocking notification. */
export function toast(msg, { timeout = 2600 } = {}) {
  toastHost ??= document.body.appendChild(h('div.toast-host', { role: 'status', 'aria-live': 'polite' }));
  const t = h('div.toast', {}, msg);
  toastHost.append(t);
  setTimeout(() => { t.classList.add('leaving'); setTimeout(() => t.remove(), 300); }, timeout);
  return t;
}
