// Pure helpers for File > New PDF (ui/newpdf.js): page size in points, untitled tab names.
// The table mirrors PAGE_SIZES in src/core/pdfOps.js (pinned by test/newpdf.test.js); it is copied
// rather than imported so the start-up path does not load pdf-lib.

/** Portrait [width, height] in points. */
export const SIZES = Object.freeze({
  A4: [595.28, 841.89],
  A3: [841.89, 1190.55],
  A5: [419.53, 595.28],
  Letter: [612, 792],
  Legal: [612, 1008],
});
export const SIZE_NAMES = ['A4', 'A3', 'A5', 'Letter', 'Legal'];
export const MM_MIN = 25.4;
export const MM_MAX = 5080;
export const MAX_PAGES = 500;

export const mmToPt = (mm) => (mm * 72) / 25.4;
export const ptToMm = (pt) => (pt * 25.4) / 72;

/**
 * [width, height] in points for a size name or 'custom' (customW/customH in mm). Landscape puts the
 * long side across, portrait upright, for custom sizes too. Throws RangeError for an unknown size
 * or a custom side outside 25.4..5080 mm.
 */
export function pageSizePoints({ size, orientation = 'portrait', customW, customH } = {}) {
  let w, h;
  if (size === 'custom') {
    for (const [k, v] of [['Width', customW], ['Height', customH]]) {
      if (!Number.isFinite(v) || v < MM_MIN || v > MM_MAX) throw new RangeError(`${k} must be ${MM_MIN} to ${MM_MAX} mm`);
    }
    [w, h] = [mmToPt(customW), mmToPt(customH)];
  } else if (Object.hasOwn(SIZES, size)) [w, h] = SIZES[size];
  else throw new RangeError(`Unknown page size "${size}"`);
  const landscape = orientation === 'landscape';
  return landscape === (w >= h) ? [w, h] : [h, w];
}

/**
 * First free "Untitled N.pdf" with N >= counter, skipping names already open. Returns {name, next}:
 * next is the counter for the following call.
 */
export function nextUntitledName(existingNames, counter = 1) {
  const taken = new Set(existingNames);
  let n = Math.max(1, Math.floor(counter) || 1);
  while (taken.has(`Untitled ${n}.pdf`)) n++;
  return { name: `Untitled ${n}.pdf`, next: n + 1 };
}
