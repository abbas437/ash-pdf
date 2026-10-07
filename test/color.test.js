import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseColor, contrastRatio } from '../renderer/ui/color-lib.js';
import { PREF_DEFAULTS, cleanPref } from '../renderer/ui/prefs-lib.js';

test('parseColor reads hex and rgb()', () => {
  assert.deepEqual(parseColor('#fff'), [255, 255, 255]);
  assert.deepEqual(parseColor('#16261F'), [22, 38, 31]);
  assert.deepEqual(parseColor('rgb(1, 2, 3)'), [1, 2, 3]);
  assert.deepEqual(parseColor('rgba(10, 20, 30, 0.5)'), [10, 20, 30]);
  assert.throws(() => parseColor('teal'), TypeError);
});

test('contrastRatio follows WCAG', () => {
  assert.equal(contrastRatio('#000', '#fff'), 21);
  assert.equal(contrastRatio('#abc', '#abc'), 1);
  assert.equal(contrastRatio('#fff', '#000'), contrastRatio('#000', '#fff'));
  assert.ok(Math.abs(contrastRatio('#777777', '#ffffff') - 4.48) < 0.01);
});

// The toolbar sits on --bg; every group accent must reach 3:1 on it in both themes.
function tokens(block) {
  const out = {};
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
test('tool group colours reach 3:1 on the toolbar in light and dark', () => {
  const css = readFileSync(new URL('../renderer/styles.css', import.meta.url), 'utf8');
  const light = tokens(/:root\s*\{([^}]*)\}/.exec(css)[1]);
  const dark = { ...light, ...tokens(/\[data-theme="dark"\]\s*\{([^}]*)\}/.exec(css)[1]) };
  const groups = ['navigate', 'pages', 'view', 'edit', 'comment', 'sign'];
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    const val = (k) => { let v = t[k]; while (v?.startsWith('var(')) v = t[v.slice(4, -1)]; return v; };
    const seen = new Set();
    for (const g of groups) {
      const c = val(`--grp-${g}`);
      assert.ok(c, `${name}: --grp-${g} missing`);
      const r = contrastRatio(c, val('--bg'));
      assert.ok(r >= 3, `${name}: --grp-${g} ${c} on ${val('--bg')} is ${r.toFixed(2)}:1`);
      seen.add(c.toLowerCase());
    }
    assert.equal(seen.size, groups.length, `${name}: group colours are not distinct`);
  }
});

test('ui.toolColors defaults on and cleans to a boolean', () => {
  assert.equal(PREF_DEFAULTS['ui.toolColors'], true);
  assert.equal(cleanPref('ui.toolColors', false), false);
  assert.equal(cleanPref('ui.toolColors', 'no'), true);
});
