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
//     after OFFICE_TIMEOUTS[script] or when the user cancels (office:cancel).
//   - Killing powershell.exe does not end the Office application it started: each script prints
//     `OFFICE_PID <n>` (the one new WINWORD/EXCEL/POWERPNT process it started, nothing when that is
//     ambiguous) and on timeout/cancel exactly that PID is ended with `taskkill.exe /PID <n> /T /F`.
//   - The file to convert is first copied into a temp folder under a short ASCII name with its own
//     extension (long/unicode/OneDrive paths, files open in Office); the scripts Unblock-File the copy.
//   - Scripts live inside app.asar when packaged, which powershell.exe cannot read: they are copied
//     into a fresh temp folder per run, which is removed afterwards.
//
// Tests: in unpackaged builds ASH_TEST_FAKE_OFFICE=1 swaps the runner for a fake that records the
// arguments (globalThis.__ashOfficeCalls, for the Electron e2e) and writes a small fixed output file;
// ASH_TEST_FAKE_OFFICE=missing (read at each run) fails with "not installed", =slow runs until cancelled.
// This module does not import 'electron'; main.js passes what it needs (registerOfficeIpc).
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OFFICE_TIMEOUT_MS = 300_000; // default; see OFFICE_TIMEOUTS
const SCRIPT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'office');
export const SCRIPTS = { pdfToDocx: 'pdf-to-docx.ps1', officeToPdf: 'office-to-pdf.ps1' };
/** Per-script time limit: Word's PDF reflow of a long report takes minutes. */
export const OFFICE_TIMEOUTS = { [SCRIPTS.pdfToDocx]: 600_000, [SCRIPTS.officeToPdf]: 300_000 };
export const APP_NAMES = { word: 'Microsoft Word', excel: 'Microsoft Excel', powerpoint: 'Microsoft PowerPoint' };
export const CANCELLED = 'Conversion cancelled';
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

/** `taskkill.exe /PID <pid> /T /F` (array, no shell): ends the Office process a script reported, and its children. */
export function killOfficePid(pid, spawnFn = spawn) {
  try {
    const k = spawnFn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    k.on?.('error', () => {});
  } catch { /* best effort */ }
}

const minutes = (ms) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

/**
 * Spawn `command` with `args` (array, no shell). -> {code, stdout, stderr}.
 * Rejects on timeout or when `signal` aborts: the process is killed and, when its stdout announced
 * `OFFICE_PID <n>`, that process too (killOfficePid). `spawnFn` is injectable for tests.
 */
export function runProcess(command, args, { timeoutMs = OFFICE_TIMEOUT_MS, signal, spawnFn = spawn } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error(CANCELLED)); return; }
    const child = spawnFn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', officePid = null, settled = false;
    child.stdout.on('data', (d) => {
      stdout += d;
      officePid ??= /^OFFICE_PID (\d+)\s*$/m.exec(stdout)?.[1] ?? null;
    });
    child.stderr.on('data', (d) => { stderr += d; });
    const stop = (err) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      child.kill();
      if (officePid) killOfficePid(officePid, spawnFn);
      reject(err);
    };
    const onAbort = () => stop(new Error(CANCELLED));
    const timer = setTimeout(() => stop(new Error(`Microsoft Office did not finish within ${minutes(timeoutMs)}. Try again; for a long document, close other Office windows first.`)), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    const done = (fn) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); fn(); };
    child.on('error', (err) => done(() => reject(err)));
    child.on('close', (code) => done(() => resolve({ code, stdout, stderr })));
  });
}

/** rm that never throws: on Windows a just-killed Office process can still hold the temp files for a moment. */
const removeDir = (dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});

/** Run a bundled script with powershell.exe. Exit 0 -> resolves; otherwise rejects with the script's message. */
export async function runScript(name, args, { run = runProcess, timeoutMs = OFFICE_TIMEOUTS[name] ?? OFFICE_TIMEOUT_MS, signal } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ash-office-'));
  try {
    const script = join(dir, name);
    await writeFile(script, await readFile(join(SCRIPT_DIR, name)));
    const res = await run('powershell.exe', powershellArgs(script, args), { timeoutMs, signal });
    if (res.code !== 0) throw new Error(res.stderr.trim().split(/\r?\n/).pop() || `Microsoft Office conversion failed (exit code ${res.code})`);
    return res;
  } finally {
    await removeDir(dir);
  }
}

/** Test runner (ASH_TEST_FAKE_OFFICE): records the call and writes a fixed output file to the last argument. */
export function fakeRunner(mode, calls) {
  return async (command, args, { timeoutMs, signal } = {}) => {
    calls.push({ command, args: [...args], timeoutMs, script: await readFile(args[5], 'utf8') });
    const m = typeof mode === 'function' ? mode() : mode;
    if (m === 'missing') return { code: 2, stdout: '', stderr: 'Microsoft Word is not installed\n' };
    if (m === 'slow') { // runs until cancelled (or the timeout)
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, timeoutMs);
        signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error(CANCELLED)); }, { once: true });
      });
    }
    await writeFile(args[args.length - 1], args[args.length - 1].toLowerCase().endsWith('.pdf') ? FAKE_PDF : 'ASH fake Office output');
    return { code: 0, stdout: '', stderr: '' };
  };
}
const FAKE_PDF = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
  + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';

/**
 * IPC for the conversions. ctx = {handle, dialog, getWindow, grant, describeFile, isPackaged, platform, env}.
 *   office:status         -> {available, reason}
 *   office:exportDocx     ({bytes, defaultPath, jobId?}) -> {path} | null   (bytes: the current PDF, annotations included)
 *   office:toPdf          ({jobId?})                     -> file {path, name, bytes} | null
 *   office:cancel         (jobId) -> boolean             ends that conversion (rejects with CANCELLED)
 * Once the user has chosen the files and the conversion starts, the window gets
 * 'office:progress' {jobId, app} (app: "Microsoft Word", ...) so the renderer can show a Cancel dialog.
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

  const jobs = new Map(); // jobId -> AbortController of a running conversion
  const jobIdOf = (opts) => (opts && typeof opts.jobId === 'string' && /^[\w-]{1,64}$/.test(opts.jobId) ? opts.jobId : null);
  /** Run `script` for job `jobId` (null: not cancellable), telling the window which application converts. */
  const convert = async (jobId, app, script, args) => {
    const ac = new AbortController();
    if (jobId) jobs.set(jobId, ac);
    try {
      if (jobId) ctx.getWindow?.()?.webContents?.send('office:progress', { jobId, app });
      await runScript(script, args, { run, signal: ac.signal });
    } finally {
      if (jobId && jobs.get(jobId) === ac) jobs.delete(jobId);
    }
  };

  ctx.handle('office:status', () => ({ available, reason: available ? null : UNAVAILABLE }));
  ctx.handle('office:cancel', (jobId) => {
    const ac = typeof jobId === 'string' ? jobs.get(jobId) : null;
    ac?.abort();
    return !!ac;
  });
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
      await convert(jobIdOf(opts), APP_NAMES.word, SCRIPTS.pdfToDocx, [pdf, out]);
    } finally {
      await removeDir(dir);
    }
    ctx.grant(out);
    return { path: out };
  });
  ctx.handle('office:toPdf', async (opts) => {
    need();
    const { canceled, filePaths } = await ctx.dialog.showOpenDialog(ctx.getWindow(), {
      properties: ['openFile'], filters: [{ name: 'Office files', extensions: Object.keys(KINDS) }],
    });
    if (canceled || !filePaths[0]) return null;
    const input = checkPath(filePaths[0], 'input path');
    const ext = extname(input).slice(1).toLowerCase();
    const kind = KINDS[ext];
    if (!kind) throw new Error('Choose a Word, Excel or PowerPoint file');
    const out = await saveDialog(input.replace(/\.[^.\\/]+$/, '') + '.pdf', { name: 'PDF document', extensions: ['pdf'] });
    if (!out) return null;
    // Office opens a private copy: short ASCII path, same extension, not the file the user may have open.
    const dir = await mkdtemp(join(tmpdir(), 'ash-office-in-'));
    try {
      const copy = join(dir, `input.${ext}`);
      try { await copyFile(input, copy); } catch (err) { throw new Error(`Could not read ${basename(input)}: ${err.message}`); }
      await convert(jobIdOf(opts), APP_NAMES[kind], SCRIPTS.officeToPdf, [kind, copy, out]);
    } finally {
      await removeDir(dir);
    }
    ctx.grant(out);
    return ctx.describeFile(out);
  });
}
