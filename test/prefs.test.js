import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PREF_DEFAULTS, cleanPref, initialZoom, shortLabel } from '../renderer/ui/prefs-lib.js';

test('defaults: light theme, labels off, fit width, sidebar on', () => {
  assert.equal(PREF_DEFAULTS.theme, 'light');
  assert.equal(PREF_DEFAULTS['ui.toolLabels'], false);
  assert.equal(PREF_DEFAULTS['view.defaultZoom'], 'fit-width');
  assert.equal(PREF_DEFAULTS['view.sidebarOnOpen'], true);
});

test('cleanPref keeps valid values and falls back otherwise', () => {
  assert.equal(cleanPref('theme', 'dark'), 'dark');
  assert.equal(cleanPref('theme', 'neon'), 'light');
  assert.equal(cleanPref('startup.mode', 'restore'), 'restore');
  assert.equal(cleanPref('startup.mode', undefined), 'ask');
  assert.equal(cleanPref('view.defaultZoom', '1'), '1');
  assert.equal(cleanPref('ui.toolLabels', true), true);
  assert.equal(cleanPref('ui.toolLabels', 'yes'), false);
  assert.equal(cleanPref('annotations.author', '  QA Tester '), 'QA Tester');
  assert.equal(cleanPref('annotations.author', 42), '');
  assert.equal(cleanPref('annotations.author', 'x'.repeat(500)).length, 120);
  assert.equal(cleanPref('stamps.shape', 'circle'), 'circle');
  assert.equal(cleanPref('stamps.shape', 'star'), 'rect');
});

test('initialZoom maps the default-zoom setting to a tab zoom', () => {
  assert.deepEqual(initialZoom('fit-page'), { zoomMode: 'fit-page', zoom: 1 });
  assert.deepEqual(initialZoom('1'), { zoomMode: 'custom', zoom: 1 });
  assert.deepEqual(initialZoom('last', 1.5), { zoomMode: 'custom', zoom: 1.5 });
  assert.deepEqual(initialZoom('last', 'fit-page'), { zoomMode: 'fit-page', zoom: 1 });
  assert.deepEqual(initialZoom('last', null), { zoomMode: 'fit-width', zoom: 1 });
  assert.deepEqual(initialZoom('last', 99), { zoomMode: 'fit-width', zoom: 1 });
});

test('shortLabel trims tooltips to a short caption', () => {
  assert.equal(shortLabel('Save as (Ctrl+Shift+S)'), 'Save as');
  assert.equal(shortLabel('Open (Ctrl+O)'), 'Open');
  assert.equal(shortLabel('Highlight: added in next build'), 'Highlight');
  assert.equal(shortLabel('Previous page (Page Up)'), 'Previous');
  assert.equal(shortLabel('Show / hide sidebar (Ctrl+B)'), 'Sidebar');
  assert.equal(shortLabel('Rotate view left'), 'Rotate L');
  assert.equal(shortLabel(undefined), '');
});
