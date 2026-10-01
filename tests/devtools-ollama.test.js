'use strict';
// Ollama: parsing real API output and manifests, unique sizes over a store
// whose models share blobs, and removal that never deletes a blob another
// model still references, refuses loaded models and refuses when Ollama runs
// but cannot be asked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ollama = require('../src/devtools/ollama');
const devtools = require('../src/devtools');

const FIX = path.join(__dirname, 'fixtures', 'devtools');
const fixture = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');

const hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * A store with shared blobs:
 *   llama3.2:3b and llama3.2:latest   the same manifest content (an alias)
 *   mymodel:latest                    FROM llama3.2: shares the weights W1, own config and system prompt
 *   qwen2.5:0.5b                      own weights W2, shares the template T with llama
 *   hf.co/bartowski/tiny:Q4_K_M       a model pulled from another host
 */
function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-ollama-'));
  const blobs = {
    W1: { d: hex('W1'), size: 3 * 1024 * 1024 },
    W2: { d: hex('W2'), size: 1024 * 1024 },
    W3: { d: hex('W3'), size: 512 * 1024 },
    T: { d: hex('T'), size: 4096 },
    L: { d: hex('L'), size: 8192 },
    C1: { d: hex('C1'), size: 512 },
    C2: { d: hex('C2'), size: 512 },
    C3: { d: hex('C3'), size: 512 },
    C4: { d: hex('C4'), size: 512 },
    S: { d: hex('S'), size: 2048 },
  };
  fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true });
  for (const b of Object.values(blobs)) fs.writeFileSync(path.join(dir, 'blobs', 'sha256-' + b.d), Buffer.alloc(b.size, 1));
  // A partial download and a stray file Ollama itself would prune: never ours to touch.
  fs.writeFileSync(path.join(dir, 'blobs', 'sha256-' + hex('partial') + '-partial'), 'x');
  const manifest = (config, layers) => JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
    config: { mediaType: 'application/vnd.docker.container.image.v1+json', digest: 'sha256:' + blobs[config].d, size: blobs[config].size },
    layers: layers.map((k) => ({ mediaType: k.startsWith('W') ? 'application/vnd.ollama.image.model' : 'application/vnd.ollama.image.template', digest: 'sha256:' + blobs[k].d, size: blobs[k].size })),
  });
  const put = (host, ns, model, tag, body) => {
    const d = path.join(dir, 'manifests', host, ns, model);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, tag), body);
    return path.join(d, tag);
  };
  const files = {
    llama3b: put('registry.ollama.ai', 'library', 'llama3.2', '3b', manifest('C1', ['W1', 'T', 'L'])),
    llamaLatest: put('registry.ollama.ai', 'library', 'llama3.2', 'latest', manifest('C1', ['W1', 'T', 'L'])),
    mymodel: put('registry.ollama.ai', 'library', 'mymodel', 'latest', manifest('C2', ['W1', 'T', 'L', 'S'])),
    qwen: put('registry.ollama.ai', 'library', 'qwen2.5', '0.5b', manifest('C3', ['W2', 'T'])),
    hf: put('hf.co', 'bartowski', 'tiny', 'Q4_K_M', manifest('C4', ['W3'])),
  };
  return { dir, blobs, files };
}

// What /api/tags reports as a model's digest: the sha256 of its manifest file.
const manifestDigest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const tagFor = (name, file, extra = {}) => ({ name, model: name, digest: manifestDigest(file), ...extra });

const blobExists = (store, k) => fs.existsSync(path.join(store.dir, 'blobs', 'sha256-' + store.blobs[k].d));
const alloc = (bytes) => bytes; // fixtures are measured by allocated size; compare by presence below

// Stubs: an Ollama that is not running (no process, API refuses) unless told otherwise.
function stubs({ running = false, procOk = true, ps = null, tags = null, deleteOk = true, apiDown = !running, onDelete = null } = {}) {
  const calls = [];
  const httpJson = async (method, url, body) => {
    calls.push({ method, url, body });
    if (apiDown) return { ok: false, status: 0, json: null, error: 'ECONNREFUSED' };
    if (url.endsWith('/api/tags')) return { ok: true, status: 200, json: { models: tags || [] } };
    if (url.endsWith('/api/ps')) return { ok: true, status: 200, json: { models: ps || [] } };
    if (url.endsWith('/api/delete')) {
      if (deleteOk && onDelete) onDelete(body);
      return deleteOk ? { ok: true, status: 200, json: null } : { ok: false, status: 500, json: null };
    }
    return { ok: false, status: 404, json: null };
  };
  const procs = { ok: procOk, list: running ? [{ pid: 1079, args: '/Applications/Ollama.app/Contents/Resources/ollama serve' }] : [{ pid: 1, args: '/sbin/launchd' }] };
  return { httpJson, procs, calls };
}

test('parses the manifest Ollama wrote on a real machine', () => {
  const digests = ollama.manifestDigests(JSON.parse(fixture('ollama-manifest-nomic-embed-text.json')));
  assert.equal(digests.length, 4);
  assert.ok(digests.every((d) => /^sha256:[0-9a-f]{64}$/.test(d)));
  assert.equal(digests[0], 'sha256:31df23ea7daa448f9ccdbbcecce6c14689c8552222b80defd3830707c0139d4f');
  // On disk the colon is a dash.
  assert.equal(path.basename(ollama.blobFile('/m', digests[0])), 'sha256-31df23ea7daa448f9ccdbbcecce6c14689c8552222b80defd3830707c0139d4f');
  assert.equal(ollama.blobFile('/m', 'sha256:../../etc/passwd'), null);
  assert.equal(ollama.manifestDigests({ layers: [{ digest: 'md5:abc' }] }), null);
});

test('real /api/tags and `ollama list` name the model the way Spaci derives it from the manifest path', () => {
  const tags = JSON.parse(fixture('ollama-api-tags.json')).models;
  const name = ollama.displayName({ host: 'registry.ollama.ai', namespace: 'library', model: 'nomic-embed-text', tag: 'latest' });
  assert.equal(name, 'nomic-embed-text:latest');
  assert.ok(tags.some((t) => ollama.sameModel(t.name, name)));
  assert.match(fixture('ollama-list.txt'), /^nomic-embed-text:latest\s/m);
  assert.equal(tags[0].details.parameter_size, '137M');
  assert.equal(tags[0].details.quantization_level, 'F16');
  assert.equal(ollama.displayName({ host: 'hf.co', namespace: 'bartowski', model: 'tiny', tag: 'Q4_K_M' }), 'hf.co/bartowski/tiny:Q4_K_M');
  assert.equal(ollama.displayName({ host: 'registry.ollama.ai', namespace: 'me', model: 'x', tag: '1' }), 'me/x:1');
  assert.ok(ollama.sameModel('llama3.2', 'llama3.2:latest'));
  assert.ok(!ollama.sameModel('llama3.2:3b', 'llama3.2:latest'));
});

test('OLLAMA_HOST is reached on loopback, the way the CLI does', () => {
  assert.equal(ollama.hostUrl({}), 'http://127.0.0.1:11434');
  // The value this Mac had: a server bound to every interface.
  assert.equal(ollama.hostUrl({ OLLAMA_HOST: '0.0.0.0:11434' }), 'http://127.0.0.1:11434');
  assert.equal(ollama.hostUrl({ OLLAMA_HOST: 'http://localhost:9999' }), 'http://localhost:9999');
  assert.equal(ollama.hostUrl({ OLLAMA_HOST: '[::]:11500' }), 'http://127.0.0.1:11500');
  assert.equal(ollama.hostUrl({ OLLAMA_HOST: '127.0.0.1' }), 'http://127.0.0.1:11434');
});

test('OLLAMA_MODELS wins, then ~/.ollama/models, then the Linux service store', () => {
  assert.deepEqual(ollama.storeDirs({ platform: 'darwin', home: '/Users/a', env: { OLLAMA_MODELS: '/Volumes/big/models' } }), ['/Volumes/big/models', '/Users/a/.ollama/models']);
  assert.deepEqual(ollama.storeDirs({ platform: 'linux', home: '/home/a', env: { OLLAMA_MODELS: 'relative' } }), ['/home/a/.ollama/models', '/usr/share/ollama/.ollama/models']);
  assert.deepEqual(ollama.storeDirs({ platform: 'win32', home: 'C:\\Users\\a', env: { USERPROFILE: 'C:\\Users\\a' } }), ['C:\\Users\\a\\.ollama\\models']);
});

test('unique size counts only blobs no other model references', async () => {
  const store = makeStore();
  const manifests = await ollama.readManifests(store.dir);
  assert.deepEqual(manifests.map((m) => m.name).sort(), ['hf.co/bartowski/tiny:Q4_K_M', 'llama3.2:3b', 'llama3.2:latest', 'mymodel:latest', 'qwen2.5:0.5b']);
  const sizes = new Map(Object.values(store.blobs).map((b) => ['sha256:' + b.d, b.size]));
  const by = Object.fromEntries(ollama.computeSizes(manifests, sizes).map((s) => [s.name, s]));
  const b = store.blobs;
  // The alias pair shares everything: deleting either alone frees nothing.
  assert.equal(by['llama3.2:3b'].unique, 0);
  assert.equal(by['llama3.2:latest'].unique, 0);
  assert.equal(by['llama3.2:3b'].total, b.C1.size + b.W1.size + b.T.size + b.L.size);
  // mymodel shares the 3 MB weights; only its config and system prompt are its own.
  assert.equal(by['mymodel:latest'].unique, b.C2.size + b.S.size);
  assert.equal(by['mymodel:latest'].shared, b.W1.size + b.T.size + b.L.size);
  // qwen shares only the template.
  assert.equal(by['qwen2.5:0.5b'].unique, b.C3.size + b.W2.size);
  assert.equal(by['hf.co/bartowski/tiny:Q4_K_M'].unique, b.C4.size + b.W3.size);
});

test('blob GC never lists a blob a remaining manifest references', async () => {
  const store = makeStore();
  const manifests = await ollama.readManifests(store.dir);
  const find = (n) => manifests.find((m) => m.name === n);
  const d = (k) => 'sha256:' + store.blobs[k].d;
  assert.deepEqual(ollama.blobsToCollect(manifests, find('llama3.2:3b')), []);
  assert.deepEqual(ollama.blobsToCollect(manifests, find('mymodel:latest')).sort(), [d('C2'), d('S')].sort());
  assert.deepEqual(ollama.blobsToCollect(manifests, find('qwen2.5:0.5b')).sort(), [d('C3'), d('W2')].sort());
  // Exhaustive: for every model, nothing collected is referenced by any other manifest.
  for (const m of manifests) {
    const collected = new Set(ollama.blobsToCollect(manifests, m));
    for (const other of manifests) if (other !== m) for (const dg of other.digests) assert.ok(!collected.has(dg), `${m.name} would collect ${dg} still used by ${other.name}`);
  }
});

test('inventory lists models with unique sizes, details from the API and loaded state', async () => {
  const store = makeStore();
  const tags = [
    tagFor('qwen2.5:0.5b', store.files.qwen, { modified_at: '2026-09-01T00:00:00Z', size: 1, details: { parameter_size: '494M', quantization_level: 'Q4_K_M', family: 'qwen2' } }),
    tagFor('mymodel:latest', store.files.mymodel),
  ];
  const ps = [{ name: 'qwen2.5:0.5b', model: 'qwen2.5:0.5b', size_vram: 1000 }];
  const s = stubs({ running: true, tags, ps });
  const groups = await ollama.inventory({ platform: process.platform === 'win32' ? 'win32' : 'linux', home: os.tmpdir(), env: { OLLAMA_MODELS: store.dir, USERPROFILE: os.tmpdir() }, procs: s.procs, httpJson: s.httpJson });
  assert.equal(groups.length, 1);
  const g = groups[0];
  assert.equal(g.server.state, 'running');
  const qwen = g.items.find((i) => i.label === 'qwen2.5:0.5b');
  assert.equal(qwen.params, '494M');
  assert.equal(qwen.quant, 'Q4_K_M');
  assert.equal(qwen.state, 'running');
  assert.match(qwen.blocked, /Loaded/);
  assert.equal(qwen.tier, 'B');
  assert.equal(qwen.restoreHint, 'ollama pull qwen2.5:0.5b');
  const mine = g.items.find((i) => i.label === 'mymodel:latest');
  assert.equal(mine.blocked, null);
  assert.ok(mine.badges.some((b) => /Shares/.test(b.text)));
  assert.equal(g.total, g.items.reduce((a, i) => a + i.size, 0));
});

test('the real /api/ps shape marks a loaded model, from a capture of the documented response', () => {
  const ps = JSON.parse(fixture('ollama-api-ps-loaded.json')).models;
  assert.ok(ps.some((p) => ollama.sameModel(p.name, 'llama3.2:3b')));
  assert.deepEqual(JSON.parse(fixture('ollama-api-ps-empty.json')).models, []);
});

test('removal with no Ollama running deletes the manifest and only unreferenced blobs', async () => {
  const store = makeStore();
  const s = stubs({ running: false });
  const ctx = { env: { OLLAMA_MODELS: store.dir }, procs: s.procs, httpJson: s.httpJson };
  const item = { removal: { type: 'ollama', store: store.dir, name: 'mymodel:latest', file: store.files.mymodel } };
  const res = await ollama.remove(item, ctx);
  assert.equal(res.ok, true, res.error);
  assert.equal(res.via, 'disk');
  assert.ok(!fs.existsSync(store.files.mymodel));
  assert.ok(!blobExists(store, 'C2') && !blobExists(store, 'S'));
  // Shared with llama3.2: still there.
  for (const k of ['W1', 'T', 'L', 'C1']) assert.ok(blobExists(store, k), k + ' must survive');
  // Untouched: other models, the partial download, the manifests root.
  assert.ok(fs.existsSync(store.files.llama3b) && fs.existsSync(store.files.qwen));
  assert.ok(fs.existsSync(path.join(store.dir, 'blobs', 'sha256-' + hex('partial') + '-partial')));
  assert.ok(!fs.existsSync(path.dirname(store.files.mymodel)), 'empty model folder is tidied');
  assert.ok(fs.existsSync(path.join(store.dir, 'manifests', 'registry.ollama.ai', 'library')));
  assert.ok(res.freed > 0);
});

test('removing one alias of a model frees nothing and keeps every blob', async () => {
  const store = makeStore();
  const s = stubs({ running: false });
  const res = await ollama.remove({ removal: { type: 'ollama', store: store.dir, name: 'llama3.2:3b', file: store.files.llama3b } }, { env: {}, procs: s.procs, httpJson: s.httpJson });
  assert.equal(res.ok, true);
  assert.equal(res.freed, 0);
  for (const k of ['W1', 'T', 'L', 'C1']) assert.ok(blobExists(store, k));
  assert.ok(fs.existsSync(store.files.llamaLatest));
});

test('a loaded model is refused and nothing is touched', async () => {
  const store = makeStore();
  const s = stubs({ running: true, ps: [{ name: 'mymodel:latest', model: 'mymodel:latest' }] });
  const res = await ollama.remove({ removal: { type: 'ollama', store: store.dir, name: 'mymodel:latest', file: store.files.mymodel } }, { env: {}, procs: s.procs, httpJson: s.httpJson });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'running');
  assert.ok(fs.existsSync(store.files.mymodel) && blobExists(store, 'S'));
  assert.ok(!s.calls.some((c) => c.method === 'DELETE'));
});

test('Ollama running but not answering: refused (fail closed)', async () => {
  const store = makeStore();
  const s = stubs({ running: true, apiDown: true });
  const res = await ollama.remove({ removal: { type: 'ollama', store: store.dir, name: 'qwen2.5:0.5b', file: store.files.qwen } }, { env: {}, procs: s.procs, httpJson: s.httpJson });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'unknown-state');
  assert.ok(fs.existsSync(store.files.qwen) && blobExists(store, 'W2'));
});

test('process list unavailable and API down: refused (fail closed)', async () => {
  const store = makeStore();
  const s = stubs({ running: false, procOk: false });
  const res = await ollama.remove({ removal: { type: 'ollama', store: store.dir, name: 'qwen2.5:0.5b', file: store.files.qwen } }, { env: {}, procs: s.procs, httpJson: s.httpJson });
  assert.equal(res.code, 'unknown-state');
  assert.ok(fs.existsSync(store.files.qwen));
});

test('server running: Ollama\'s own DELETE /api/delete is used with { model }', async () => {
  const store = makeStore();
  // A server that deletes the way Ollama does: the manifest, then its unique blobs.
  const onDelete = () => {
    fs.unlinkSync(store.files.qwen);
    for (const k of ['C3', 'W2']) fs.unlinkSync(path.join(store.dir, 'blobs', 'sha256-' + store.blobs[k].d));
  };
  const s = stubs({ running: true, ps: [], tags: [tagFor('qwen2.5:0.5b', store.files.qwen)], onDelete });
  const res = await ollama.remove({ removal: { type: 'ollama', store: store.dir, name: 'qwen2.5:0.5b', file: store.files.qwen } }, { env: { OLLAMA_HOST: '0.0.0.0:11434' }, procs: s.procs, httpJson: s.httpJson });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.via, 'api');
  const del = s.calls.find((c) => c.method === 'DELETE');
  assert.equal(del.url, 'http://127.0.0.1:11434/api/delete');
  assert.deepEqual(del.body, { model: 'qwen2.5:0.5b' });
  assert.ok(res.freed > 0);
  assert.ok(blobExists(store, 'T'), 'the shared template stays');
});

test('server running: an API delete that frees nothing it should have is not reported as done', async () => {
  const store = makeStore();
  const s = stubs({ running: true, ps: [], tags: [tagFor('qwen2.5:0.5b', store.files.qwen)] });
  const res = await ollama.remove({ removal: { type: 'ollama', store: store.dir, name: 'qwen2.5:0.5b', file: store.files.qwen } }, { env: {}, procs: s.procs, httpJson: s.httpJson });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'partial');
  assert.equal(res.freed, 0);
  assert.ok(fs.existsSync(store.files.qwen), 'Spaci itself does not touch the store when the server deletes');
});

test('the /api/tags digest is the sha256 of the manifest file (real capture)', () => {
  const tags = JSON.parse(fixture('ollama-api-tags.json')).models;
  const raw = fs.readFileSync(path.join(FIX, 'ollama-manifest-nomic-embed-text.json'));
  const rec = { name: 'nomic-embed-text:latest', sha: crypto.createHash('sha256').update(raw).digest('hex') };
  assert.equal(ollama.servedTag(tags, rec), tags[0]);
  assert.equal(ollama.servedTag(tags, { ...rec, sha: hex('another copy') }), null);
  assert.equal(ollama.bareDigest('sha256:' + rec.sha), rec.sha);
});

// Critic repro r1: OLLAMA_MODELS is the live store the server uses, and a
// stale ~/.ollama/models holds another llama3:latest. Deleting the stale one
// by name through the API would delete the live copy instead.
function twoStores() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-ollama2-'));
  const home = path.join(tmp, 'home');
  const live = path.join(tmp, 'ext', 'models');
  const stale = path.join(home, '.ollama', 'models');
  const mk = (store, digestHex) => {
    const md = path.join(store, 'manifests', 'registry.ollama.ai', 'library', 'llama3');
    fs.mkdirSync(md, { recursive: true });
    fs.mkdirSync(path.join(store, 'blobs'), { recursive: true });
    fs.writeFileSync(path.join(store, 'blobs', 'sha256-' + digestHex), 'x'.repeat(5000));
    fs.writeFileSync(path.join(md, 'latest'), JSON.stringify({ config: { digest: 'sha256:' + digestHex }, layers: [] }));
    return path.join(md, 'latest');
  };
  const liveFile = mk(live, 'a'.repeat(64));
  const staleFile = mk(stale, 'b'.repeat(64));
  return { home, live, stale, liveFile, staleFile };
}

test('r1: a copy in a store the running Ollama does not use is blocked and never deleted through the API', async () => {
  const t = twoStores();
  const s = stubs({ running: true, ps: [], tags: [tagFor('llama3:latest', t.liveFile)] });
  const ctx = { platform: 'darwin', home: t.home, env: { OLLAMA_MODELS: t.live }, procs: s.procs, httpJson: s.httpJson };
  const [g] = await ollama.inventory(ctx);
  const staleItem = g.items.find((i) => i.removal.store === t.stale);
  const liveItem = g.items.find((i) => i.removal.store === t.live);
  assert.match(staleItem.blocked, /a store the running Ollama does not use/);
  assert.equal(liveItem.blocked, null);
  // Even with a forged unblocked copy, remove() checks again and refuses.
  const res = await ollama.remove(staleItem, ctx);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'not-served');
  assert.ok(!s.calls.some((c) => c.method === 'DELETE'), 'no API delete was sent');
  assert.ok(fs.existsSync(t.staleFile) && fs.existsSync(t.liveFile));
  // The same tag name without a digest (an old server) proves nothing: refused.
  const s2 = stubs({ running: true, ps: [], tags: [{ name: 'llama3:latest' }] });
  const res2 = await ollama.remove(liveItem, { ...ctx, httpJson: s2.httpJson });
  assert.equal(res2.code, 'not-served');
  assert.ok(!s2.calls.some((c) => c.method === 'DELETE'));
});

test('r1: with Ollama stopped, the stale copy is deleted on disk and the live store is untouched', async () => {
  const t = twoStores();
  const s = stubs({ running: false });
  const ctx = { platform: 'darwin', home: t.home, env: { OLLAMA_MODELS: t.live }, procs: s.procs, httpJson: s.httpJson };
  const [g] = await ollama.inventory(ctx);
  const staleItem = g.items.find((i) => i.removal.store === t.stale);
  assert.equal(staleItem.blocked, null);
  const res = await ollama.remove(staleItem, ctx);
  assert.equal(res.ok, true, res.error);
  assert.equal(res.via, 'disk');
  assert.ok(!fs.existsSync(t.staleFile));
  assert.ok(fs.existsSync(t.liveFile) && fs.existsSync(path.join(t.live, 'blobs', 'sha256-' + 'a'.repeat(64))));
});

test('a store whose blobs folder is another store\'s keeps every blob the other store still names', { skip: process.platform === 'win32' }, async () => {
  const t = twoStores();
  // The stale store's blobs folder is the live one's; both manifests name blob A.
  fs.rmSync(path.join(t.stale, 'blobs'), { recursive: true });
  fs.symlinkSync(path.join(t.live, 'blobs'), path.join(t.stale, 'blobs'));
  fs.writeFileSync(t.staleFile, fs.readFileSync(t.liveFile));
  const s = stubs({ running: false });
  const ctx = { platform: 'darwin', home: t.home, env: { OLLAMA_MODELS: t.live }, procs: s.procs, httpJson: s.httpJson };
  const manifests = await ollama.readManifests(t.stale);
  const res = await ollama.removeOnDisk(t.stale, manifests[0], manifests, new Map(), ollama.storeDirs(ctx));
  assert.equal(res.ok, true, res.error);
  assert.ok(fs.existsSync(path.join(t.live, 'blobs', 'sha256-' + 'a'.repeat(64))), 'blob still named by the live store stays');
});

test('removeItem re-detects first: a model loaded since the listing is refused', async () => {
  const store = makeStore();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-home-'));
  const env = { OLLAMA_MODELS: store.dir, USERPROFILE: home };
  const quiet = stubs({ running: false });
  const listed = await devtools.inventory({ only: ['ollama'], home, env, procs: quiet.procs, httpJson: quiet.httpJson });
  const item = listed.groups[0].items.find((i) => i.label === 'mymodel:latest');
  assert.ok(item && !item.blocked);
  // Now it is loaded.
  const busy = stubs({ running: true, ps: [{ name: 'mymodel:latest' }] });
  const res = await devtools.removeItem(item, { home, env, procs: busy.procs, httpJson: busy.httpJson });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'blocked');
  assert.ok(fs.existsSync(store.files.mymodel));
  void alloc;
});
