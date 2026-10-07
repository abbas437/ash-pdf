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
//     ambiguous) and on timeout/cancel exactly that PID is ended with `taskkill.exe /PID <n> /T /F`
//     (awaited, at most KILL_WAIT_MS, before the temp files are removed). Word and Excel started with
//     New-Object are private instances (a file the user opens from Explorer goes to their own instance),
//     so killing them ends only our work. PowerPoint is single-instance and may hold the user's
//     presentations: it is never killed; the error then says it may still be running.
//   - Word's PDF Reflow prompt is turned off here, not in the script (a killed script runs no `finally`):
//     HKCU\Software\Microsoft\Office\<ver>\Word\Options DisableConvertPdfWarning is set to 1 with reg.exe
//     before the run and put back (deleted when it did not exist) after it, whatever the outcome.
//     PDF -> Word runs are serialized so two runs never interleave that save/restore.
//   - A failed or cancelled conversion removes the output file when it did not exist before the run.
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
import { access, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

export const KILL_WAIT_MS = 5000;
/**
 * `taskkill.exe /PID <pid> /T /F` (array, no shell): ends the Office process a script reported, and its children.
 * Resolves when taskkill has exited (or failed), at the latest after `waitMs`; never rejects.
 */
export function killOfficePid(pid, spawnFn = spawn, waitMs = KILL_WAIT_MS) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, waitMs);
    const end = () => { clearTimeout(timer); resolve(); };
    try {
      const k = spawnFn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      k.on?.('error', end);
      k.on?.('exit', end);
    } catch { end(); /* best effort */ }
  });
}

const minutes = (ms) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

/**
 * Spawn `command` with `args` (array, no shell). -> {code, stdout, stderr}.
 * Rejects on timeout or when `signal` aborts: the process is killed and, when its stdout announced a
 * complete `OFFICE_PID <n>` line, that process too (killOfficePid, awaited before rejecting) unless
 * `keepOffice` names the application (PowerPoint), which is left running and named in the error.
 * `spawnFn` is injectable for tests.
 */
export function runProcess(command, args, { timeoutMs = OFFICE_TIMEOUT_MS, signal, spawnFn = spawn, keepOffice = null } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error(CANCELLED)); return; }
    const child = spawnFn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', officePid = null, settled = false;
    child.stdout.on('data', (d) => {
      stdout += d;
      officePid ??= /^OFFICE_PID (\d+)\r?\n/m.exec(stdout)?.[1] ?? null; // a whole line: a chunk can end mid-number
    });
    child.stderr.on('data', (d) => { stderr += d; });
    const stop = (err) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      child.kill();
      if (keepOffice) { err.message = `${err.message.replace(/\.?$/, '.')} ${keepOffice} may still be running.`; reject(err); return; }
      (officePid ? killOfficePid(officePid, spawnFn) : Promise.resolve()).then(() => reject(err));
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
export async function runScript(name, args, { run = runProcess, timeoutMs = OFFICE_TIMEOUTS[name] ?? OFFICE_TIMEOUT_MS, signal, keepOffice = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ash-office-'));
  try {
    const script = join(dir, name);
    await writeFile(script, await readFile(join(SCRIPT_DIR, name)));
    const res = await run('powershell.exe', powershellArgs(script, args), { timeoutMs, signal, keepOffice });
    if (res.code !== 0) throw new Error(res.stderr.trim().split(/\r?\n/).pop() || `Microsoft Office conversion failed (exit code ${res.code})`);
    return res;
  } finally {
    await removeDir(dir);
  }
}

/** `reg.exe <args>` (array, no shell) -> {code, stdout, stderr}. */
export const runReg = (args, { spawnFn = spawn } = {}) => runProcess('reg.exe', args, { timeoutMs: 30_000, spawnFn });

const PDF_WARNING = 'DisableConvertPdfWarning';
/** Word's registry version from HKCR\Word.Application\CurVer ("Word.Application.16" -> "16.0"), else "16.0". */
export async function wordVersion(reg) {
  const res = await reg(['query', 'HKCR\\Word.Application\\CurVer', '/ve']).catch(() => null);
  const m = res?.code === 0 ? /Word\.Application\.(\d+)/i.exec(res.stdout) : null;
  return m ? `${m[1]}.0` : '16.0';
}

/**
 * Set HKCU ...\Word\Options DisableConvertPdfWarning = 1. -> an async restore function (puts the previous
 * DWORD back, or deletes the value when there was none), or null when nothing was changed (reg.exe failed,
 * or the value exists with another type, which is left alone).
 */
export async function disablePdfWarning(reg) {
  const key = `HKCU\\Software\\Microsoft\\Office\\${await wordVersion(reg)}\\Word\\Options`;
  const q = await reg(['query', key, '/v', PDF_WARNING]).catch(() => null);
  if (!q) return null;
  let prev = null;
  if (q.code === 0) {
    const m = /\sREG_DWORD\s+0x([0-9a-f]+)/i.exec(q.stdout);
    if (!m) return null;
    prev = parseInt(m[1], 16);
  }
  const set = await reg(['add', key, '/v', PDF_WARNING, '/t', 'REG_DWORD', '/d', '1', '/f']).catch(() => null);
  if (set?.code !== 0) return null;
  return () => reg(prev === null ? ['delete', key, '/v', PDF_WARNING, '/f'] : ['add', key, '/v', PDF_WARNING, '/t', 'REG_DWORD', '/d', String(prev), '/f']).catch(() => {});
}

let wordQueue = Promise.resolve();
/**
 * PDF -> Word with the reflow prompt off (disablePdfWarning), restored when the run ends: success, error,
 * timeout or cancel. Runs one at a time, so concurrent runs cannot interleave the save/restore.
 */
export function runPdfToDocx(args, { run = runProcess, reg = runReg, signal } = {}) {
  const job = wordQueue.then(async () => {
    if (signal?.aborted) throw new Error(CANCELLED);
    const restore = await disablePdfWarning(reg);
    try {
      return await runScript(SCRIPTS.pdfToDocx, args, { run, signal });
    } finally {
      await restore?.();
    }
  });
  wordQueue = job.catch(() => {});
  return job;
}

/** Test reg.exe (ASH_TEST_FAKE_OFFICE): records the call; every value is absent, every change succeeds. */
export function fakeReg(calls) {
  return async (args) => { calls.push([...args]); return args[0] === 'query' ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: '', stderr: '' }; };
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
 * IPC for the conversions. ctx = {handle, dialog, getWindow, grant, describeFile, isPackaged, platform, env, run?, reg?}.
 * getWindow() must return the window whose page made the current call (main.js: callerWindow); run/reg
 * replace the powershell.exe / reg.exe runners (tests).
 *   office:status         -> {available, reason}
 *   office:exportDocx     ({bytes, defaultPath, jobId?}) -> {path} | null   (bytes: the current PDF, annotations included)
 *   office:toPdf          ({jobId?})                     -> file {path, name, bytes} | null
 *   office:cancel         (jobId) -> boolean             ends that conversion of the calling window (rejects with CANCELLED)
 * Once the user has chosen the files and the conversion starts, the calling window gets
 * 'office:progress' {jobId, app} (app: "Microsoft Word", ...) so the renderer can show a Cancel dialog.
 */
export function registerOfficeIpc(ctx) {
  const env = ctx.env ?? process.env;
  const fake = !ctx.isPackaged && env.ASH_TEST_FAKE_OFFICE ? env.ASH_TEST_FAKE_OFFICE : null;
  const calls = [];
  const regCalls = [];
  const run = ctx.run ?? (fake ? fakeRunner(() => env.ASH_TEST_FAKE_OFFICE, calls) : runProcess);
  const reg = ctx.reg ?? (fake ? fakeReg(regCalls) : runReg);
  if (fake) { globalThis.__ashOfficeCalls = calls; globalThis.__ashOfficeRegCalls = regCalls; }
  const available = !!fake || (ctx.platform ?? process.platform) === 'win32';
  const need = () => { if (!available) throw new Error(UNAVAILABLE); };
  const saveDialog = async (defaultPath, filter) => {
    const { canceled, filePath } = await ctx.dialog.showSaveDialog(ctx.getWindow(), { defaultPath, filters: [filter] });
    return canceled || !filePath ? null : checkPath(filePath, 'output path');
  };

  const jobs = new Map(); // `${sender id}:${jobId}` -> AbortController of a running conversion
  const jobIdOf = (opts) => (opts && typeof opts.jobId === 'string' && /^[\w-]{1,64}$/.test(opts.jobId) ? opts.jobId : null);
  const jobKey = (jobId) => `${ctx.getWindow?.()?.webContents?.id ?? ''}:${jobId}`;
  const exists = (p) => access(p).then(() => true, () => false);
  /**
   * Convert to `out` with `start(signal)` for job `jobId` (null: not cancellable), telling the calling
   * window which application converts. On failure, `out` is removed unless it existed before.
   */
  const convert = async (jobId, app, out, start) => {
    const ac = new AbortController();
    const key = jobId && jobKey(jobId);
    const existed = await exists(out);
    if (key) jobs.set(key, ac);
    try {
      if (key) ctx.getWindow?.()?.webContents?.send('office:progress', { jobId, app });
      await start(ac.signal);
    } catch (err) {
      if (!existed) await rm(out, { force: true }).catch(() => {}); // a partial file from a cancelled/killed SaveAs
      throw err;
    } finally {
      if (key && jobs.get(key) === ac) jobs.delete(key);
    }
  };

  ctx.handle('office:status', () => ({ available, reason: available ? null : UNAVAILABLE }));
  ctx.handle('office:cancel', (jobId) => {
    const ac = typeof jobId === 'string' ? jobs.get(jobKey(jobId)) : null; // only the caller's own jobs
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
      await convert(jobIdOf(opts), APP_NAMES.word, out, (signal) => runPdfToDocx([pdf, out], { run, reg, signal }));
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
      await convert(jobIdOf(opts), APP_NAMES[kind], out, (signal) => runScript(SCRIPTS.officeToPdf, [kind, copy, out], {
        run, signal, keepOffice: kind === 'powerpoint' ? APP_NAMES.powerpoint : null,
      }));
    } finally {
      await removeDir(dir);
    }
    ctx.grant(out);
    return ctx.describeFile(out);
  });
}
