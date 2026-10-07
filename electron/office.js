// Office conversions (main process): PDF -> Word (.docx) and Word/Excel/PowerPoint -> PDF through the
// Microsoft Office installed on the PC (owner decision), driven by COM automation from PowerShell.
//
// Safety rules
//   - powershell.exe is spawned with an argument ARRAY and shell:false: paths never pass through a
//     command line string, so spaces, quotes, unicode, ';' and '&' arrive as single arguments.
//   - Every path is absolute; output paths come from a save dialog shown here, input paths from an
//     open dialog shown here (or a temp file this module wrote).
//   - The scripts (electron/office/*.ps1) keep Word/Excel invisible with alerts off, always Quit in
//     `finally`, and exit 2 with "<app> is not installed" when COM creation fails. A run is killed
//     after OFFICE_TIMEOUT_MS.
//   - Scripts live inside app.asar when packaged, which powershell.exe cannot read: they are copied
//     into a fresh temp folder per run, which is removed afterwards.
//
// Tests: in unpackaged builds ASH_TEST_FAKE_OFFICE=1 swaps the runner for a fake that records the
// arguments (globalThis.__ashOfficeCalls, for the Electron e2e) and writes a small fixed output file;
// ASH_TEST_FAKE_OFFICE=missing (read at each run) fails with "not installed".
// This module does not import 'electron'; main.js passes what it needs (registerOfficeIpc).
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OFFICE_TIMEOUT_MS = 120_000;
const SCRIPT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'office');
export const SCRIPTS = { pdfToDocx: 'pdf-to-docx.ps1', officeToPdf: 'office-to-pdf.ps1' };
export const KINDS = { doc: 'word', docx: 'word', rtf: 'word', xls: 'excel', xlsx: 'excel', ppt: 'powerpoint', pptx: 'powerpoint' };
export const UNAVAILABLE = 'Requires Microsoft Office on Windows';

/** An absolute path without NUL or control characters, else throws. */
export function checkPath(p, what = 'path') {
  if (typeof p !== 'string' || !p || p.length >= 4096 || !isAbsolute(p) || /[\u0000-\u001f]/.test(p)) throw new TypeError(`${what} must be an absolute path`);
  return p;
}

/** powershell.exe arguments running `script` with `args`, one array element per argument. */
export function powershellArgs(script, args) {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', checkPath(script, 'script'), ...args.map(String)];
}

/** Spawn `command` with `args` (array, no shell). -> {code, stdout, stderr}; rejects on timeout (the process is killed). */
export function runProcess(command, args, { timeoutMs = OFFICE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Microsoft Office did not finish within ${Math.round(timeoutMs / 1000)} s`)); }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** Run a bundled script with powershell.exe. Exit 0 -> resolves; otherwise rejects with the script's message. */
export async function runScript(name, args, { run = runProcess, timeoutMs } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ash-office-'));
  try {
    const script = join(dir, name);
    await writeFile(script, await readFile(join(SCRIPT_DIR, name)));
    const res = await run('powershell.exe', powershellArgs(script, args), { timeoutMs });
    if (res.code !== 0) throw new Error(res.stderr.trim().split(/\r?\n/).pop() || `Microsoft Office conversion failed (exit code ${res.code})`);
    return res;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Test runner (ASH_TEST_FAKE_OFFICE): records the call and writes a fixed output file to the last argument. */
export function fakeRunner(mode, calls) {
  return async (command, args) => {
    calls.push({ command, args: [...args], script: await readFile(args[5], 'utf8') });
    if ((typeof mode === 'function' ? mode() : mode) === 'missing') return { code: 2, stdout: '', stderr: 'Microsoft Word is not installed\n' };
    await writeFile(args[args.length - 1], args[args.length - 1].toLowerCase().endsWith('.pdf') ? FAKE_PDF : 'ASH fake Office output');
    return { code: 0, stdout: '', stderr: '' };
  };
}
const FAKE_PDF = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
  + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';

/**
 * IPC for the conversions. ctx = {handle, dialog, getWindow, grant, describeFile, isPackaged, platform, env}.
 *   office:status         -> {available, reason}
 *   office:exportDocx     ({bytes, defaultPath}) -> {path} | null   (bytes: the current PDF, annotations included)
 *   office:toPdf          ()                     -> file {path, name, bytes} | null
 */
export function registerOfficeIpc(ctx) {
  const env = ctx.env ?? process.env;
  const fake = !ctx.isPackaged && env.ASH_TEST_FAKE_OFFICE ? env.ASH_TEST_FAKE_OFFICE : null;
  const calls = [];
  const run = fake ? fakeRunner(() => env.ASH_TEST_FAKE_OFFICE, calls) : runProcess;
  if (fake) globalThis.__ashOfficeCalls = calls;
  const available = !!fake || (ctx.platform ?? process.platform) === 'win32';
  const need = () => { if (!available) throw new Error(UNAVAILABLE); };
  const saveDialog = async (defaultPath, filter) => {
    const { canceled, filePath } = await ctx.dialog.showSaveDialog(ctx.getWindow(), { defaultPath, filters: [filter] });
    return canceled || !filePath ? null : checkPath(filePath, 'output path');
  };

  ctx.handle('office:status', () => ({ available, reason: available ? null : UNAVAILABLE }));
  ctx.handle('office:exportDocx', async (opts) => {
    need();
    if (!opts || typeof opts !== 'object' || !(opts.bytes instanceof Uint8Array)) throw new TypeError('office:exportDocx: {bytes} required');
    const name = typeof opts.defaultPath === 'string' ? opts.defaultPath.slice(0, 1024) : 'document.docx';
    const out = await saveDialog(name, { name: 'Word document', extensions: ['docx'] });
    if (!out) return null;
    const dir = await mkdtemp(join(tmpdir(), 'ash-office-in-'));
    try {
      const pdf = join(dir, 'document.pdf');
      await writeFile(pdf, opts.bytes);
      await runScript(SCRIPTS.pdfToDocx, [pdf, out], { run });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    ctx.grant(out);
    return { path: out };
  });
  ctx.handle('office:toPdf', async () => {
    need();
    const { canceled, filePaths } = await ctx.dialog.showOpenDialog(ctx.getWindow(), {
      properties: ['openFile'], filters: [{ name: 'Office files', extensions: Object.keys(KINDS) }],
    });
    if (canceled || !filePaths[0]) return null;
    const input = checkPath(filePaths[0], 'input path');
    const kind = KINDS[extname(input).slice(1).toLowerCase()];
    if (!kind) throw new Error('Choose a Word, Excel or PowerPoint file');
    const out = await saveDialog(input.replace(/\.[^.\\/]+$/, '') + '.pdf', { name: 'PDF document', extensions: ['pdf'] });
    if (!out) return null;
    await runScript(SCRIPTS.officeToPdf, [kind, input, out], { run });
    ctx.grant(out);
    return ctx.describeFile(out);
  });
}
