// Source patches applied to pdf.js when scripts/vendor.js copies it into renderer/vendor/.
// Each patch must match exactly once; a pdf.js upgrade that changes the code makes vendoring fail
// loudly instead of silently shipping without the fix.

// Tiling patterns larger than the pattern canvas limit (TilingPattern.MAX_PATTERN_SIZE = 3000 px, or the
// output canvas size if larger) were clipped: pdf.js capped the canvas size but kept the full scale, so
// only the first 3000 px of the tile were drawn and the rest of the page area came out blank (seen as a
// white wedge over a gradient cover at high zoom). The patch always derives the scale from the capped
// size, so a large tile is drawn whole at a lower resolution. Unpatched minified code:
//   getSizeAndScale(t,e,i){const n=Math.max(TilingPattern.MAX_PATTERN_SIZE,e);let r=Math.ceil(t*i);r>=n?r=n:i=r/t;return{scale:i,size:r}}
const TILING_SCALE = /(getSizeAndScale\((\w+),(\w+),(\w+)\)\{const (\w+)=Math\.max\(TilingPattern\.MAX_PATTERN_SIZE,\3\);let (\w+)=Math\.ceil\(\2\*\4\);)\6>=\5\?\6=\5:\4=\6\/\2;/g;

export function patchPdfjs(src) {
  const hits = src.match(TILING_SCALE)?.length ?? 0;
  if (hits !== 1) throw new Error(`pdfjs-patch: TilingPattern.getSizeAndScale matched ${hits} times (expected 1); re-check the patch against this pdf.js version`);
  return src.replace(TILING_SCALE, (_, head, step, _out, scale, max, size) => `${head}${size}>=${max}&&(${size}=${max});${scale}=${size}/${step};`);
}
