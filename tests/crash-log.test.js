'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCrashLog, formatEntry, needsRotation, describeError, MAX_BYTES } = require('../src/crash-log');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-log-'));
const at = new Date('2026-09-30T12:00:00.000Z');

test('formatEntry: one timestamped line, continuation lines indented, capped', () => {
  assert.equal(formatEntry(at, 'error', 'boom'), '2026-09-30T12:00:00.000Z [error] boom\n');
  assert.equal(formatEntry(at, 'error', 'a\nb\r\nc'), '2026-09-30T12:00:00.000Z [error] a\n    b\n    c\n');
  const huge = formatEntry(at, 'info', 'x'.repeat(100000));
  assert.ok(huge.length < 17 * 1024);
  assert.match(huge, /\[truncated 83616 chars\]/);
});

test('describeError handles errors, objects, and primitives', () => {
  const e = new Error('bad');
  assert.match(describeError(e), /^Error: bad\n\s+at /);
  assert.equal(describeError({ code: 1 }), '{"code":1}');
  assert.equal(describeError('plain'), 'plain');
  assert.equal(describeError(undefined), 'undefined');
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal(describeError(cyclic), '[object Object]');
});

test('needsRotation: only a non-empty file that would pass the limit', () => {
  assert.equal(MAX_BYTES, 1024 * 1024);
  assert.equal(needsRotation(0, 5000, 100), false, 'an empty file takes even an oversized entry');
  assert.equal(needsRotation(90, 10, 100), false);
  assert.equal(needsRotation(90, 11, 100), true);
});

test('the log appends, creates its folder, and rotates to main.log.1 at the limit', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'logs', 'main.log');
    const log = createCrashLog({ file, maxBytes: 200, now: () => at });
    assert.equal(log.info('started'), true);
    const first = new Error('first');
    first.stack = 'Error: first\n    at here';
    assert.equal(log.error('uncaughtException', first), true);
    assert.match(fs.readFileSync(file, 'utf8'), /\[info\] started\n.*\[error\] uncaughtException: Error: first\n {8}at here\n$/s);
    for (let i = 0; i < 5; i++) log.warn('filler line number ' + i + ' '.repeat(40));
    assert.ok(fs.existsSync(file + '.1'), 'rotated');
    assert.ok(fs.statSync(file).size <= 200);
    // Rotating again replaces the old backup: at most two files.
    for (let i = 0; i < 10; i++) log.warn('more filler ' + i + ' '.repeat(60));
    assert.deepEqual(fs.readdirSync(path.join(dir, 'logs')).sort(), ['main.log', 'main.log.1']);
    assert.ok(fs.statSync(file + '.1').size <= 200 + 200);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a failing disk never throws out of the log', () => {
  const broken = {
    mkdirSync() { throw new Error('EACCES'); }, statSync() { throw new Error('x'); },
    renameSync() { throw new Error('x'); }, appendFileSync() { throw new Error('ENOSPC'); },
  };
  const log = createCrashLog({ file: '/nope/main.log', fs: broken });
  assert.equal(log.error('x', new Error('y')), false);
  assert.equal(createCrashLog({ file: null }).info('x'), false);
});
