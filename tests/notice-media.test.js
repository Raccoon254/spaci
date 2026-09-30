'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const media = require('../src/notice-media');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64, 3)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(64, 4)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
const OK = 'https://spaci.kentom.co.ke/media/a.png';
const quiet = { info() {}, warn() {}, error() {} };

/** A fake transport: routes url -> response spec. Records every request. */
function fakeNet(routes) {
  const calls = [];
  let pulled = 0;
  const request = async (url) => {
    calls.push(url);
    const r = routes[url];
    if (!r) throw new Error('ENOTFOUND');
    const chunks = r.chunks || (r.data ? [r.data] : []);
    return {
      status: r.status || 200,
      headers: r.headers || { 'content-type': 'image/png' },
      body: (async function* gen() { for (const c of chunks) { pulled++; yield c; } })(),
      destroy() { this.destroyed = true; },
    };
  };
  return { request, calls, pulled: () => pulled };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-media-'));

test('sniffImage recognises the four raster types and nothing else', () => {
  assert.equal(media.sniffImage(PNG), 'image/png');
  assert.equal(media.sniffImage(JPEG), 'image/jpeg');
  assert.equal(media.sniffImage(GIF), 'image/gif');
  assert.equal(media.sniffImage(WEBP), 'image/webp');
  assert.equal(media.sniffImage(SVG), null);
  assert.equal(media.sniffImage(Buffer.from('<html><body>x</body></html>')), null);
  assert.equal(media.sniffImage(Buffer.alloc(3)), null);
});

test('an allowlisted PNG becomes a data URL, is cached atomically on disk, and is served from cache after', async () => {
  const dir = tmp();
  try {
    const net = fakeNet({ [OK]: { data: PNG } });
    const c = media.createMediaCache({ dir, request: net.request, log: quiet });
    const url = await c.resolve(OK);
    assert.equal(url, 'data:image/png;base64,' + PNG.toString('base64'));
    assert.deepEqual(fs.readdirSync(dir), [media.hashUrl(OK)], 'one file named by url hash, no temp files');
    assert.equal(await c.resolve(OK), url);
    assert.equal(net.calls.length, 1, 'second resolve hits the disk cache');
    // A fresh cache instance (next launch) also reads it from disk.
    const c2 = media.createMediaCache({ dir, request: net.request, log: quiet });
    assert.equal(await c2.resolve(OK), url);
    assert.equal(net.calls.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an off-allowlist URL is never requested', async () => {
  const dir = tmp();
  try {
    const net = fakeNet({});
    const c = media.createMediaCache({ dir, request: net.request, log: quiet });
    assert.equal(await c.resolve('https://evil.com/a.png'), null);
    assert.equal(await c.resolve('http://spaci.kentom.co.ke/a.png'), null);
    assert.equal(net.calls.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a redirect to an off-allowlist host is refused before it is requested', async () => {
  const net = fakeNet({
    [OK]: { status: 302, headers: { location: 'https://evil.com/steal.png' } },
    'https://evil.com/steal.png': { data: PNG },
  });
  await assert.rejects(media.downloadImage(OK, { request: net.request }), /redirect-not-allowed/);
  assert.deepEqual(net.calls, [OK]);
  // Relative redirects resolve against the current URL and are re-checked too.
  const net2 = fakeNet({
    [OK]: { status: 301, headers: { location: '/media/b.png' } },
    'https://spaci.kentom.co.ke/media/b.png': { data: PNG },
  });
  assert.equal((await media.downloadImage(OK, { request: net2.request })).mime, 'image/png');
  // github.com -> raw.githubusercontent.com outside /Raccoon254/ is refused.
  const gh = 'https://github.com/Raccoon254/spaci/raw/main/a.png';
  const net3 = fakeNet({ [gh]: { status: 302, headers: { location: 'https://raw.githubusercontent.com/someone/else/a.png' } } });
  await assert.rejects(media.downloadImage(gh, { request: net3.request }), /redirect-not-allowed/);
});

test('redirect loops stop', async () => {
  const net = fakeNet({ [OK]: { status: 302, headers: { location: OK } } });
  await assert.rejects(media.downloadImage(OK, { request: net.request }), /too-many-redirects/);
  assert.equal(net.calls.length, 4);
});

test('a 10 MB image is refused while streaming, without reading it all', async () => {
  const chunk = Buffer.concat([PNG, Buffer.alloc(1024 * 1024 - PNG.length)]);
  const net = fakeNet({ [OK]: { chunks: Array.from({ length: 10 }, () => chunk) } });
  await assert.rejects(media.downloadImage(OK, { request: net.request }), /too-large/);
  assert.ok(net.pulled() <= 4, `stopped after ${net.pulled()} MB`);
  // A declared Content-Length over the cap is refused before any byte is read.
  const net2 = fakeNet({ [OK]: { headers: { 'content-type': 'image/png', 'content-length': String(10 * 1024 * 1024) }, chunks: [chunk] } });
  await assert.rejects(media.downloadImage(OK, { request: net2.request }), /too-large/);
  assert.equal(net2.pulled(), 0);
});

test('an SVG served as image/png is refused by its bytes; SVG and HTML content types are refused outright', async () => {
  const net = fakeNet({ [OK]: { data: SVG, headers: { 'content-type': 'image/png' } } });
  await assert.rejects(media.downloadImage(OK, { request: net.request }), /not-a-raster-image/);
  for (const type of ['image/svg+xml', 'text/html', '', 'application/octet-stream']) {
    const n = fakeNet({ [OK]: { data: PNG, headers: { 'content-type': type } } });
    await assert.rejects(media.downloadImage(OK, { request: n.request }), /bad-content-type/, type);
  }
  const ok = fakeNet({ [OK]: { data: JPEG, headers: { 'content-type': 'image/jpeg; charset=binary' } } });
  assert.equal((await media.downloadImage(OK, { request: ok.request })).mime, 'image/jpeg');
  const err = fakeNet({ [OK]: { status: 404 } });
  await assert.rejects(media.downloadImage(OK, { request: err.request }), /http-404/);
});

test('failures are remembered for a while instead of refetched on every list', async () => {
  const dir = tmp();
  try {
    let t = 1000;
    const net = fakeNet({ [OK]: { data: SVG } });
    const c = media.createMediaCache({ dir, request: net.request, log: quiet, now: () => t });
    assert.equal(await c.resolve(OK), null);
    assert.equal(await c.resolve(OK), null);
    assert.equal(net.calls.length, 1);
    t += media.DEFAULTS.failureTtlMs + 1;
    await c.resolve(OK);
    assert.equal(net.calls.length, 2);
    assert.deepEqual(fs.readdirSync(dir), [], 'nothing cached for a refused image');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a corrupted cache file is discarded and refetched', async () => {
  const dir = tmp();
  try {
    const net = fakeNet({ [OK]: { data: PNG } });
    const c = media.createMediaCache({ dir, request: net.request, log: quiet });
    fs.writeFileSync(c.fileFor(OK), SVG);
    assert.match(await c.resolve(OK), /^data:image\/png;base64,/);
    assert.equal(net.calls.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the cache is bounded: least recently used files are evicted', async () => {
  const dir = tmp();
  try {
    let t = Date.UTC(2026, 0, 1);
    const urls = ['a', 'b', 'c', 'd'].map((x) => `https://spaci.kentom.co.ke/media/${x}.png`);
    const routes = Object.fromEntries(urls.map((u) => [u, { data: PNG }]));
    const net = fakeNet(routes);
    const c = media.createMediaCache({ dir, request: net.request, log: quiet, now: () => t, options: { maxCacheBytes: PNG.length * 3, maxCacheFiles: 10 } });
    for (const u of urls.slice(0, 3)) {
      await c.resolve(u);
      const d = new Date(t); fs.utimesSync(c.fileFor(u), d, d); t += 60000;
    }
    await c.resolve(urls[0]); // touch a: b is now the oldest
    await c.resolve(urls[3]); // over budget: evict b
    const left = new Set(fs.readdirSync(dir));
    assert.equal(left.size, 3);
    assert.ok(!left.has(media.hashUrl(urls[1])), 'b evicted');
    assert.ok(left.has(media.hashUrl(urls[0])) && left.has(media.hashUrl(urls[3])));
    // File-count budget too.
    const c2 = media.createMediaCache({ dir, request: net.request, log: quiet, now: () => t, options: { maxCacheFiles: 1 } });
    c2.evict();
    assert.equal(fs.readdirSync(dir).length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('hydrateMedia swaps image URLs for data URLs and drops the ones that fail', async () => {
  const resolve = async (u) => (u.endsWith('ok.png') ? 'data:image/png;base64,AA' : null);
  const out = await media.hydrateMedia({
    id: 'x',
    body: [{ t: 'p', c: [] }, { t: 'img', url: 'https://spaci.kentom.co.ke/ok.png', alt: 'a' }, { t: 'img', url: 'https://spaci.kentom.co.ke/bad.png', alt: 'b' }],
    media: [{ url: 'https://spaci.kentom.co.ke/bad.png', alt: 'c' }, { url: 'https://spaci.kentom.co.ke/ok.png', alt: 'd' }],
  }, resolve);
  assert.deepEqual(out.body, [{ t: 'p', c: [] }, { t: 'img', url: 'data:image/png;base64,AA', alt: 'a' }]);
  assert.deepEqual(out.media, [{ url: 'data:image/png;base64,AA', alt: 'd' }]);
  assert.equal(out.id, 'x');
});
