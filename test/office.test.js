// Office conversions (electron/office.js): argument building and passing, the PowerShell scripts, the fake runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { checkPath, powershellArgs, runProcess, runScript, fakeRunner, registerOfficeIpc, SCRIPTS, KINDS, UNAVAILABLE, OFFICE_TIMEOUTS, CANCELLED } from '../electron/office.js';

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
    return new EventEmitter();
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
    const input = join(dir, 'Ünïcödé report; & "v2".XLSX');
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
  assert.match(word, /DisableConvertPdfWarning/);
  assert.match(word, /Disable-PdfWarning \$word\.Version/);
  assert.match(word, /Remove-ItemProperty[^\n]*DisableConvertPdfWarning/, 'the previous registry state is restored');
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
