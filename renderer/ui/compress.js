// File > Reduce file size…: recompresses large images with src/core/optimize.js (presets High quality /
// Balanced / Smallest) on the tab's bytes as Save would write them (currentBytes: page ops, annotation
// and form hooks applied), shows the size before and after, and saves the result as a new file with
// api.saveFile. The open tab and its file are never changed. Digitally signed documents are refused.
import { activeTab } from '../state.js';
import { h, formatBytes } from './dom.js';
import { showDialog, showError, toast } from './dialogs.js';
import { currentBytes } from './office.js';

const core = () => import('../../src/core/optimize.js');

/** Renderer codec for optimizePdf: createImageBitmap decodes, OffscreenCanvas scales and encodes. */
export const canvasCodec = {
  async decodeImage(bytes) {
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    try {
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = c.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      return { width: bmp.width, height: bmp.height, data: ctx.getImageData(0, 0, bmp.width, bmp.height).data };
    } finally { bmp.close(); }
  },
  async encodeJpeg(src, { width, height, quality }) {
    const s = new OffscreenCanvas(src.width, src.height);
    const data = src.data instanceof Uint8ClampedArray ? src.data : new Uint8ClampedArray(src.data.buffer, src.data.byteOffset, src.data.length);
    s.getContext('2d').putImageData(new ImageData(data, src.width, src.height), 0, 0);
    const c = new OffscreenCanvas(width, height);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(s, 0, 0, width, height);
    return new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality })).arrayBuffer());
  },
};

function refuseSigned(name) {
  return showDialog({
    title: 'This document is digitally signed',
    body: h('div', {},
      h('p', {}, `"${name}" carries a digital signature. Reducing its size rewrites the file, which would invalidate the signature.`),
      h('p', {}, 'Reduce file size is not available for signed documents.')),
    buttons: [{ label: 'OK', value: 'ok', primary: true, cancel: true }],
    className: 'signed-dialog rz-signed-dialog',
  });
}

/** Opens the dialog for `tab`. Resolves the saved path, or null. */
export async function reduceDialog(tab = activeTab()) {
  if (!tab?.pdfDoc) return null;
  if (tab.readOnly) { await showDialog({ title: 'Read-only document', body: 'This document is encrypted: it cannot be rewritten.' }); return null; }
  let source;
  try {
    source = await currentBytes(tab);
    const { detectSignatures } = await import('../../src/core/signatures.js');
    if ((await detectSignatures(source)).signed) { await refuseSigned(tab.name); return null; }
  } catch (err) { showError('Could not reduce the file size', err); return null; }

  const { optimizePdf, PRESETS } = await core();
  const presetIds = Object.keys(PRESETS);
  const radios = presetIds.map((id) => h('input', { type: 'radio', name: 'rz-preset', value: id, id: `rz-${id}`, checked: id === 'balanced' || null }));
  const presetList = h('div.rz-presets', { role: 'radiogroup', 'aria-label': 'Preset' }, presetIds.map((id, i) => {
    const p = PRESETS[id];
    return h('label.rz-preset', { for: `rz-${id}` }, radios[i], h('span.rz-name', {}, p.label),
      h('span.rz-detail', {}, `Images up to ${p.maxDpi} dpi, JPEG quality ${Math.round(p.quality * 100)}%`));
  }));
  const before = h('output#rz-before', {}, formatBytes(source.length));
  const after = h('output#rz-after', { 'aria-live': 'polite' }, '…');
  const detail = h('p.rz-note');
  const error = h('p.vx-error', { role: 'alert' });
  const sizes = h('dl.rz-sizes', {}, h('dt', {}, 'Current size'), h('dd', {}, before), h('dt', {}, 'Reduced size'), h('dd', {}, after));

  let run = null; // { id, promise } of the latest estimate
  const estimate = () => {
    const id = radios.find((r) => r.checked)?.value ?? 'balanced';
    const p = PRESETS[id];
    after.textContent = 'Calculating…'; detail.textContent = ''; error.textContent = '';
    const promise = optimizePdf(source, { maxDpi: p.maxDpi, quality: p.quality, ...canvasCodec });
    run = { id, promise };
    promise.then((res) => {
      if (run?.promise !== promise) return;
      const pct = Math.round((1 - res.after / res.before) * 100);
      after.textContent = res.after < res.before ? `${formatBytes(res.after)} (−${pct}%)` : `${formatBytes(res.after)} (no reduction)`;
      detail.textContent = `${res.imagesRecompressed} image${res.imagesRecompressed === 1 ? '' : 's'} recompressed, ${res.skipped} left as is.`;
    }, (err) => { if (run?.promise === promise) { after.textContent = '—'; error.textContent = err?.message ?? String(err); } });
  };
  for (const r of radios) r.addEventListener('change', estimate);
  estimate();

  let result = null;
  const validate = async () => {
    try { result = await run.promise; } catch { return false; }
    if (!(result.after < result.before)) { error.textContent = 'This setting does not make the file smaller. Try a smaller preset.'; return false; }
    return true;
  };
  const res = await showDialog({
    title: 'Reduce file size',
    body: h('div.rz-form', {}, presetList, sizes, detail, error,
      h('p.rz-note', {}, 'The reduced copy is saved as a new file; this document is not changed.')),
    className: 'rz-dialog', initialFocus: '#rz-balanced',
    buttons: [{ label: 'Cancel', value: 'cancel', cancel: true }, { label: 'Save as…', value: 'save', primary: true, validate }],
  });
  run = null;
  if (res !== 'save' || !result) return null;
  try {
    const saved = await window.api.saveFile({ bytes: result.bytes, defaultPath: `${tab.name.replace(/\.pdf$/i, '')}-reduced.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (saved) toast(`Saved ${saved.path.split(/[\\/]/).pop()} (${formatBytes(result.after)})`);
    return saved?.path ?? null;
  } catch (err) { showError('Could not save the reduced file', err); return null; }
}

export function initCompress(app) {
  app.registerMenuItem('File', { id: 'reduce-size', label: 'Reduce file size…', action: () => reduceDialog(), enabled: () => !!activeTab()?.pdfDoc });
}
