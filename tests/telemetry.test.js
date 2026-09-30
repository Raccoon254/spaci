'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { maybePing, mapPlatform } = require('../src/telemetry');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function harness(prefs = {}, opts = {}) {
  const calls = [];
  const saves = [];
  const args = {
    prefs,
    savePrefs: async (p) => { saves.push({ ...p }); },
    version: '2.1.0',
    platform: 'darwin',
    arch: 'arm64',
    fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 204 }; },
    now: () => new Date('2026-09-30T10:00:00Z'),
    ...opts
  };
  return { args, calls, saves };
}

test('opt-out sends nothing and stores nothing', async () => {
  const h = harness({ telemetry: false });
  await maybePing(h.args);
  assert.equal(h.calls.length, 0);
  assert.equal(h.saves.length, 0);
  assert.equal(h.args.prefs.installId, undefined);
});

test('first run creates and persists an install ID', async () => {
  const h = harness({});
  await maybePing(h.args);
  assert.match(h.args.prefs.installId, UUID);
  assert.ok(h.saves.some((s) => s.installId === h.args.prefs.installId));
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, 'https://spaci.kentom.co.ke/api/ping');
  assert.equal(h.calls[0].init.method, 'POST');
});

test('an existing install ID is never regenerated', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const h = harness({ installId: id });
  await maybePing(h.args);
  assert.equal(h.args.prefs.installId, id);
  assert.equal(JSON.parse(h.calls[0].init.body).installId, id);
});

test('same-day repeat does not send', async () => {
  const h = harness({});
  await maybePing(h.args);
  await maybePing(h.args);
  assert.equal(h.calls.length, 1);
});

test('next day sends again', async () => {
  const h = harness({});
  await maybePing(h.args);
  h.args.now = () => new Date('2026-10-01T00:05:00Z');
  await maybePing(h.args);
  assert.equal(h.calls.length, 2);
  assert.equal(h.args.prefs.lastPingDate, '2026-10-01');
});

test('fetch failure does not throw and does not record today as sent', async () => {
  const h = harness({}, { fetchImpl: async () => { throw new Error('offline'); } });
  await assert.doesNotReject(maybePing(h.args));
  assert.equal(h.args.prefs.lastPingDate, undefined);
  // Retry later the same day succeeds.
  const ok = harness(h.args.prefs);
  await maybePing(ok.args);
  assert.equal(ok.calls.length, 1);
});

test('a non-2xx response is not recorded as sent', async () => {
  const h = harness({}, { fetchImpl: async () => ({ ok: false, status: 500 }) });
  await maybePing(h.args);
  assert.equal(h.args.prefs.lastPingDate, undefined);
});

test('payload has exactly installId, version, platform, arch', async () => {
  const h = harness({});
  await maybePing(h.args);
  const body = JSON.parse(h.calls[0].init.body);
  assert.deepEqual(Object.keys(body).sort(), ['arch', 'installId', 'platform', 'version']);
  assert.equal(body.version, '2.1.0');
  assert.equal(body.platform, 'mac');
  assert.equal(body.arch, 'arm64');
  assert.ok(h.calls[0].init.signal, 'request carries an abort signal');
});

test('platform mapping', () => {
  assert.equal(mapPlatform('darwin'), 'mac');
  assert.equal(mapPlatform('win32'), 'windows');
  assert.equal(mapPlatform('linux'), 'linux');
});
