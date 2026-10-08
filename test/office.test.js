// Office conversions (electron/office.js): argument building and passing, the PowerShell scripts, the fake runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { checkPath, powershellArgs, runProcess, runScript, runPdfToDocx, fakeRunner, fakeReg, registerOfficeIpc, SCRIPTS, KINDS, UNAVAILABLE, OFFICE_TIMEOUTS, CANCELLED } from '../electron/office.js';

const root = process.platform === 'win32' ? 'C:\\' : '/';
const nasty = [
  `${root}My Documents/report final.pdf`,
  `${root}a "quoted" name.docx`,
  `${root}Ünïcödé 报告 تقرير.pdf`,
  `${root}x; echo pwned & del y.pdf`,
  `${root}it's $(whoami) %PATH% \`tick\` | more.docx`,
];

test('powershellArgs: fixed switches, then the script and one element per argument', () => {
  const args = powershellArgs(nasty[0], nasty.slice(1));
  assert.deepEqual(args.slice(0, 6), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', nasty[0]]);
  assert.deepEqual(args.slice(6), nasty.slice(1));
});

test('checkPath: only absolute paths without control characters', () => {
  for (const p of nasty) assert.equal(checkPath(p), p);
  for (const bad of ['relative/x.pdf', '', null, `${root}a\u0000b`, `${root}a\nb`, 42]) assert.throws(() => checkPath(bad), TypeError);
  assert.throws(() => powershellArgs('rel.ps1', []), TypeError);
});

test('runProcess: spaces, quotes, unicode, ; and & arrive as single arguments', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ash-office-test-'));
  try {
    const echo = join(dir, 'echo.mjs');
    await writeFile(echo, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
    const res = await runProcess(process.execPath, [echo, ...nasty]);
    assert.equal(res.code, 0, res.stderr);
    assert.deepEqual(JSON.parse(res.stdout), nasty);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('runProcess: a run past the timeout is killed and rejected', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 300 }), /did not finish within/);
});

test('the .ps1 scripts: param block, invisible app, alerts off, Quit in finally, "not installed" exit 2', async () => {
  for (const name of Object.values(SCRIPTS)) {
    const src = await readFile(new URL(`../electron/office/${name}`, import.meta.url), 'utf8');
    assert.match(src, /^param\(/m, name);
    assert.match(src, /New-Object -ComObject/, name);
    assert.match(src, /is not installed['"]\);\s*exit 2/, name);
    const fin = src.slice(src.search(/\}\s*finally\s*\{/));
    assert.ok(fin.length > 0 && /\.Quit\(\)/.test(fin), `${name}: Quit() must be in finally`);
    assert.match(src, /DisplayAlerts = (0|\$false)/, name);
    assert.equal((src.match(/\{/g) ?? []).length, (src.match(/\}/g) ?? []).length, `${name}: balanced braces`);
    assert.equal((src.match(/\(/g) ?? []).length, (src.match(/\)/g) ?? []).length, `${name}: balanced parentheses`);
  }
  const word = await readFile(new URL('../electron/office/pdf-to-docx.ps1', import.meta.url), 'utf8');
  assert.match(word, /Documents\.Open\(\$In, \$false, \$true, /);
  assert.match(word, /SaveAs2\(\$Out, 16\)/);
  const office = await readFile(new URL('../electron/office/office-to-pdf.ps1', import.meta.url), 'utf8');
  assert.match(office, /ExportAsFixedFormat\(\$Out, 17\)/);
  assert.match(office, /ExportAsFixedFormat\(0, \$Out\)/);
  assert.match(office, /SaveAs\(\$Out, 32\)/);
});

test('runScript: copies the script to a temp folder, passes args, maps exit 2 to the script message', async () => {
  const calls = [];
  const out = join(await mkdtemp(join(tmpdir(), 'ash-office-test-')), 'out file.docx');
  await runScript(SCRIPTS.pdfToDocx, [nasty[0], out], { run: fakeRunner('1', calls) });
  assert.equal(calls[0].command, 'powershell.exe');
  assert.deepEqual(calls[0].args.slice(6), [nasty[0], out]);
  assert.match(calls[0].script, /SaveAs2/);
  assert.equal(await readFile(out, 'utf8'), 'ASH fake Office output');
  await assert.rejects(runScript(SCRIPTS.pdfToDocx, [nasty[0], out], { run: fakeRunner('missing', []) }), /^Error: Microsoft Word is not installed$/);
  await rm(join(out, '..'), { recursive: true, force: true });
});

test('registerOfficeIpc: unavailable off Windows without the fake; extension -> application kind', async () => {
  const handlers = new Map();
  registerOfficeIpc({ handle: (c, fn) => handlers.set(c, fn), platform: 'linux', isPackaged: false, env: {} });
  assert.deepEqual(await handlers.get('office:status')(), { available: false, reason: UNAVAILABLE });
  await assert.rejects(handlers.get('office:toPdf')(), new RegExp(UNAVAILABLE));
  const packaged = new Map();
  registerOfficeIpc({ handle: (c, fn) => packaged.set(c, fn), platform: 'linux', isPackaged: true, env: { ASH_TEST_FAKE_OFFICE: '1' } });
  assert.equal((await packaged.get('office:status')()).available, false, 'the fake is never used in packaged builds');
  assert.deepEqual([KINDS.docx, KINDS.rtf, KINDS.xlsx, KINDS.pptx], ['word', 'word', 'excel', 'powerpoint']);
});

// A spawn that runs real processes but only records taskkill.exe (never run on the test machine).
function recordingSpawn(kills) {
  return (command, args, opts) => {
    if (command !== 'taskkill.exe') return spawn(command, args, opts);
    kills.push([command, args]);
    const k = new EventEmitter();
    setImmediate(() => k.emit('exit', 0));
    return k;
  };
}
const hang = (stdout) => ['-e', `process.stdout.write(${JSON.stringify(stdout)}); setTimeout(() => {}, 60000)`];

test('runProcess: on timeout the OFFICE_PID announced on stdout is ended with taskkill /T /F, and only that', async () => {
  const kills = [];
  await assert.rejects(runProcess(process.execPath, hang('OFFICE_PID 1234\r\nworking\n'), { timeoutMs: 1500, spawnFn: recordingSpawn(kills) }), /did not finish within/);
  assert.deepEqual(kills, [['taskkill.exe', ['/PID', '1234', '/T', '/F']]]);
  const none = [];
  await assert.rejects(runProcess(process.execPath, hang('no pid here\nOFFICE_PID x\n'), { timeoutMs: 1500, spawnFn: recordingSpawn(none) }), /did not finish within/);
  assert.deepEqual(none, [], 'nothing is killed when no PID was printed');
});

test('runProcess: cancelling through the signal kills the run and the announced Office PID', async () => {
  const kills = [];
  const ac = new AbortController();
  const p = runProcess(process.execPath, hang('OFFICE_PID 77\n'), { timeoutMs: 60_000, signal: ac.signal, spawnFn: recordingSpawn(kills) });
  setTimeout(() => ac.abort(), 1500);
  await assert.rejects(p, new RegExp(CANCELLED));
  assert.deepEqual(kills, [['taskkill.exe', ['/PID', '77', '/T', '/F']]]);
});

test('runScript / IPC: each conversion uses its own time limit (Word reflow 10 min, Office -> PDF 5 min)', async () => {
  assert.equal(OFFICE_TIMEOUTS[SCRIPTS.pdfToDocx], 600_000);
  assert.equal(OFFICE_TIMEOUTS[SCRIPTS.officeToPdf], 300_000);
  const seen = [];
  const run = async (command, args, opts) => { seen.push(opts.timeoutMs); return { code: 0, stdout: '', stderr: '' }; };
  await runScript(SCRIPTS.pdfToDocx, [nasty[0], nasty[1]], { run });
  await runScript(SCRIPTS.officeToPdf, ['excel', nasty[0], nasty[1]], { run });
  assert.deepEqual(seen, [600_000, 300_000]);
});

async function fakeIpc(mode, { input, out, sent = [] }) {
  const handlers = new Map();
  const env = { ASH_TEST_FAKE_OFFICE: mode };
  registerOfficeIpc({
    handle: (c, fn) => handlers.set(c, fn), platform: 'linux', isPackaged: false, env,
    getWindow: () => ({ webContents: { send: (...a) => sent.push(a) } }),
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [input] }), showSaveDialog: async () => ({ canceled: false, filePath: out }) },
    grant: () => {}, describeFile: async (p) => ({ path: p }),
  });
  return { handlers, calls: globalThis.__ashOfficeCalls, env };
}

test('office:toPdf: Office gets a copy in a temp folder (short ASCII name, original extension), removed afterwards', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ash-office-test-'));
  try {
    const input = join(dir, 'Ünïcödé report; & (v2) [final].XLSX'); // no " : * ? < > |, which Windows file names cannot hold
    await writeFile(input, 'workbook bytes');
    const out = join(dir, 'out.pdf');
    const sent = [];
    const { handlers, calls } = await fakeIpc('1', { input, out, sent });
    assert.deepEqual(await handlers.get('office:toPdf')({ jobId: 'job-1' }), { path: out });
    const [kind, copy, outArg] = calls[0].args.slice(6);
    assert.equal(kind, 'excel');
    assert.equal(outArg, out);
    assert.notEqual(copy, input);
    assert.equal(basename(copy), 'input.xlsx');
    assert.ok(dirname(copy).startsWith(join(tmpdir(), 'ash-office-in-')), copy);
    assert.equal(calls[0].timeoutMs, 300_000);
    await assert.rejects(access(dirname(copy)), 'the temp copy is removed');
    assert.equal(await readFile(input, 'utf8'), 'workbook bytes', 'the original is untouched');
    assert.deepEqual(sent, [['office:progress', { jobId: 'job-1', app: 'Microsoft Excel' }]]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('office:exportDocx: 10 min limit; office:cancel ends a running conversion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ash-office-test-'));
  try {
    const { handlers, calls } = await fakeIpc('slow', { out: join(dir, 'out.docx') });
    const p = handlers.get('office:exportDocx')({ bytes: new Uint8Array([37, 80, 68, 70]), jobId: 'job-2' });
    while (!calls.length) await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls[0].timeoutMs, 600_000);
    assert.equal(await handlers.get('office:cancel')('job-2'), true);
    await assert.rejects(p, new RegExp(CANCELLED));
    assert.equal(await handlers.get('office:cancel')('job-2'), false, 'finished jobs are forgotten');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the .ps1 scripts: PDF-reflow prompt off, Mark of the Web removed, macros off, repair retry, OFFICE_PID', async () => {
  const word = await readFile(new URL('../electron/office/pdf-to-docx.ps1', import.meta.url), 'utf8');
  const office = await readFile(new URL('../electron/office/office-to-pdf.ps1', import.meta.url), 'utf8');
  assert.doesNotMatch(word, /ItemProperty|Registry::|HKCU:/, 'the registry is handled by the app (a killed script runs no finally)');
  for (const src of [word, office]) {
    assert.match(src, /Unblock-File -LiteralPath \$In/);
    assert.match(src, /OFFICE_PID \$\(\$started\[0\]\.Id\)/);
    assert.match(src, /\$started\.Count -eq 1/, 'a PID is reported only when exactly one new process appeared');
  }
  assert.match(office, /AutomationSecurity = 3/);
  assert.match(office, /EnableEvents = \$false/);
  assert.match(office, /AskToUpdateLinks = \$false/);
  assert.match(office, /CorruptLoad/);
  assert.match(office, /\$m, \$false, \$m, 1\)/, 'the retry passes CorruptLoad = xlRepairFile as the 15th argument');
  assert.match(office, /could not open this file\. If it opens in Protected View or asks to repair/);
});

test('office-to-pdf.ps1 never quits a PowerPoint the user already had open', async () => {
  const src = await readFile(new URL('../electron/office/office-to-pdf.ps1', import.meta.url), 'utf8');
  assert.match(src, /Presentations\.Count -gt 0\) \{ \$keepApp = \$true/);
  assert.match(src, /\$quit = -not \$keepApp/);
  assert.match(src, /if \(\$quit -and \$Kind -eq 'powerpoint'\) \{ try \{ \$quit = \(\$appObj\.Presentations\.Count -eq 0\) \}/,
    'a presentation the user opened during the run keeps PowerPoint running');
  assert.match(src, /if \(\$quit\) \{ try \{ \$appObj\.Quit\(\)/);
});

// ---- runtime: registry, serialization, PID parsing, kill policy, partial output, caller window

const ok = { code: 0, stdout: '', stderr: '' };
const WARN = 'DisableConvertPdfWarning';
const keyOf = (ver) => `HKCU\\Software\\Microsoft\\Office\\${ver}\\Word\\Options`;
/** A reg.exe stand-in over one value, answering in reg.exe's output format; `log` gets 'reg:<verb>'. */
function fakeRegistry({ curVer = 'Word.Application.16', value, log = [] } = {}) {
  const calls = [];
  const state = { calls, get value() { return value; } };
  state.reg = async (args) => {
    calls.push(args); log.push(`reg:${args[0]}`);
    if (args[0] === 'query' && args[1].startsWith('HKCR')) {
      return curVer ? { code: 0, stdout: `\r\nHKEY_CLASSES_ROOT\\Word.Application\\CurVer\r\n    (Default)    REG_SZ    ${curVer}\r\n\r\n`, stderr: '' }
        : { code: 1, stdout: '', stderr: 'ERROR: The system was unable to find the specified registry key or value.\r\n' };
    }
    if (args[0] === 'query') {
      return value === undefined ? { code: 1, stdout: '', stderr: 'ERROR: not found\r\n' }
        : { code: 0, stdout: `\r\n${args[1]}\r\n    ${WARN}    REG_DWORD    0x${value.toString(16)}\r\n\r\n`, stderr: '' };
    }
    if (args[0] === 'add') value = Number(args[args.indexOf('/d') + 1]);
    if (args[0] === 'delete') value = undefined;
    return ok;
  };
  return state;
}
const expectedReg = (ver, prev) => [
  ['query', 'HKCR\\Word.Application\\CurVer', '/ve'],
  ['query', keyOf(ver), '/v', WARN],
  ['add', keyOf(ver), '/v', WARN, '/t', 'REG_DWORD', '/d', '1', '/f'],
  prev === undefined ? ['delete', keyOf(ver), '/v', WARN, '/f'] : ['add', keyOf(ver), '/v', WARN, '/t', 'REG_DWORD', '/d', String(prev), '/f'],
];
/** A powershell.exe stand-in that runs a real hanging process (so the real timeout/cancel path runs). */
const hangingRun = (stdout, extra = {}) => (command, args, opts) => runProcess(process.execPath, hang(stdout), { ...opts, ...extra });

const registryCases = [
  { name: 'success', curVer: 'Word.Application.15', ver: '15.0', value: undefined, run: async () => ok, outcome: null },
  { name: 'error', curVer: null, ver: '16.0', value: 0, run: async () => ({ code: 1, stdout: '', stderr: 'boom\r\n' }), outcome: /^Error: boom$/ },
  { name: 'timeout', curVer: 'Word.Application.16', ver: '16.0', value: undefined, run: hangingRun('working\n', { timeoutMs: 300 }), outcome: /did not finish within/ },
  { name: 'cancel', curVer: 'Word.Application.16', ver: '16.0', value: 0, run: hangingRun('working\n'), outcome: new RegExp(CANCELLED), cancel: true },
];
for (const c of registryCases) {
  test(`PDF -> Word: DisableConvertPdfWarning set before and restored after the run (${c.name})`, async () => {
    const r = fakeRegistry({ curVer: c.curVer, value: c.value });
    let during;
    const run = async (...a) => { during = r.value; return c.run(...a); };
    const ac = new AbortController();
    if (c.cancel) setTimeout(() => ac.abort(), 300);
    const p = runPdfToDocx([nasty[0], nasty[1]], { run, reg: r.reg, signal: ac.signal });
    if (c.outcome) await assert.rejects(p, c.outcome); else await p;
    assert.equal(during, 1, 'the prompt is off while Word runs');
    assert.deepEqual(r.calls, expectedReg(c.ver, c.value));
    assert.equal(r.value, c.value, 'the previous state is back');
  });
}

test('PDF -> Word: concurrent runs go one after the other, each with its own save/restore', async () => {
  const log = [];
  const r = fakeRegistry({ log });
  const run = async () => { log.push('start'); await new Promise((res) => setTimeout(res, 100)); log.push('end'); return ok; };
  await Promise.all([runPdfToDocx([nasty[0], nasty[1]], { run, reg: r.reg }), runPdfToDocx([nasty[0], nasty[2]], { run, reg: r.reg })]);
  const one = ['reg:query', 'reg:query', 'reg:add', 'start', 'end', 'reg:delete'];
  assert.deepEqual(log, [...one, ...one]);
  assert.equal(r.value, undefined);
});

test('runProcess: an OFFICE_PID split across stdout chunks is read whole', async () => {
  const kills = [];
  const split = ['-e', 'process.stdout.write("OFFICE_PID 12"); setTimeout(() => process.stdout.write("34\\n"), 400); setTimeout(() => {}, 60000)'];
  await assert.rejects(runProcess(process.execPath, split, { timeoutMs: 1500, spawnFn: recordingSpawn(kills) }), /did not finish within/);
  assert.deepEqual(kills, [['taskkill.exe', ['/PID', '1234', '/T', '/F']]]);
});

test('office:toPdf: on timeout Excel is killed, PowerPoint (single-instance, may hold user files) is not', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ash-office-test-'));
  try {
    for (const [ext, expectKill, msg] of [['xlsx', true, /did not finish within 1 s\. Try again.*first\.$/], ['pptx', false, /first\. Microsoft PowerPoint may still be running\.$/]]) {
      const input = join(dir, `in.${ext}`);
      await writeFile(input, 'x');
      const kills = [];
      const handlers = new Map();
      registerOfficeIpc({
        handle: (ch, fn) => handlers.set(ch, fn), platform: 'win32', isPackaged: true,
        run: hangingRun('OFFICE_PID 55\n', { timeoutMs: 1000, spawnFn: recordingSpawn(kills) }), reg: fakeReg([]),
        getWindow: () => null, grant: () => {}, describeFile: async (p) => ({ path: p }),
        dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [input] }), showSaveDialog: async () => ({ canceled: false, filePath: join(dir, 'out.pdf') }) },
      });
      await assert.rejects(handlers.get('office:toPdf')({}), msg);
      assert.deepEqual(kills, expectKill ? [['taskkill.exe', ['/PID', '55', '/T', '/F']]] : [], ext);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

/** registerOfficeIpc wired like main.js: handlers run in the calling window's AsyncLocalStorage context. */
function windowsIpc(run, out) {
  const caller = new AsyncLocalStorage();
  const handlers = new Map();
  registerOfficeIpc({
    handle: (ch, fn) => handlers.set(ch, (win, ...a) => caller.run(win, () => fn(...a))), platform: 'win32', isPackaged: true,
    run, reg: fakeReg([]), getWindow: () => caller.getStore(), grant: () => {},
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: out }) },
  });
  const win = (id) => { const sent = []; return { sent, webContents: { id, send: (...a) => sent.push(a) } }; };
  return { handlers, win };
}
/** A powershell.exe stand-in that writes part of the output (last argument), then runs until cancelled. */
const partialRun = async (command, args, { signal }) => {
  await writeFile(args[args.length - 1], 'partial');
  // A slow writeFile can let the cancel land first: an already-aborted signal never fires 'abort' again.
  if (signal.aborted) throw new Error(CANCELLED);
  await new Promise((res, rej) => signal.addEventListener('abort', () => rej(new Error(CANCELLED)), { once: true }));
};
const bytes = new Uint8Array([37, 80, 68, 70]);

test('office:exportDocx cancelled: a partial output is removed only when the file did not exist before', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ash-office-test-'));
  try {
    for (const pre of [false, true]) {
      const out = join(dir, `out-${pre}.docx`);
      if (pre) await writeFile(out, 'the user\'s earlier file');
      const { handlers, win } = windowsIpc(partialRun, out);
      const w = win(1);
      const p = handlers.get('office:exportDocx')(w, { bytes, jobId: 'j' });
      while (!w.sent.length) await new Promise((r) => setTimeout(r, 10));
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(await handlers.get('office:cancel')(w, 'j'), true);
      await assert.rejects(p, new RegExp(CANCELLED));
      if (pre) await access(out); else await assert.rejects(access(out), 'the partial file is removed');
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('office: progress goes to the calling window; office:cancel from another window does nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ash-office-test-'));
  try {
    const { handlers, win } = windowsIpc(partialRun, join(dir, 'out.docx'));
    const a = win(1), b = win(2);
    const p = handlers.get('office:exportDocx')(a, { bytes, jobId: 'same-id' });
    while (!a.sent.length) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(a.sent, [['office:progress', { jobId: 'same-id', app: 'Microsoft Word' }]]);
    assert.deepEqual(b.sent, [], 'not the other (e.g. last-focused) window');
    assert.equal(await handlers.get('office:cancel')(b, 'same-id'), false);
    let settled = false;
    p.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(settled, false, 'still running');
    assert.equal(await handlers.get('office:cancel')(a, 'same-id'), true);
    await assert.rejects(p, new RegExp(CANCELLED));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
