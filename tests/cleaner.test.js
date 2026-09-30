'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cleaner = require('../src/cleaner');

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-clean-'));
}

function write(file, text = 'x'.repeat(4096)) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** Lock a tree the way Go's module cache is: 0444 files inside 0555 dirs. */
function lock(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) lock(p); else fs.chmodSync(p, 0o444);
  }
  fs.chmodSync(dir, 0o555);
}

function unlockAndRemove(dir) {
  const walk = (d) => {
    try { fs.chmodSync(d, 0o755); } catch { return; }
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
    }
  };
  walk(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

test('a read-only Go module cache shape is emptied and reported freed', async () => {
  const root = fixture();
  const mod = path.join(root, 'mod');
  write(path.join(mod, 'github.com/foo/bar@v1.0.0/bar.go'));
  write(path.join(mod, 'github.com/foo/bar@v1.0.0/internal/x.go'));
  write(path.join(mod, 'cache/download/zip.zip'));
  lock(mod);

  const res = await cleaner.clean([{ path: mod, mode: 'contents' }]);
  try {
    assert.deepEqual(res.errors, []);
    assert.deepEqual(fs.readdirSync(mod), [], 'the target directory stays, empty');
    assert.ok(res.totalFreed > 0);
  } finally { unlockAndRemove(root); }
});

test('a read-only tree removed as a whole path leaves nothing behind', async () => {
  const root = fixture();
  const tree = path.join(root, 'tree');
  write(path.join(tree, 'a/b/c.txt'));
  lock(tree);
  fs.chmodSync(root, 0o555); // even the parent cannot be written
  try {
    const res = await cleaner.clean([{ path: tree }]);
    assert.deepEqual(res.errors, []);
    assert.equal(fs.existsSync(tree), false);
  } finally { unlockAndRemove(root); }
});

test('a failure that leaves the path behind is reported, never called success', async (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip('root ignores permission bits');
  const root = fixture();
  const dir = path.join(root, 'stuck');
  write(path.join(dir, 'a.txt'));
  const fsp = fs.promises;
  const realUnlink = fsp.unlink;
  // Simulate a file the OS refuses to release, however much we chmod.
  fsp.unlink = async (p) => {
    if (p.endsWith('a.txt')) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
    return realUnlink.call(fsp, p);
  };
  try {
    const res = await cleaner.clean([{ path: dir }]);
    assert.equal(fs.existsSync(path.join(dir, 'a.txt')), true);
    assert.equal(res.errors.length, 1, 'the surviving path must produce an error');
    assert.match(res.errors[0].error, /EBUSY/);
    assert.deepEqual(res.errors[0].failedPaths, [path.join(dir, 'a.txt')]);
  } finally {
    fsp.unlink = realUnlink;
    unlockAndRemove(root);
  }
});

test('symlinks are removed as links and never followed out of the target', async () => {
  const root = fixture();
  const outside = path.join(root, 'outside');
  const outsideFile = path.join(outside, 'precious.txt');
  write(outsideFile, 'keep me');
  const target = path.join(root, 'target');
  write(path.join(target, 'junk.txt'));
  fs.symlinkSync(outsideFile, path.join(target, 'link-to-file'));
  fs.symlinkSync(outside, path.join(target, 'link-to-dir'));
  fs.symlinkSync(path.join(root, 'nowhere'), path.join(target, 'dangling'));

  const res = await cleaner.clean([{ path: target, mode: 'contents' }]);
  try {
    assert.deepEqual(res.errors, []);
    assert.deepEqual(fs.readdirSync(target), []);
    assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'keep me');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a symlink passed as the path is unlinked and its target survives', async () => {
  const root = fixture();
  const outsideFile = path.join(root, 'outside', 'precious.txt');
  write(outsideFile, 'keep me');
  const link = path.join(root, 'link');
  fs.symlinkSync(path.join(root, 'outside'), link);

  await cleaner.clean([{ path: link }]);
  try {
    assert.equal(fs.existsSync(outsideFile), true);
    assert.throws(() => fs.lstatSync(link));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a target that is itself a symlink is refused in contents mode', async () => {
  const root = fixture();
  const outsideFile = path.join(root, 'outside', 'precious.txt');
  write(outsideFile, 'keep me');
  const link = path.join(root, 'link');
  fs.symlinkSync(path.join(root, 'outside'), link);

  const res = await cleaner.clean([{ path: link, mode: 'contents' }]);
  try {
    assert.equal(fs.existsSync(outsideFile), true);
    assert.equal(res.errors.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('protect keeps memory/ and deletes everything else under ~/.claude/projects', async () => {
  const root = fixture();
  const projects = path.join(root, 'projects');
  write(path.join(projects, 'p1/abc.jsonl'));
  write(path.join(projects, 'p1/sub/x.jsonl'));
  write(path.join(projects, 'p1/memory/MEMORY.md'), 'remember');
  write(path.join(projects, 'p2/memory/notes/deep.md'), 'deep');
  write(path.join(projects, 'p3/only.jsonl'));

  const res = await cleaner.clean([{ path: projects, mode: 'contents', protect: ['memory'] }]);
  try {
    assert.deepEqual(res.errors, []);
    assert.equal(fs.existsSync(path.join(projects, 'p1/abc.jsonl')), false);
    assert.equal(fs.existsSync(path.join(projects, 'p1/sub/x.jsonl')), false);
    assert.equal(fs.existsSync(path.join(projects, 'p1/sub')), false, 'emptied siblings are removed');
    assert.equal(fs.readFileSync(path.join(projects, 'p1/memory/MEMORY.md'), 'utf8'), 'remember');
    assert.equal(fs.readFileSync(path.join(projects, 'p2/memory/notes/deep.md'), 'utf8'), 'deep');
    assert.equal(fs.existsSync(path.join(projects, 'p3')), false, 'a project with nothing protected goes entirely');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('protect applies at any depth and to a protected file as well as a directory', async () => {
  const root = fixture();
  const t = path.join(root, 't');
  write(path.join(t, 'a/b/c/keep'), 'deep file');
  write(path.join(t, 'a/b/c/drop'));
  write(path.join(t, 'a/b/other'));
  write(path.join(t, 'keep'), 'top file');

  await cleaner.clean([{ path: t, mode: 'contents', protect: ['keep'] }]);
  try {
    assert.equal(fs.readFileSync(path.join(t, 'a/b/c/keep'), 'utf8'), 'deep file');
    assert.equal(fs.readFileSync(path.join(t, 'keep'), 'utf8'), 'top file');
    assert.equal(fs.existsSync(path.join(t, 'a/b/c/drop')), false);
    assert.equal(fs.existsSync(path.join(t, 'a/b/other')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('protect also guards a path removed directly, and matches names case-insensitively', async () => {
  const root = fixture();
  const t = path.join(root, 'p1');
  write(path.join(t, 'log.jsonl'));
  write(path.join(t, 'Memory/MEMORY.md'), 'remember');

  await cleaner.clean([{ path: t, protect: ['memory'] }]);
  try {
    assert.equal(fs.existsSync(path.join(t, 'log.jsonl')), false);
    assert.equal(fs.readFileSync(path.join(t, 'Memory/MEMORY.md'), 'utf8'), 'remember');
    assert.equal(fs.existsSync(t), true, 'the directory holding a protected entry stays');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('without protect everything goes, and .DS_Store is still left alone', async () => {
  const root = fixture();
  const t = path.join(root, 't');
  write(path.join(t, 'memory/MEMORY.md'));
  write(path.join(t, 'x/y.txt'));
  write(path.join(t, '.DS_Store'));

  const res = await cleaner.clean([{ path: t, mode: 'contents' }]);
  try {
    assert.deepEqual(res.errors, []);
    assert.deepEqual(fs.readdirSync(t), ['.DS_Store']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
