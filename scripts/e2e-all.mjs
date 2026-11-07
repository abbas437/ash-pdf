#!/usr/bin/env node
// Runs every end-to-end test in test/e2e one after another and reports the failures at the end.
//   node scripts/e2e-all.mjs            browser tests (Chromium through playwright-core; CHROMIUM_PATH / CHROME_PATH)
//   node scripts/e2e-all.mjs --electron the Electron tests (electron*.mjs; on Linux run under xvfb-run, as a non-root user)
// Each test is a standalone script that exits non-zero on failure. Used by the e2e job in .github/workflows/build.yml.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const dir = join(root, 'test', 'e2e');
const electron = process.argv.includes('--electron');
const timeoutMs = Number(process.env.E2E_TIMEOUT_MS) > 0 ? Number(process.env.E2E_TIMEOUT_MS) : 300_000;
const files = readdirSync(dir).filter((f) => f.endsWith('.mjs') && f.startsWith('electron') === electron).sort();

const failed = [];
const t0 = Date.now();
for (const f of files) {
  const t = Date.now();
  const r = spawnSync(process.execPath, [join(dir, f)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const secs = ((Date.now() - t) / 1000).toFixed(1);
  if (r.status === 0) { console.log(`ok   ${f} (${secs}s)`); continue; }
  const why = r.error ? r.error.message : r.signal ? `signal ${r.signal}` : `exit ${r.status}`;
  console.log(`FAIL ${f} (${secs}s, ${why})`);
  console.log(`${(r.stdout ?? '').slice(-3000)}${(r.stderr ?? '').slice(-3000)}`.replace(/^/gm, '     '));
  failed.push(f);
}
console.log(`\n${files.length - failed.length}/${files.length} e2e tests passed in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
if (failed.length) { console.log(`failed: ${failed.join(', ')}`); process.exit(1); }
if (!files.length) { console.log('no e2e tests found'); process.exit(1); }
