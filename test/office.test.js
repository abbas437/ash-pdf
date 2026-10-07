// Office conversions (electron/office.js): argument building and passing, the PowerShell scripts, the fake runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPath, powershellArgs, runProcess, runScript, fakeRunner, registerOfficeIpc, SCRIPTS, KINDS, UNAVAILABLE } from '../electron/office.js';

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
  assert.match(word, /Documents\.Open\(\$In, \$false, \$true\)/);
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
