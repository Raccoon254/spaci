'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { trashFiles, scanLargeFiles } = require('../src/largefiles');

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-large-'));
}

test('trashFiles moves files with trashItem and credits their allocated size', async () => {
  const root = fixture();
  const a = path.join(root, 'a.bin');
  fs.writeFileSync(a, Buffer.alloc(64 * 1024, 1));
  const seen = [];
  const progress = [];
  try {
    const res = await trashFiles([a], {
      trashItem: async (p) => { seen.push(p); fs.renameSync(p, p + '.in-trash'); },
      onProgress: (p) => progress.push(p),
    });
    assert.deepEqual(seen, [a]);
    assert.equal(res.results[0].ok, true);
    assert.ok(res.results[0].freed >= 64 * 1024);
    assert.equal(res.totalFreed, res.results[0].freed);
    assert.deepEqual(res.errors, []);
    assert.equal(progress[0].trashed, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a failed trashItem is an error and never falls back to deleting the file', async () => {
  const root = fixture();
  const a = path.join(root, 'a.bin');
  fs.writeFileSync(a, 'data');
  const fsp = fs.promises;
  const calls = [];
  const real = { unlink: fsp.unlink, rm: fsp.rm, unlinkSync: fs.unlinkSync, rmSync: fs.rmSync };
  fsp.unlink = async (...args) => { calls.push('unlink'); return real.unlink.apply(fsp, args); };
  fsp.rm = async (...args) => { calls.push('rm'); return real.rm.apply(fsp, args); };
  fs.unlinkSync = (...args) => { calls.push('unlinkSync'); return real.unlinkSync.apply(fs, args); };
  try {
    const res = await trashFiles([a], { trashItem: async () => { throw Object.assign(new Error('no trash here'), { code: 'EPERM' }); } });
    assert.deepEqual(calls, [], 'no delete call of any kind');
    assert.equal(fs.readFileSync(a, 'utf8'), 'data');
    assert.equal(res.totalFreed, 0);
    assert.deepEqual(res.errors, [{ path: a, error: 'no trash here', code: 'EPERM' }]);
    assert.equal(res.results[0].ok, false);
  } finally {
    Object.assign(fsp, { unlink: real.unlink, rm: real.rm });
    fs.unlinkSync = real.unlinkSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missing files, folders, symlinks and a missing trashItem are refused, not trashed', async () => {
  const root = fixture();
  const dir = path.join(root, 'now-a-folder');
  const target = path.join(root, 'real.bin');
  const link = path.join(root, 'link.bin');
  fs.mkdirSync(dir);
  fs.writeFileSync(target, 'x');
  fs.symlinkSync(target, link);
  const trashed = [];
  try {
    const res = await trashFiles([path.join(root, 'gone.bin'), dir, link], { trashItem: async (p) => { trashed.push(p); } });
    assert.deepEqual(trashed, []);
    assert.deepEqual(res.results.map((r) => [r.ok, r.missing, r.code]), [[false, true, 'ENOENT'], [false, false, undefined], [false, false, undefined]]);
    assert.equal(fs.existsSync(target), true);
    const none = await trashFiles([target], {});
    assert.equal(none.results[0].ok, false);
    assert.equal(fs.existsSync(target), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the large-file scan never lists auto-clean\'s staging folder', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-lf-staging-')));
  const big = Buffer.alloc(2048, 1);
  const staged = path.join(root, 'Spaci', '.cache', 'auto-clean-staging', 'ac-run-000001', 'items', '1', 'node_modules', 'blob.bin');
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  fs.writeFileSync(staged, big);
  const mine = path.join(root, 'Movies', 'film.mov');
  fs.mkdirSync(path.dirname(mine), { recursive: true });
  fs.writeFileSync(mine, big);
  // A folder that is only named like it, outside a .cache folder, is still scanned.
  const lookalike = path.join(root, 'auto-clean-staging', 'notes.bin');
  fs.mkdirSync(path.dirname(lookalike), { recursive: true });
  fs.writeFileSync(lookalike, big);
  const { files } = await scanLargeFiles(root, 1024);
  assert.deepEqual(files.map((f) => f.path).sort(), [lookalike, mine].sort());
  fs.rmSync(root, { recursive: true, force: true });
});
