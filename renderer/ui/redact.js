// Apply redactions: Document > Apply redactions… and the button in the Redact tool's options bar.
// The redactMark objects (Redact tool, X) are applied with PDFium (pdfium/redact.js: text, image
// pixels, vector shapes and annotations under the areas go; an optional fill box is drawn), then the
// document metadata is scrubbed if asked. It is one page-operation undo step (runOp, identity map):
// the marks, the burned-in whiteouts and the overlay objects whose annotation PDFium removed go with
// it (res.remove), Undo brings them back with the old bytes and Redo removes them again.
//
// The bytes redacted are the tab's bytes as Save would write them (every beforeSave hook applied, so
// unsaved annotations and typed form values under a mark are removed too). The hooks run directly on
// the bytes: office.currentBytes() waits for pagetools idle() and would deadlock inside runOp.
import { state, activeTab } from '../state.js';
import { h } from './dom.js';
import { showDialog, toast } from './dialogs.js';
import { runOp } from './pagetools.js';
import { pdfium } from '../pdfium/client.js';
import { markAreas, scrubMetadata } from './redact-lib.js';

const FILLS = { black: [0, 0, 0], white: [255, 255, 255], none: null };
const marksOf = (tab) => (tab?.objects ?? []).filter((o) => o.type === 'redactMark');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Options bar of the Redact tool: the Apply button. */
export function redactOptions(c) {
  c.append(h('button.btn.rd-apply', { type: 'button', onclick: () => applyRedactionsDialog(activeTab()) }, 'Apply redactions…'));
}

/** The dialog; resolves true when the redactions were applied. */
export async function applyRedactionsDialog(tab = activeTab()) {
  if (!tab) return false;
  if (tab.readOnly) { toast('Encrypted document: redaction is not supported'); return false; }
  const marks = marksOf(tab);
  if (!marks.length) { toast('No redaction marks: mark areas with the Redact tool (X) first'); return false; }
  let signed = false;
  try { signed = (await (await import('../../src/core/signatures.js')).detectSignatures(tab.bytes)).signed; } catch { /* not decisive: no extra warning */ }
  const pages = new Set(marks.map((o) => o.page)).size;
  const fill = (value, label) => h('label.rd-fill', {}, h('input', { type: 'radio', name: 'rd-fill', value, checked: value === 'black' }), h('span', {}, label));
  const meta = h('input.rd-meta', { type: 'checkbox' });
  const form = h('div.pt-form.rd-form', {},
    h('p.rd-count', {}, `${plural(marks.length, 'mark')} on ${plural(pages, 'page')}.`),
    h('fieldset.pt-fieldset', {}, h('legend', {}, 'Fill the redacted areas'), fill('black', 'Black'), fill('white', 'White'), fill('none', 'None')),
    h('label.rd-meta-row', {}, meta, h('span', {}, 'Also remove document metadata (title, author, subject, keywords, XMP)')),
    h('p.rd-warn', {}, 'Redaction permanently removes the marked content. You can undo until you save; after saving it cannot be recovered.'),
    signed ? h('p.rd-warn.rd-signed', {}, 'Signatures in this document will become invalid.') : null);
  const v = await showDialog({
    title: 'Apply redactions', body: form, className: 'pt-dialog rd-dialog', initialFocus: 'input[name="rd-fill"]:checked',
    buttons: [{ label: 'Cancel', value: 'cancel', cancel: true }, { label: 'Apply', value: 'ok', primary: true }],
  });
  if (v !== 'ok') return false;
  const fillColor = FILLS[form.querySelector('input[name="rd-fill"]:checked')?.value ?? 'black'];
  const scrub = meta.checked;
  const ok = await runOp(tab, 'Apply redactions', (bytes, n) => applyRedactions(tab, bytes, n, { fill: fillColor, scrub }));
  if (ok) toast(`Applied ${plural(marks.length, 'redaction')}`);
  return ok;
}

/** runOp fn: {bytes, map (identity), remove} of the redacted document. */
async function applyRedactions(tab, bytes, n, { fill, scrub }) {
  const marks = marksOf(tab);
  if (!marks.length) return null;
  let src = bytes;
  for (const hook of state.hooks.beforeSave) {
    const out = await hook(tab, src);
    if (out instanceof Uint8Array) src = out;
  }
  const areas = await markAreas(src, marks);
  const id = await pdfium.open(src);
  let out = src;
  try {
    out = await pdfium.redact(id, areas, { fill });
  } finally { await pdfium.close(id).catch(() => {}); }
  if (scrub) out = await scrubMetadata(out);
  // Overlay objects now obsolete: the marks, whiteouts (burned in by the hook) and objects whose annotation went.
  const { readAnnotations } = await import('../../src/core/index.js');
  const left = new Set((await readAnnotations(out)).objects.map((r) => r.id));
  const written = new Set((await readAnnotations(src)).objects.map((r) => r.id));
  const remove = tab.objects.filter((o) => o.type === 'redactMark' || o.type === 'whiteout' || (written.has(o.id) && !left.has(o.id))).map((o) => o.id);
  return { bytes: out, map: new Map(Array.from({ length: n }, (_, i) => [i, i])), remove };
}
