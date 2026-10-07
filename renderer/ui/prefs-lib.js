// Pure helpers for Edit > Preferences (no DOM): the default value of every user setting the
// dialog edits, value cleaning for what comes back from the settings store, the zoom a new
// tab opens at, and the short text shown under a toolbar icon when tool labels are on.

/** Default of each setting edited by the Preferences dialog (keys are the settings-store keys). */
export const PREF_DEFAULTS = Object.freeze({
  theme: 'light',
  'startup.mode': 'ask',             // read by electron/main.js startupMode()
  'open.target': 'tab',              // read by electron/main.js when files arrive
  'view.defaultZoom': 'fit-width',   // 'fit-width' | 'fit-page' | '1' | 'last'
  'view.sidebarOnOpen': true,
  'annotations.author': '',          // '' = the built-in author name (annotations.js DEFAULT_AUTHOR)
  'stamps.shape': 'rect',
  'ui.toolLabels': false,
  'ui.toolColors': true,             // group colours on the toolbar icons
});

export const PREF_CHOICES = Object.freeze({
  theme: ['light', 'dark'],
  'startup.mode': ['ask', 'restore', 'new'],
  'open.target': ['tab', 'window'],
  'view.defaultZoom': ['fit-width', 'fit-page', '1', 'last'],
  'stamps.shape': ['rect', 'rounded', 'circle', 'ellipse'],
});

export const AUTHOR_MAX = 120;

/** A stored value for `key` made safe: anything unexpected falls back to the default. */
export function cleanPref(key, value) {
  const def = PREF_DEFAULTS[key];
  if (PREF_CHOICES[key]) return PREF_CHOICES[key].includes(String(value)) ? String(value) : def;
  if (typeof def === 'boolean') return typeof value === 'boolean' ? value : def;
  if (key === 'annotations.author') return typeof value === 'string' ? value.trim().slice(0, AUTHOR_MAX) : def;
  return def;
}

/** Zoom a newly opened tab starts at: {zoomMode, zoom}. `last` is the remembered 'view.lastZoom'. */
export function initialZoom(defaultZoom, last) {
  let z = defaultZoom === 'last' ? last : defaultZoom;
  if (z === 'fit-width' || z === 'fit-page') return { zoomMode: z, zoom: 1 };
  z = Number(z);
  if (Number.isFinite(z) && z >= 0.1 && z <= 8) return { zoomMode: 'custom', zoom: z };
  return { zoomMode: 'fit-width', zoom: 1 };
}

const SHORT = new Map([
  ['previous page', 'Previous'], ['next page', 'Next'], ['rotate view left', 'Rotate L'], ['rotate view right', 'Rotate R'],
  ['show / hide sidebar', 'Sidebar'], ['dark theme', 'Theme'], ['light theme', 'Theme'],
  ['highlight area', 'Area'], ['highlight text', 'Highlight'], ['underline text', 'Underline'], ['strikeout text', 'Strike'],
  ['squiggly underline', 'Squiggly'], ['sticky note', 'Note'], ['callout comment', 'Callout'], ['markup + comment', 'Markup'],
]);

/** Short label for a toolbar button from its tooltip: 'Save as (Ctrl+Shift+S)' -> 'Save as'. */
export function shortLabel(title) {
  let s = String(title ?? '').replace(/\([^)]*\)/g, ' ').replace(/:.*$/, '').replace(/\s+/g, ' ').trim();
  s = SHORT.get(s.toLowerCase()) ?? s;
  if (s.length > 12) s = s.split(' ')[0];
  return s;
}
