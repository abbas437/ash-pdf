#!/usr/bin/env node
// Runs the REAL Electron app (electron binary + a display, e.g. xvfb-run, as a non-root user) and opens a PDF
// passed on the command line. env: ELECTRON_BIN (optional; defaults to the installed electron package).
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const electronBin = process.env.ELECTRON_BIN || createRequire(import.meta.url)('electron');
const tmp = await mkdtemp(join(tmpdir(), 'ash-pdf-e2e-'));
const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
for (let n = 1; n <= 3; n++) doc.addPage([612, 792]).drawText(`Electron page ${n}`, { x: 72, y: 700, size: 28, font });
const pdfPath = join(tmp, 'sample.pdf');
await writeFile(pdfPath, await doc.save());

let step = 'launch';
const app = await electron.launch({ executablePath: electronBin, args: ['--disable-gpu', root, pdfPath], cwd: root });
try {
  const problems = [];
  const win = await app.firstWindow();
  win.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  win.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  step = 'opens the PDF given on the command line';
  await win.waitForFunction(() => window.ashStudio?.state.tabs.some((t) => t.name === 'sample.pdf' && t.view), null, { timeout: 30000 });
  step = 'page 1 renders';
  await win.waitForFunction(() => {
    const a = window.ashStudio, t = a.state.tabs.find((x) => x.id === a.state.activeId);
    return t?.view?.pageEls[0]?.classList.contains('rendered');
  }, null, { timeout: 30000 });
  const pages = await win.locator('.viewer-scroll:not([hidden]) .page').count();
  if (pages !== 3) throw new Error(`expected 3 pages, saw ${pages}`);
  if (process.env.E2E_SHOTS) await win.screenshot({ path: join(process.env.E2E_SHOTS, 'electron_pdf.png') });
  step = 'no renderer errors';
  if (problems.length) throw new Error(problems.join('\n'));
  console.log('pdf electron e2e: OK');
} catch (err) {
  console.error(`pdf electron e2e FAILED at step "${step}":`, err.message);
  process.exitCode = 1;
} finally {
  await app.close();
  await rm(tmp, { recursive: true, force: true });
}
