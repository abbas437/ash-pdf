// Original line icons: 24x24 viewBox, 1.6 stroke, round caps, currentColor.
// icon(name) returns an SVG string; register more with addIcon(name, innerSvg).
const P = {
  open: '<path d="M3 7.5V18a1.5 1.5 0 0 0 1.5 1.5h15A1.5 1.5 0 0 0 21 18v-8a1.5 1.5 0 0 0-1.5-1.5H12L10 6H4.5A1.5 1.5 0 0 0 3 7.5z"/>',
  save: '<path d="M5 4h11l3 3v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M8 4v5h7V4"/><rect x="7.5" y="13" width="9" height="5" rx=".5"/>',
  saveAs: '<path d="M5 4h9l3 3v4"/><path d="M4 5v14a1 1 0 0 0 1 1h6"/><path d="M8 4v4h6V4"/><path d="M14.5 20l.6-2.6 5.2-5.2a1.4 1.4 0 0 1 2 2l-5.2 5.2z"/>',
  print: '<path d="M7 9V4h10v5"/><rect x="3.5" y="9" width="17" height="7.5" rx="1.5"/><path d="M7 14h10v6H7z"/><circle cx="17" cy="11.8" r=".6" fill="currentColor"/>',
  prev: '<path d="M6 15l6-6 6 6"/>',
  next: '<path d="M6 9l6 6 6-6"/>',
  zoomIn: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5M8 10.5h5M10.5 8v5"/>',
  zoomOut: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5M8 10.5h5"/>',
  rotateLeft: '<path d="M4.5 9.5A8 8 0 1 1 6 16"/><path d="M4 4.5v5h5"/>',
  rotateRight: '<path d="M19.5 9.5A8 8 0 1 0 18 16"/><path d="M20 4.5v5h-5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>',
  sidebar: '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M9.5 4.5v15M5.5 8h2M5.5 11h2"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
  select: '<path d="M6 3.5l12 7.5-5.5 1.2L10 18z"/>',
  text: '<path d="M5 6V4.5h14V6M12 4.5v15M9 19.5h6"/>',
  highlight: '<path d="M14.5 4.5l5 5-8 8H7v-4.5z"/><path d="M4 20.5h16"/>',
  draw: '<path d="M4 18c3-6 5 1 8-4s4-7 8-8"/><path d="M3.5 21h17"/>',
  shapes: '<rect x="3.5" y="10" width="9" height="9.5" rx="1"/><circle cx="15.5" cy="8.5" r="5"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><circle cx="9" cy="9.5" r="1.6"/><path d="M3.5 17l5-4.5 4 3.5 3-2.5 5 4"/>',
  whiteout: '<rect x="4" y="7" width="16" height="10" rx="1.5"/><path d="M7.5 12h9" stroke-dasharray="1.5 2.2"/>',
  redact: '<rect x="4" y="7" width="16" height="10" rx="1"/><path d="M8 17l6-10M13 17l6-10M4 14l4-7"/>',
  stamp: '<path d="M9.5 4.5h5l-1 6h-3z"/><path d="M5 13.5h14v3.5H5zM6.5 20h11"/>',
  callout: '<path d="M4.5 5h15v10h-8l-4.5 4v-4h-2.5z"/><path d="M8 9h8M8 12h5"/>',
  forms: '<rect x="3.5" y="5" width="17" height="5" rx="1"/><rect x="3.5" y="14" width="5" height="5" rx="1"/><path d="M5 16.5l1 1 1.8-2M11 16.5h8.5"/>',
  pages: '<rect x="4" y="6.5" width="11" height="14" rx="1.2"/><path d="M8 6.5V4.7A1.2 1.2 0 0 1 9.2 3.5h9.6A1.2 1.2 0 0 1 20 4.7v12.6a1.2 1.2 0 0 1-1.2 1.2H15"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.1"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="1.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  thumbs: '<rect x="4" y="3.5" width="7" height="8" rx="1"/><rect x="13" y="3.5" width="7" height="8" rx="1"/><rect x="4" y="13.5" width="7" height="7" rx="1"/><rect x="13" y="13.5" width="7" height="7" rx="1"/>',
  outline: '<path d="M8 6h12M8 12h12M11 18h9"/><circle cx="4.5" cy="6" r=".8" fill="currentColor"/><circle cx="4.5" cy="12" r=".8" fill="currentColor"/><circle cx="7.5" cy="18" r=".8" fill="currentColor"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  fitWidth: '<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M7 12h10M9 10l-2 2 2 2M15 10l2 2-2 2"/>',
  split: '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M12 4.5v15"/>',
  fitPage: '<rect x="6" y="3.5" width="12" height="17" rx="1.5"/><path d="M12 7v10M10 9l2-2 2 2M10 15l2 2 2-2"/>',
};

export function addIcon(name, inner) { P[name] = inner; }

export function icon(name, size = 18) {
  const inner = P[name] ?? P.info;
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`;
}
