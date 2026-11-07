// Compare worker client (renderer/ui/compare-client.js) in Node: when the Worker constructor throws, the compare
// runs on the main thread instead of failing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareWorker } from '../renderer/ui/compare-client.js';

const img = () => new Uint8ClampedArray(40 * 40 * 4).fill(255);

test('a Worker constructor that throws falls back to the main thread (and stays there)', async () => {
  let made = 0;
  globalThis.Worker = class { constructor() { made++; throw new Error('Workers are blocked'); } };
  const warn = console.warn; console.warn = () => {};
  try {
    for (let k = 0; k < 2; k++) {
      const cmp = await compareWorker.compare(img(), img(), 40, 40, {});
      assert.equal(compareWorker.ranOn, 'main');
      assert.ok(cmp.composite && cmp.regions.length === 0);
    }
    assert.equal(made, 1, 'not retried once marked broken');
    assert.equal(compareWorker.inWorker, false);
  } finally { console.warn = warn; delete globalThis.Worker; }
});
