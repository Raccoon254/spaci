'use strict';
// Simulators, Android, toolchains, IDE leftovers, Hugging Face revisions and
// the shared helpers: parsers against real captured output, protection
// rules, and removals that stay inside each tool's own folder.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const simulators = require('../src/devtools/simulators');
const android = require('../src/devtools/android');
const toolchains = require('../src/devtools/toolchains');
const ide = require('../src/devtools/ideandcaches');
const hf = require('../src/devtools/hfcache');
const aistores = require('../src/devtools/aistores');
const processes = require('../src/devtools/processes');
const util = require('../src/devtools/util');
const devtools = require('../src/devtools');
const policy = require('../src/devtools/policy');

const FIX = path.join(__dirname, 'fixtures', 'devtools');
const fixture = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-' + p + '-'));
const write = (file, body = '') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
const quietProcs = { ok: true, list: [{ pid: 1, args: '/sbin/launchd' }] };
const canSymlink = process.platform !== 'win32';

/** execFile stub: answers from a table keyed by "cmd arg arg". */
function execStub(table, calls = []) {
  return (cmd, args, opts, cb) => {
    const key = [path.basename(cmd), ...args].join(' ');
    calls.push(key);
    const hit = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
    setImmediate(() => {
      if (hit === undefined) { const e = new Error('spawn ' + cmd + ' ENOENT'); e.code = 'ENOENT'; return cb(e, '', ''); }
      if (hit instanceof Error) return cb(hit, '', hit.message);
      cb(null, hit, '');
    });
  };
}

// ---- simulators -----------------------------------------------------------------

test('simctl: real runtime list and device JSON parse', () => {
  const rts = simulators.parseRuntimes(fixture('simctl-runtime-list.json'));
  assert.equal(rts.length, 1);
  assert.equal(rts[0].version, '26.5');
  assert.equal(rts[0].sizeBytes, 8494282293);
  assert.equal(rts[0].deletable, true);
  assert.equal(rts[0].runtimeIdentifier, 'com.apple.CoreSimulator.SimRuntime.iOS-26-5');
  assert.equal(rts[0].platform, 'iphone');
  assert.deepEqual(simulators.parseDevices(fixture('simctl-devices-empty.json')), []);
  const devs = simulators.parseDevices(fixture('simctl-devices-sample.json'));
  assert.equal(devs.length, 3);
  assert.equal(simulators.runtimeLabel('com.apple.CoreSimulator.SimRuntime.iOS-17-5'), 'iOS 17.5');
  assert.equal(simulators.parseDevices('not json'), null);
});

test('simulators: a booted device and the runtime it uses are blocked; an unavailable one is tier B', async () => {
  const home = tmp('home');
  const exec = execStub({
    'xcrun simctl list -j devices': fixture('simctl-devices-sample.json'),
    'xcrun simctl runtime list -j': fixture('simctl-runtime-list.json'),
  });
  const [g] = await simulators.inventory({ platform: 'darwin', home, env: {}, exec, procs: quietProcs });
  const by = (label) => g.items.find((i) => i.label === label);
  assert.match(by('iPhone 17 Pro').blocked, /running/);
  assert.equal(by('iPhone 17 Pro').state, 'running');
  assert.equal(by('iPhone Air').blocked, null);
  assert.equal(by('iPhone Air').tier, 'C', 'a working simulator holds its own apps and data');
  assert.equal(by('iPhone 15').tier, 'B');
  assert.match(by('iOS 26.5 runtime').blocked, /booted simulator uses/);
  assert.deepEqual(by('iPhone Air').removal.args, ['simctl', 'delete', '11111111-2222-3333-4444-555555555555']);
  assert.deepEqual(by('iOS 26.5 runtime').removal.args, ['simctl', 'runtime', 'delete', '52EA34FD-36B1-4643-835D-556EEE4F3AB8']);
  assert.match(by('iOS 26.5 runtime').restoreHint, /xcodebuild -downloadPlatform iOS/);
  assert.deepEqual(await simulators.inventory({ platform: 'linux', home, env: {}, exec }), []);
});

// ---- Android --------------------------------------------------------------------

test('Android: real sdkmanager and avdmanager output parse', () => {
  const pk = android.parseSdkInstalled(fixture('sdkmanager-list-installed.txt'));
  assert.deepEqual(pk.map((p) => p.path), ['build-tools;35.0.0', 'build-tools;36.0.0', 'cmake;3.22.1', 'ndk;27.1.12297006', 'platform-tools', 'platforms;android-36']);
  assert.deepEqual(android.parseAvdList(fixture('avdmanager-list-avd-empty.txt')), []);
  const avds = android.parseAvdList(fixture('avdmanager-list-avd-sample.txt'));
  assert.deepEqual(avds.map((a) => [a.name, a.abi]), [['Pixel_8_API_34', 'google_apis/arm64-v8a'], ['Tablet_API_33', 'default/arm64-v8a']]);
  assert.equal(android.imagePackage('system-images/android-34/google_apis/arm64-v8a/'), 'system-images;android-34;google_apis;arm64-v8a');
  assert.equal(android.imagePackage('system-images\\android-33\\default\\x86_64\\'), 'system-images;android-33;default;x86_64');
});

test('Android: SDK and AVD homes follow the documented variables', () => {
  assert.equal(android.sdkRoot({ platform: 'darwin', home: '/Users/a', env: {} }), '/Users/a/Library/Android/sdk');
  assert.equal(android.sdkRoot({ platform: 'linux', home: '/h', env: { ANDROID_SDK_ROOT: '/opt/sdk' } }), '/opt/sdk');
  assert.equal(android.sdkRoot({ platform: 'linux', home: '/h', env: { ANDROID_HOME: '/a', ANDROID_SDK_ROOT: '/b' } }), '/a');
  assert.equal(android.avdHome({ platform: 'linux', home: '/h', env: {} }), '/h/.android/avd');
  assert.equal(android.avdHome({ platform: 'linux', home: '/h', env: { ANDROID_USER_HOME: '/u' } }), '/u/avd');
  assert.equal(android.avdHome({ platform: 'linux', home: '/h', env: { ANDROID_EMULATOR_HOME: '/e', ANDROID_USER_HOME: '/u' } }), '/e/avd');
  assert.equal(android.avdHome({ platform: 'linux', home: '/h', env: { ANDROID_AVD_HOME: '/x' } }), '/x');
});

test('Android: images an emulator uses are blocked, running emulators are blocked, older NDKs are offered', async () => {
  const sdk = tmp('sdk');
  const avdHome = tmp('avd');
  const img = (api, tag, abi) => write(path.join(sdk, 'system-images', api, tag, abi, 'system.img'), 'x'.repeat(2048));
  img('android-34', 'google_apis', 'arm64-v8a');
  img('android-30', 'default', 'x86_64');
  write(path.join(sdk, 'ndk', '25.2.9519653', 'source.properties'), 'x');
  write(path.join(sdk, 'ndk', '27.1.12297006', 'source.properties'), 'x');
  const avd = (name, image, lock) => {
    write(path.join(avdHome, name + '.ini'), 'avd.ini.encoding=UTF-8\npath=' + path.join(avdHome, name + '.avd') + '\n');
    write(path.join(avdHome, name + '.avd', 'config.ini'), 'avd.ini.displayname=' + name.replace(/_/g, ' ') + '\nimage.sysdir.1=' + image + '\n');
    write(path.join(avdHome, name + '.avd', 'userdata-qemu.img'), 'u'.repeat(4096));
    if (lock) write(path.join(avdHome, name + '.avd', 'hardware-qemu.ini.lock'), '');
  };
  avd('Pixel_8_API_34', 'system-images/android-34/google_apis/arm64-v8a/', false);
  avd('Running_One', 'system-images/android-34/google_apis/arm64-v8a/', true);
  const [g] = await android.inventory({ platform: 'linux', home: tmp('h'), env: { ANDROID_HOME: sdk, ANDROID_AVD_HOME: avdHome }, procs: quietProcs });
  const by = (id) => g.items.find((i) => i.id === id);
  assert.equal(by('avd:Pixel_8_API_34').blocked, null);
  assert.equal(by('avd:Pixel_8_API_34').tier, 'C');
  assert.deepEqual(by('avd:Pixel_8_API_34').removal.args, ['delete', 'avd', '-n', 'Pixel_8_API_34']);
  assert.match(by('avd:Running_One').blocked, /running/);
  assert.match(by('sysimage:system-images;android-34;google_apis;arm64-v8a').blocked, /running|use this image/);
  const free = by('sysimage:system-images;android-30;default;x86_64');
  assert.equal(free.blocked, null);
  assert.deepEqual(free.removal.args, ['--sdk_root=' + sdk, '--uninstall', 'system-images;android-30;default;x86_64']);
  assert.ok(by('ndk:25.2.9519653'));
  assert.ok(!by('ndk:27.1.12297006'), 'the newest NDK is never offered');
});

// ---- toolchains -----------------------------------------------------------------

test('toolchain pins: files, engines and specs', () => {
  const pins = toolchains.pinsFromFiles({
    '.nvmrc': 'v20\n', '.python-version': '3.12.4\n3.11\n', 'rust-toolchain.toml': '[toolchain]\nchannel = "1.79.0"\n',
    'package.json': JSON.stringify({ engines: { node: '^22.1.0' }, volta: { node: '18.20.4' } }), '.tool-versions': 'nodejs 21.7.3\npython 3.10.14\n',
  });
  assert.deepEqual(pins.node.map((p) => p.spec).sort(), ['18.20.4', '20', '21.7.3', '22.1.0'].sort());
  assert.deepEqual(pins.python.map((p) => p.spec).sort(), ['3.10.14', '3.11', '3.12.4']);
  assert.deepEqual(pins.rust.map((p) => p.spec), ['1.79.0']);
  assert.equal(toolchains.cleanSpec('lts/*'), null);
  assert.equal(toolchains.cleanSpec('20.x'), '20');
  const installed = ['v18.20.0', 'v20.11.1', 'v20.12.0', 'v22.1.0'];
  assert.equal(toolchains.resolveSpec('20', installed), 'v20.12.0', 'a major pin resolves to the newest installed match');
  assert.equal(toolchains.resolveSpec('20.11.1', installed), 'v20.11.1');
  assert.equal(toolchains.resolveSpec('19', installed), null);
});

test('nvm: pinned, default and running versions are protected; an unused one is removed by path only', async () => {
  const nvmDir = tmp('nvm');
  for (const v of ['v18.20.0', 'v20.11.1', 'v20.12.0', 'v22.1.0']) write(path.join(nvmDir, 'versions', 'node', v, 'bin', 'node'), 'n'.repeat(1024));
  write(path.join(nvmDir, 'alias', 'default'), '22\n');
  const proj = tmp('proj');
  write(path.join(proj, '.nvmrc'), '20\n');
  const procs = { ok: true, list: [{ pid: 9, args: path.join(nvmDir, 'versions', 'node', 'v20.11.1', 'bin', 'node') + ' server.js' }] };
  const opts = { platform: 'linux', home: tmp('h'), env: { NVM_DIR: nvmDir }, projects: [proj], procs };
  const inv = await devtools.inventory({ ...opts, only: ['toolchains'] });
  const g = inv.groups.find((x) => x.id === 'nvm');
  const by = (v) => g.items.find((i) => i.version === v);
  assert.match(by('v20.12.0').blocked, /Pinned by .* \(\.nvmrc\)/);
  assert.equal(by('v20.12.0').tier, 'C');
  assert.match(by('v22.1.0').blocked, /default/);
  assert.match(by('v20.11.1').blocked, /running program/);
  assert.equal(by('v18.20.0').blocked, null);
  assert.equal(by('v18.20.0').tier, 'B');
  assert.equal(by('v18.20.0').restoreHint, 'nvm install v18.20.0');
  const res = await devtools.removeItem(by('v18.20.0'), opts);
  assert.equal(res.ok, true, res.error);
  assert.ok(!fs.existsSync(path.join(nvmDir, 'versions', 'node', 'v18.20.0')));
  for (const v of ['v20.11.1', 'v20.12.0', 'v22.1.0']) assert.ok(fs.existsSync(path.join(nvmDir, 'versions', 'node', v)));
  // A pinned version is refused even if a stale listing says otherwise.
  const forged = { ...by('v20.12.0'), blocked: null };
  const no = await devtools.removeItem(forged, opts);
  assert.equal(no.ok, false);
  assert.equal(no.code, 'blocked');
  assert.ok(fs.existsSync(path.join(nvmDir, 'versions', 'node', 'v20.12.0')));
});

test('toolchains: no process list means nothing is deletable (fail closed)', async () => {
  const nvmDir = tmp('nvm');
  write(path.join(nvmDir, 'versions', 'node', 'v16.0.0', 'bin', 'node'), 'x');
  const inv = await devtools.inventory({ only: ['toolchains'], platform: 'linux', home: tmp('h'), env: { NVM_DIR: nvmDir }, procs: { ok: false, list: [] } });
  const it = inv.groups.find((g) => g.id === 'nvm').items[0];
  assert.match(it.blocked, /could not check/);
});

test('uv lists system interpreters too, so Spaci reads only its managed folder', () => {
  const list = JSON.parse(fixture('uv-python-list.json'));
  const managed = toolchains.uvPythonDir({ platform: 'darwin', home: '/Users/user', env: {} });
  assert.equal(managed, '/Users/user/.local/share/uv/python');
  assert.ok(list.length > 0);
  assert.ok(list.every((e) => !e.path.startsWith(managed)), 'the captured list is all Homebrew interpreters');
  assert.equal(toolchains.uvPythonDir({ platform: 'win32', home: 'C:\\Users\\a', env: { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' } }), 'C:\\Users\\a\\AppData\\Roaming\\uv\\data\\python');
});

test('rustup: default and project-pinned toolchains are protected, the uninstall uses rustup', async () => {
  const rh = tmp('rustup');
  for (const t of ['stable-aarch64-apple-darwin', 'nightly-2024-01-01-aarch64-apple-darwin', '1.79.0-aarch64-apple-darwin', '1.70.0-aarch64-apple-darwin']) write(path.join(rh, 'toolchains', t, 'bin', 'rustc'), 'r');
  write(path.join(rh, 'settings.toml'), 'default_toolchain = "stable-aarch64-apple-darwin"\nprofile = "default"\n');
  const proj = tmp('proj');
  write(path.join(proj, 'rust-toolchain.toml'), '[toolchain]\nchannel = "1.79.0"\n');
  const inv = await devtools.inventory({ only: ['toolchains'], platform: 'darwin', home: tmp('h'), env: { RUSTUP_HOME: rh, NVM_DIR: '/nonexistent', PYENV_ROOT: '/nonexistent', VOLTA_HOME: '/nonexistent' }, projects: [proj], procs: quietProcs });
  const g = inv.groups.find((x) => x.id === 'rustup');
  const by = (n) => g.items.find((i) => i.name === n);
  assert.match(by('stable-aarch64-apple-darwin').blocked, /default/);
  assert.match(by('1.79.0-aarch64-apple-darwin').blocked, /Pinned/);
  assert.equal(by('1.70.0-aarch64-apple-darwin').blocked, null);
  assert.deepEqual(by('1.70.0-aarch64-apple-darwin').removal.args, ['toolchain', 'uninstall', '1.70.0-aarch64-apple-darwin']);
});

// ---- IDE leftovers ----------------------------------------------------------------

test('JetBrains: only versions older than the newest of the same product', () => {
  const listing = ['WebStorm2024.1', 'WebStorm2026.2', 'PyCharm2026.2', 'IntelliJIdea2025.3', 'IntelliJIdea2026.1', 'Toolbox', 'Daemon']
    .map((name) => ({ root: '/cfg', name }))
    .concat([{ root: '/caches', name: 'WebStorm2024.1' }]);
  const old = ide.jetbrainsLeftovers(listing);
  assert.deepEqual(old.map((o) => o.product + o.version).sort(), ['IntelliJIdea2025.3', 'WebStorm2024.1']);
  assert.equal(old.find((o) => o.product === 'WebStorm').dirs.length, 2);
});

test('VS Code: only folders VS Code marked obsolete or replaced, never one extensions.json lists', () => {
  const folders = fixture('vscode-extension-folders.txt').split(/\r?\n/).filter((f) => f && !f.endsWith('.json'));
  const json = JSON.parse(fixture('vscode-extensions.json'));
  const obsolete = JSON.parse(fixture('vscode-obsolete.json'));
  const stale = ide.staleExtensions(folders, json, obsolete);
  assert.deepEqual(stale.map((s) => s.folder).sort(), ['ms-python.python-2026.4.0-darwin-arm64', 'teabyii.ayu-1.1.12', 'vscode-icons-team.vscode-icons-12.19.0']);
  const active = new Set(json.map((e) => e.relativeLocation));
  assert.ok(stale.every((s) => !active.has(s.folder)));
  // A replaced version not yet in .obsolete is still found.
  const more = ide.staleExtensions([...folders, 'prisma.prisma-30.0.0'], json, {});
  assert.ok(more.some((s) => s.folder === 'prisma.prisma-30.0.0' && s.reason === 'replaced'));
  // An obsolete flag never outranks extensions.json.
  assert.deepEqual(ide.staleExtensions(['prisma.prisma-31.12.10'], json, { 'prisma.prisma-31.12.10': true }), []);
});

// ---- Hugging Face revisions ---------------------------------------------------------

test('HF cache: an old revision frees only blobs no other snapshot links, refs block it', { skip: !canSymlink }, async () => {
  const hub = tmp('hub');
  const repo = path.join(hub, 'models--org--tiny');
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  write(path.join(repo, 'blobs', 'b1'), 'c'.repeat(100));
  write(path.join(repo, 'blobs', 'b2'), 'w'.repeat(5000));
  write(path.join(repo, 'blobs', 'b3'), 'o'.repeat(7000));
  write(path.join(repo, 'refs', 'main'), A);
  const link = (rev, file, blob) => { fs.mkdirSync(path.join(repo, 'snapshots', rev), { recursive: true }); fs.symlinkSync(path.join('..', '..', 'blobs', blob), path.join(repo, 'snapshots', rev, file)); };
  link(A, 'config.json', 'b1'); link(A, 'model.bin', 'b2');
  link(B, 'config.json', 'b1'); link(B, 'model.bin', 'b3');
  const scanned = await hf.scanRepo(repo, 'models--org--tiny');
  assert.equal(scanned.repoId, 'org/tiny');
  const revB = scanned.revisions.find((r) => r.rev === B);
  assert.deepEqual(hf.revisionBlobsToDelete(scanned, revB), ['b3']);
  const [g] = await hf.inventory({ platform: 'linux', home: tmp('h'), env: { HF_HUB_CACHE: hub } });
  const item = g.items.find((i) => i.id === 'hf-rev:' + repo + ':' + B);
  assert.ok(item, 'the detached revision is offered');
  assert.ok(!g.items.some((i) => i.id === 'hf-rev:' + repo + ':' + A), 'the revision main points at is not');
  assert.equal(g.total, g.items.find((i) => i.id === 'hf:' + repo).size, 'revision items are not counted twice');
  const res = await hf.removeRevision(item);
  assert.equal(res.ok, true, res.error);
  assert.ok(!fs.existsSync(path.join(repo, 'snapshots', B)));
  assert.ok(!fs.existsSync(path.join(repo, 'blobs', 'b3')));
  assert.ok(fs.existsSync(path.join(repo, 'blobs', 'b1')) && fs.existsSync(path.join(repo, 'blobs', 'b2')));
  assert.ok(fs.readFileSync(path.join(repo, 'snapshots', A, 'config.json'), 'utf8').startsWith('c'));
  // A ref pointing at the revision makes it in use.
  link('c'.repeat(40), 'model.bin', 'b2');
  write(path.join(repo, 'refs', 'pr', '1'), 'c'.repeat(40));
  const no = await hf.removeRevision({ removal: { type: 'hf-revision', root: hub, repoDir: repo, rev: 'c'.repeat(40) } });
  assert.equal(no.code, 'in-use');
});

test('HF hub dir follows HF_HUB_CACHE, HUGGINGFACE_HUB_CACHE, HF_HOME, XDG_CACHE_HOME', () => {
  assert.equal(hf.hubDir({ platform: 'linux', home: '/h', env: {} }), '/h/.cache/huggingface/hub');
  assert.equal(hf.hubDir({ platform: 'linux', home: '/h', env: { XDG_CACHE_HOME: '/x' } }), '/x/huggingface/hub');
  assert.equal(hf.hubDir({ platform: 'linux', home: '/h', env: { HF_HOME: '/hf' } }), '/hf/hub');
  assert.equal(hf.hubDir({ platform: 'linux', home: '/h', env: { HUGGINGFACE_HUB_CACHE: '/old', HF_HOME: '/hf' } }), '/old');
  assert.equal(hf.hubDir({ platform: 'linux', home: '/h', env: { HF_HUB_CACHE: '/new', HUGGINGFACE_HUB_CACHE: '/old' } }), '/new');
  assert.deepEqual(hf.parseRepoFolder('datasets--HuggingFaceFW--fineweb'), { type: 'dataset', id: 'HuggingFaceFW/fineweb' });
});

// ---- folder stores and Docker Model Runner ------------------------------------------

test('Whisper cache: model files listed; a running app blocks LM Studio style stores', async () => {
  const home = tmp('h');
  write(path.join(home, '.cache', 'whisper', 'large-v3.pt'), Buffer.alloc(2 * 1024 * 1024, 1));
  write(path.join(home, '.cache', 'whisper', 'notes.txt'), 'x');
  const [g] = await aistores.whisper({ platform: 'linux', home, env: {}, procs: quietProcs });
  assert.deepEqual(g.items.map((i) => i.label), ['large-v3.pt']);
  assert.equal(g.items[0].tier, 'B');

  const lms = path.join(home, '.lmstudio', 'models', 'lmstudio-community', 'Qwen2.5-7B-GGUF');
  write(path.join(lms, 'Qwen2.5-7B-Instruct-Q4_K_M.gguf'), Buffer.alloc(1024 * 1024, 1));
  const running = { ok: true, list: [{ pid: 5, args: '/Applications/LM Studio.app/Contents/MacOS/LM Studio' }] };
  const noApi = async () => ({ ok: false, status: 0, json: null, error: 'ECONNREFUSED' });
  const [lg] = await aistores.lmStudio({ platform: 'linux', home, env: {}, procs: running, exec: execStub({}), httpJson: noApi });
  assert.equal(lg.items[0].quant, 'Q4_K_M');
  assert.match(lg.items[0].blocked, /could not see which models are loaded/);
  const loadedApi = async (m, url) => (url.includes('/api/v0/models') ? { ok: true, status: 200, json: { data: [{ id: 'lmstudio-community/Qwen2.5-7B-GGUF/Qwen2.5-7B-Instruct-Q4_K_M.gguf', state: 'loaded' }] } } : { ok: false });
  const [lg2] = await aistores.lmStudio({ platform: 'linux', home, env: {}, procs: running, exec: execStub({}), httpJson: loadedApi });
  assert.match(lg2.items[0].blocked, /Loaded in LM Studio/);
  const [lg3] = await aistores.lmStudio({ platform: 'linux', home, env: {}, procs: quietProcs, exec: execStub({}), httpJson: noApi });
  assert.equal(lg3.items[0].blocked, null);
  assert.equal(lg3.items[0].restoreHint, 'lms get lmstudio-community/Qwen2.5-7B-GGUF');
});

test('Docker Model Runner rows parse; not running means nothing to manage', async () => {
  const rows = aistores.parseDockerModels(JSON.stringify([{ id: 'sha256:abc', tags: ['ai/smollm2:360M-Q4_K_M'], created: 1, config: { format: 'gguf', quantization: 'Q4_K_M', parameters: '361.82 M', size: '256.35 MiB' } }]));
  assert.equal(rows[0].name, 'ai/smollm2:360M-Q4_K_M');
  assert.equal(rows[0].size, Math.round(256.35 * 1024 * 1024));
  const down = new Error('Docker Model Runner is not running. Please start it and try again.');
  down.code = 1;
  assert.deepEqual(await aistores.dockerModelRunner({ exec: execStub({ 'docker model ls --json': down }) }), []);
  assert.deepEqual(await aistores.dockerModelRunner({ exec: execStub({}) }), []);
});

// ---- helpers, processes, policy ------------------------------------------------------

test('process snapshots parse on POSIX and Windows', () => {
  const ps = processes.parsePs('  1079 /Applications/Ollama.app/Contents/Resources/ollama serve\n   12 /sbin/launchd\n');
  assert.equal(ps.length, 2);
  assert.equal(processes.runningState({ ok: true, list: ps }, require('../src/devtools/ollama').OLLAMA_PROC_RE), 'yes');
  assert.equal(processes.runningState({ ok: true, list: [ps[1]] }, /ollama/), 'no');
  assert.equal(processes.runningState({ ok: false, list: [] }, /ollama/), 'unknown');
  const win = processes.parseWin('SPACI_PROC:44|C:\\Program Files\\Ollama\\ollama.exe|"C:\\Program Files\\Ollama\\ollama.exe" serve\r\nnoise\r\n');
  assert.equal(win[0].pid, 44);
  assert.match(win[0].args, /ollama\.exe" serve/);
});

test('removePaths refuses anything outside the store, including through a symlinked folder', { skip: !canSymlink }, async () => {
  const root = tmp('store');
  const outside = tmp('outside');
  write(path.join(outside, 'precious.txt'), 'keep');
  fs.symlinkSync(outside, path.join(root, 'escape'));
  const del = () => { throw new Error('must not be called'); };
  const r1 = await devtools.removePaths({ root, paths: [path.join(outside, 'precious.txt')] }, del);
  assert.equal(r1.code, 'outside');
  const r2 = await devtools.removePaths({ root, paths: [path.join(root, 'escape', 'precious.txt')] }, del);
  assert.equal(r2.code, 'outside');
  const r3 = await devtools.removePaths({ root, paths: [root] }, del);
  assert.equal(r3.code, 'outside', 'never the store root itself');
  assert.ok(fs.existsSync(path.join(outside, 'precious.txt')));
});

test('policy: confirm first, then the allowlist, then blocked items', () => {
  const listing = { groups: [{ title: 'Ollama', items: [
    { id: 'ok', label: 'qwen2.5:0.5b', tier: 'B', restoreHint: 'ollama pull qwen2.5:0.5b', paths: ['/m/x'] },
    { id: 'busy', label: 'llama3.2:3b', blocked: 'Loaded in Ollama right now.' },
  ] }] };
  assert.equal(policy.removalDecision('ok', {}, listing).error, 'needs-confirmation');
  assert.equal(policy.removalDecision('ok', { confirmed: 'yes' }, listing).error, 'needs-confirmation');
  assert.equal(policy.removalDecision(42, { confirmed: true }, listing).error, 'invalid-id');
  assert.equal(policy.removalDecision('nope', { confirmed: true }, listing).error, 'unknown-item');
  assert.equal(policy.removalDecision('ok', { confirmed: true }, null).error, 'unknown-item');
  const b = policy.removalDecision('busy', { confirmed: true }, listing);
  assert.equal(b.error, 'blocked');
  assert.match(b.message, /Loaded/);
  const ok = policy.removalDecision('ok', { confirmed: true }, listing);
  assert.equal(ok.ok, true);
  const started = policy.startedEntry({ id: 'h1', at: 1, group: ok.group, item: ok.item });
  assert.equal(started.v, 2);
  assert.equal(started.status, 'started');
  assert.equal(started.scope, 'devtools');
  const done = policy.finishedEntry({ id: 'h1', at: 1, finishedAt: 2, group: ok.group, item: ok.item, result: { ok: true, freed: 1234 } });
  assert.equal(done.status, 'done');
  assert.equal(done.freed, 1234);
  assert.equal(done.items[0].restoreHint, 'ollama pull qwen2.5:0.5b');
  assert.equal(done.items[0].reversible, 'rebuild');
  assert.equal(done.label, 'Ollama: qwen2.5:0.5b');
  const failed = policy.finishedEntry({ id: 'h2', at: 1, finishedAt: 2, group: ok.group, item: { ...ok.item, tier: 'C' }, result: { ok: false, error: 'boom', code: 'failed' } });
  assert.equal(failed.items[0].outcome, 'failed');
  assert.equal(failed.items[0].reversible, 'none');
  assert.equal(failed.failedCount, 1);
});

test('helpers: version order, loopback-only HTTP, never-rejecting run', async () => {
  assert.equal(util.compareVersions('2026.2', '2026.10'), -1);
  assert.equal(util.compareVersions('v20.12.0', '20.11.9'), 1);
  assert.equal(util.isLoopbackHost('127.0.0.1'), true);
  assert.equal(util.isLoopbackHost('example.com'), false);
  const r = await util.httpJson('GET', 'http://example.com/api/tags');
  assert.equal(r.error, 'not-local');
  const missing = await util.run('spaci-no-such-command-xyz', []);
  assert.equal(missing.ok, false);
  assert.equal(missing.missing, true);
  const slow = await util.withTimeout(new Promise(() => {}), 20, 'late');
  assert.equal(slow, 'late');
});

test('inventory: a detector that throws becomes an error group, the rest still report', async () => {
  const home = tmp('h');
  write(path.join(home, '.cache', 'whisper', 'base.pt'), Buffer.alloc(2 * 1024 * 1024, 1));
  const original = devtools.DETECTORS.find((d) => d.id === 'jan').run;
  devtools.DETECTORS.find((d) => d.id === 'jan').run = async () => { throw new Error('boom'); };
  try {
    const inv = await devtools.inventory({ only: ['jan', 'whisper'], platform: 'linux', home, env: {}, procs: quietProcs });
    assert.ok(inv.groups.some((g) => g.id === 'whisper' && g.items.length === 1));
    const bad = inv.groups.find((g) => g.id === 'jan');
    assert.equal(bad.status, 'error');
    assert.deepEqual(inv.errors.map((e) => e.id), ['jan']);
  } finally {
    devtools.DETECTORS.find((d) => d.id === 'jan').run = original;
  }
});
