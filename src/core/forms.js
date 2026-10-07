// AcroForm field listing / filling / flattening for ASH PDF Studio.
import {
  PDFTextField,
  PDFCheckBox,
  PDFRadioGroup,
  PDFDropdown,
  PDFOptionList,
  PDFButton,
  PDFSignature,
  PDFName,
  PDFDict,
  PDFArray,
  PDFRef,
  PDFHexString,
} from 'pdf-lib';
import { loadPdf, saveEdited, pageGeometry, pdfRectToVisible, coreError } from './internal.js';
import { sanitizeText } from './annotate.js';

function fieldType(field) {
  if (field instanceof PDFTextField) return 'text';
  if (field instanceof PDFCheckBox) return 'checkbox';
  if (field instanceof PDFRadioGroup) return 'radio';
  if (field instanceof PDFDropdown) return 'dropdown';
  if (field instanceof PDFOptionList) return 'optionlist';
  if (field instanceof PDFButton) return 'button';
  if (field instanceof PDFSignature) return 'signature';
  return 'unknown';
}

function widgetPageIndex(doc, widget, widgetRef) {
  const pages = doc.getPages();
  const p = widget.P();
  if (p instanceof PDFRef) {
    const idx = pages.findIndex((pg) => pg.ref === p || (pg.ref.objectNumber === p.objectNumber && pg.ref.generationNumber === p.generationNumber));
    if (idx >= 0) return idx;
  }
  // Fall back to scanning page /Annots for the widget.
  for (let i = 0; i < pages.length; i++) {
    const annots = pages[i].node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) continue;
    for (let k = 0; k < annots.size(); k++) {
      const a = annots.get(k);
      if ((widgetRef && a === widgetRef) || annots.lookup(k) === widget.dict) return i;
    }
  }
  return -1;
}

function widgetRefOf(doc, widget) {
  return doc.context.getObjectRef(widget.dict);
}

/** List all fields with their first widget's page and visible-space rect. */
export async function listFields(bytes) {
  const doc = await loadPdf(bytes);
  const af = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (!af) return [];
  const form = doc.getForm();
  return form.getFields().map((field) => {
    const type = fieldType(field);
    const entry = { name: field.getName(), type, value: null, readOnly: field.isReadOnly(), pageIndex: -1, rect: null };
    switch (type) {
      case 'text':
        entry.value = field.getText() ?? '';
        entry.multiline = field.isMultiline();
        entry.maxLength = field.getMaxLength() ?? null;
        break;
      case 'checkbox':
        entry.value = field.isChecked();
        break;
      case 'radio':
        entry.value = field.getSelected() ?? null;
        entry.options = field.getOptions();
        break;
      case 'dropdown':
        entry.value = field.getSelected()[0] ?? '';
        entry.options = field.getOptions();
        break;
      case 'optionlist':
        entry.value = field.getSelected();
        entry.options = field.getOptions();
        break;
      default:
        break;
    }
    const widgets = field.acroField.getWidgets();
    if (widgets.length) {
      const w = widgets[0];
      const idx = widgetPageIndex(doc, w, widgetRefOf(doc, w));
      entry.pageIndex = idx;
      if (idx >= 0) {
        const r = w.getRectangle();
        entry.rect = pdfRectToVisible(pageGeometry(doc.getPage(idx)), r.x, r.y, r.width, r.height);
      }
    }
    return entry;
  });
}

/**
 * Fill fields by name. Values: text -> string, checkbox -> boolean,
 * radio -> option string (or null to clear), dropdown -> string,
 * optionlist -> string | string[].
 */
export async function fillFields(bytes, values, { flatten = false, updateAppearances = true } = {}) {
  if (!values || typeof values !== 'object') throw new TypeError('values must be an object of {fieldName: value}');
  const doc = await loadPdf(bytes);
  const form = doc.getForm();
  const rawText = new Map();
  for (const [name, value] of Object.entries(values)) {
    const field = form.getFieldMaybe(name);
    if (!field) throw coreError('FIELD_NOT_FOUND', `No form field named "${name}"`);
    const type = fieldType(field);
    switch (type) {
      case 'text': {
        const raw = value == null ? '' : String(value);
        const safe = sanitizeText(raw);
        field.setText(safe === '' ? undefined : safe);
        if (safe !== raw) rawText.set(field, raw);
        break;
      }
      case 'checkbox':
        if (value) field.check();
        else field.uncheck();
        break;
      case 'radio':
        if (value == null || value === '') field.clear();
        else field.select(String(value));
        break;
      case 'dropdown':
      case 'optionlist':
        if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) field.clear();
        else field.select(Array.isArray(value) ? value.map(String) : String(value));
        break;
      default:
        throw coreError('FIELD_NOT_FILLABLE', `Field "${name}" is a ${type} field and cannot be filled`);
    }
  }
  if (updateAppearances || flatten) form.updateFieldAppearances();
  // Appearances use the WinAnsi-safe text; keep the exact Unicode value in /V.
  for (const [field, raw] of rawText) field.acroField.setValue(PDFHexString.fromText(raw));
  if (flatten) form.flatten({ updateFieldAppearances: false });
  return saveEdited(doc, { updateFieldAppearances: false });
}

/** Burn every field's appearance into the page and remove the form. */
export async function flattenForm(bytes) {
  const doc = await loadPdf(bytes);
  const af = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (af) {
    const form = doc.getForm();
    form.flatten();
    doc.catalog.delete(PDFName.of('AcroForm'));
  }
  return saveEdited(doc, { updateFieldAppearances: false });
}
