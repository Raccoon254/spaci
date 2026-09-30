'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startupRole, focusPlan } = require('../src/instance');

test('startupRole: only the lock holder runs as primary', () => {
  assert.equal(startupRole(true), 'primary');
  assert.equal(startupRole(false), 'secondary');
});

test('focusPlan: create when there is no live window', () => {
  assert.deepEqual(focusPlan({ exists: false }), ['create', 'focus']);
  assert.deepEqual(focusPlan({ exists: true, destroyed: true }), ['create', 'focus']);
  assert.deepEqual(focusPlan(), ['create', 'focus']);
});

test('focusPlan: restore a minimized window, show a hidden one, always focus', () => {
  assert.deepEqual(focusPlan({ exists: true, minimized: true }), ['restore', 'show', 'focus']);
  assert.deepEqual(focusPlan({ exists: true }), ['show', 'focus']);
});
