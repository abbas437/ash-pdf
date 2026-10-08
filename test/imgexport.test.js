import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { safeBaseName, imageFileName, planImageExport, checkImageBytes, ImageExportJobs, MAX_FILES, MAX_FILE_BYTES } from '../src/core/imgexport.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const req = (over = {}) => ({ baseName: 'Report', pageCount: 12, pages: [1, 2, 12], format: 'png', ...over });

describe('image export names', () => {
  test('page number padded to the page count width', () => {
    assert.equal(imageFileName('doc', 1, 120, 'png'), 'doc-p001.png');
    assert.equal(imageFileName('doc', 7, 12, 'jpeg'), 'doc-p07.jpg');
    assert.equal(imageFileName('doc', 3, 9, 'png'), 'doc-p3.png');
    assert.equal(imageFileName('doc', 1234, 2000, 'png'), 'doc-p1234.png');
  });
  test('path separators and reserved characters are stripped', () => {
    assert.equal(safeBaseName('..\\..\\evil/../x'), 'x');
    assert.equal(safeBaseName('C:\\dir\\a<b>:c"d|e?f*g'), 'abcdefg');
    assert.equal(safeBaseName('a\u0001b\u001f'), 'ab');
    assert.equal(safeBaseName(' .hidden. '), 'hidden');
    assert.equal(safeBaseName('...'), 'document');
    assert.equal(safeBaseName(''), 'document');
  });
  test('Windows reserved names are prefixed', () => {
    for (const n of ['CON', 'nul', 'Com1', 'LPT9', 'aux.tar', 'PRN ']) assert.equal(safeBaseName(n), `_${n.trim()}`);
    assert.equal(safeBaseName('console'), 'console');
    assert.equal(safeBaseName('COM10'), 'COM10');
  });
  test('base name is at most 120 characters', () => {
    assert.equal(safeBaseName('x'.repeat(300)).length, 120);
    assert.equal(safeBaseName(`${'y'.repeat(119)}. tail`), 'y'.repeat(119));
    assert.equal(planImageExport(req({ baseName: 'z'.repeat(500), pages: [1] })).names[0], `${'z'.repeat(120)}-p01.png`);
  });
});

describe('image export request validation', () => {
  test('a valid request yields one name per page', () => {
    assert.deepEqual(planImageExport(req()), { format: 'png', names: ['Report-p01.png', 'Report-p02.png', 'Report-p12.png'] });
  });
  test('extra or missing keys are rejected', () => {
    assert.throws(() => planImageExport(req({ folder: '/tmp' })), /exactly the keys/);
    assert.throws(() => planImageExport({ ...req(), path: 'x' }), /exactly the keys/);
    const { format, ...noFormat } = req();
    assert.throws(() => planImageExport(noFormat), /exactly the keys/);
    for (const bad of [null, [], 'x', Object.assign(Object.create(null), req())]) assert.throws(() => planImageExport(bad), TypeError);
  });
  test('bad fields are rejected', () => {
    assert.throws(() => planImageExport(req({ format: 'gif' })), /format/);
    assert.throws(() => planImageExport(req({ baseName: 3 })), /baseName/);
    assert.throws(() => planImageExport(req({ pageCount: 0 })), /pageCount/);
    assert.throws(() => planImageExport(req({ pages: [] })), /non-empty/);
    assert.throws(() => planImageExport(req({ pages: [13] })), /outside/);
    assert.throws(() => planImageExport(req({ pages: [1.5] })), /outside/);
    assert.throws(() => planImageExport(req({ pages: [2, 2] })), /twice/);
  });
  test('more than 2000 files are rejected', () => {
    const pages = Array.from({ length: MAX_FILES + 1 }, (_, i) => i + 1);
    assert.throws(() => planImageExport(req({ pageCount: 5000, pages })), /At most 2000/);
    assert.equal(planImageExport(req({ pageCount: 5000, pages: pages.slice(0, MAX_FILES) })).names.length, MAX_FILES);
  });
});

describe('image export bytes and jobs', () => {
  test('bytes must be a Uint8Array of the right format, at most 50 MB', () => {
    assert.equal(checkImageBytes(PNG, 'png'), PNG);
    assert.equal(checkImageBytes(JPG, 'jpeg'), JPG);
    assert.throws(() => checkImageBytes([...PNG], 'png'), /Uint8Array/);
    assert.throws(() => checkImageBytes(PNG.buffer, 'png'), /Uint8Array/);
    assert.throws(() => checkImageBytes(new Uint8Array(0), 'png'), /50 MB/);
    assert.throws(() => checkImageBytes(JPG, 'png'), /not a PNG/);
    const big = new Uint8Array(MAX_FILE_BYTES + 1); big.set(PNG);
    assert.throws(() => checkImageBytes(big, 'png'), /50 MB/);
    assert.equal(checkImageBytes(big.subarray(0, MAX_FILE_BYTES), 'png').length, MAX_FILE_BYTES);
  });
  test('jobs are keyed by sender, checked per write and closed by end', () => {
    const jobs = new ImageExportJobs();
    const id = jobs.open(1, { ...planImageExport(req()), folder: '/out' });
    assert.throws(() => jobs.take(2, id, 0, PNG), /no such job/);
    assert.throws(() => jobs.take(1, id, 3, PNG), /out of range/);
    assert.throws(() => jobs.take(1, id, 0, JPG), /not a PNG/);
    assert.deepEqual(jobs.take(1, id, 0, PNG), { folder: '/out', name: 'Report-p01.png' });
    assert.throws(() => jobs.take(1, id, 0, PNG), /already written/);
    assert.equal(jobs.close(2, id), false);
    assert.equal(jobs.close(1, id), true);
    assert.throws(() => jobs.take(1, id, 1, PNG), /no such job/);
  });
});
