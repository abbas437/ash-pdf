// Pure colour helpers (no DOM): parse a CSS colour and compute the WCAG 2.x contrast ratio.
// Used by the toolbar group-colour tests to keep every group accent at >= 3:1 on the toolbar.

/** [r, g, b] (0-255) from '#rgb', '#rrggbb', 'rgb(r, g, b)' or 'rgba(r, g, b, a)' (alpha ignored). */
export function parseColor(s) {
  const t = String(s).trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(t);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16));
  m = /^#([0-9a-f]{6})$/.exec(t);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(t);
  if (m) return [m[1], m[2], m[3]].map(Number);
  throw new TypeError(`parseColor: unsupported colour ${s}`);
}

/** WCAG relative luminance of a colour (0 = black, 1 = white). */
export function luminance(color) {
  const lin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = parseColor(color).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two colours, 1 to 21. */
export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
