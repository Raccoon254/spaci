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

// ---- toolchain defaults resolve like the tools do, and fail closed -------------------

test('r2: nvm default lts/* -> lts/jod -> v22.11.0 protects v22.11.0', async () => {
  const nvmDir = tmp('nvm');
  for (const v of ['v20.10.0', 'v22.11.0']) write(path.join(nvmDir, 'versions', 'node', v, 'bin', 'node'), 'x');
  write(path.join(nvmDir, 'alias', 'default'), 'lts/*\n');
  write(path.join(nvmDir, 'alias', 'lts', '*'), 'lts/jod\n');
  write(path.join(nvmDir, 'alias', 'lts', 'jod'), 'v22.11.0\n');
  const inv = await devtools.inventory({ only: ['toolchains'], platform: 'linux', home: tmp('h'), env: { NVM_DIR: nvmDir }, projects: [], projectsScanned: true, procs: quietProcs });
  const g = inv.groups.find((x) => x.id === 'nvm');
  const by = (v) => g.items.find((i) => i.version === v);
  assert.match(by('v22.11.0').blocked, /nvm default/);
  assert.equal(by('v20.10.0').blocked, null);
});

test('nvm default: alias chains, node and stable, system, and unresolvable defaults', async () => {
  const p = path.posix;
  const nvmDir = tmp('nvm');
  const versions = ['v18.20.0', 'v20.10.0', 'v22.11.0'];
  const set = (name, body) => write(path.join(nvmDir, 'alias', ...name.split('/')), body + '\n');
  set('default', 'work'); set('work', 'lts/iron'); set('lts/iron', 'v20.10.0');
  assert.deepEqual(await toolchains.nvmDefault(nvmDir, versions, p), { version: 'v20.10.0' });
  set('default', 'node');
  assert.deepEqual(await toolchains.nvmDefault(nvmDir, versions, p), { version: 'v22.11.0' });
  set('default', 'stable');
  assert.deepEqual(await toolchains.nvmDefault(nvmDir, versions, p), { version: 'v22.11.0' });
  set('default', '18');
  assert.deepEqual(await toolchains.nvmDefault(nvmDir, versions, p), { version: 'v18.20.0' });
  set('default', 'system');
  assert.deepEqual(await toolchains.nvmDefault(nvmDir, versions, p), { none: true });
  // Unresolvable: an lts codename nvm never wrote, a loop, a version not installed.
  set('default', 'lts/krypton');
  assert.match((await toolchains.nvmDefault(nvmDir, versions, p)).error, /could not work out/);
  set('default', 'a'); set('a', 'b'); set('b', 'a');
  assert.ok((await toolchains.nvmDefault(nvmDir, versions, p)).error);
  set('default', '16');
  assert.ok((await toolchains.nvmDefault(nvmDir, versions, p)).error);
  // In the listing an unresolvable default blocks every version.
  for (const v of versions) write(path.join(nvmDir, 'versions', 'node', v, 'bin', 'node'), 'x');
  set('default', 'lts/*');
  const inv = await devtools.inventory({ only: ['toolchains'], platform: 'linux', home: tmp('h'), env: { NVM_DIR: nvmDir }, projectsScanned: true, procs: quietProcs });
  const g = inv.groups.find((x) => x.id === 'nvm');
  assert.equal(g.items.length, 3);
  for (const it of g.items) assert.match(it.blocked, /could not work out which version nvm uses/);
  // No default at all is not a reason to block.
  fs.rmSync(path.join(nvmDir, 'alias'), { recursive: true });
  assert.deepEqual(await toolchains.nvmDefault(nvmDir, versions, p), { none: true });
});

test('fnm, Volta and rustup defaults that do not resolve block every version', { skip: !canSymlink }, async () => {
  const home = tmp('h');
  // fnm: default points at a version that is not installed.
  const fnmDir = tmp('fnm');
  write(path.join(fnmDir, 'node-versions', 'v20.10.0', 'installation', 'bin', 'node'), 'x');
  fs.mkdirSync(path.join(fnmDir, 'aliases'), { recursive: true });
  fs.symlinkSync(path.join(fnmDir, 'node-versions', 'v21.0.0', 'installation'), path.join(fnmDir, 'aliases', 'default'));
  // Volta: default runtime not installed.
  const volta = tmp('volta');
  write(path.join(volta, 'tools', 'image', 'node', '18.20.4', 'bin', 'node'), 'x');
  write(path.join(volta, 'tools', 'user', 'platform.json'), JSON.stringify({ node: { runtime: '22.1.0', npm: null } }));
  // rustup: default names a linked toolchain that is not a folder here.
  const rh = tmp('rustup');
  write(path.join(rh, 'toolchains', '1.75.0-aarch64-apple-darwin', 'bin', 'rustc'), 'r');
  write(path.join(rh, 'settings.toml'), 'default_toolchain = "my-linked"\n');
  const inv = await devtools.inventory({ only: ['toolchains'], platform: 'darwin', home, env: { FNM_DIR: fnmDir, VOLTA_HOME: volta, RUSTUP_HOME: rh, NVM_DIR: '/nonexistent', PYENV_ROOT: '/nonexistent' }, projectsScanned: true, procs: quietProcs });
  for (const id of ['fnm', 'volta', 'rustup']) {
    const g = inv.groups.find((x) => x.id === id);
    assert.ok(g, id);
    for (const it of g.items) assert.match(it.blocked, /could not work out/, id);
  }
  // Fixed defaults: only the default is protected.
  fs.unlinkSync(path.join(fnmDir, 'aliases', 'default'));
  fs.symlinkSync(path.join(fnmDir, 'node-versions', 'v20.10.0', 'installation'), path.join(fnmDir, 'aliases', 'default'));
  write(path.join(volta, 'tools', 'user', 'platform.json'), JSON.stringify({ node: { runtime: '18.20.4' } }));
  write(path.join(rh, 'settings.toml'), 'default_toolchain = "1.75.0-aarch64-apple-darwin"\n');
  const inv2 = await devtools.inventory({ only: ['toolchains'], platform: 'darwin', home, env: { FNM_DIR: fnmDir, VOLTA_HOME: volta, RUSTUP_HOME: rh, NVM_DIR: '/nonexistent', PYENV_ROOT: '/nonexistent' }, projectsScanned: true, procs: quietProcs });
  for (const id of ['fnm', 'volta', 'rustup']) for (const it of inv2.groups.find((x) => x.id === id).items) assert.match(it.blocked, /default/, id);
});

// ---- pyenv virtualenvs and venv pins ---------------------------------------------------

test('r2: a pin naming a pyenv virtualenv protects its base, and a base with virtualenvs is kept', { skip: !canSymlink }, async () => {
  const home = tmp('h');
  const root = path.join(home, '.pyenv');
  write(path.join(root, 'versions', '3.11.4', 'envs', 'myenv', 'lib', 'site.py'), 'x');
  write(path.join(root, 'versions', '3.12.1', 'bin', 'python'), 'x');
  write(path.join(root, 'versions', '3.9.18', 'bin', 'python'), 'x');
  fs.symlinkSync(path.join(root, 'versions', '3.11.4', 'envs', 'myenv'), path.join(root, 'versions', 'myenv'));
  write(path.join(root, 'version'), '3.12.1\n');
  const proj = tmp('proj');
  write(path.join(proj, '.python-version'), 'myenv\n');
  const inv = await devtools.inventory({ only: ['toolchains'], platform: 'darwin', home, env: { NVM_DIR: '/nonexistent' }, projects: [proj], projectsScanned: true, procs: quietProcs });
  const g = inv.groups.find((x) => x.id === 'pyenv');
  const by = (v) => g.items.find((i) => i.version === v);
  assert.match(by('3.11.4').blocked, /Pinned by .*\.python-version/);
  assert.match(by('3.12.1').blocked, /global/);
  assert.equal(by('3.9.18').blocked, null);
  assert.ok(!by('myenv'), 'the virtualenv link itself is not an item');
  // Without the pin, the virtualenv alone still keeps its base.
  const inv2 = await devtools.inventory({ only: ['toolchains'], platform: 'darwin', home, env: { NVM_DIR: '/nonexistent' }, projects: [], projectsScanned: true, procs: quietProcs });
  assert.match(inv2.groups.find((x) => x.id === 'pyenv').items.find((i) => i.version === '3.11.4').blocked, /virtualenvs \(myenv\)/);
  // A global naming the virtualenv resolves to the base too.
  assert.equal(toolchains.pyenvBase('myenv', await toolchains.pyenvVirtualenvs(path.join(root, 'versions'), path.posix)), '3.11.4');
  assert.equal(toolchains.pyenvBase('3.11.4/envs/other', { base: new Map() }), '3.11.4');
});

test('pyenv: a global that names nothing installed keeps every version', async () => {
  const home = tmp('h');
  const root = path.join(home, '.pyenv');
  write(path.join(root, 'versions', '3.12.1', 'bin', 'python'), 'x');
  write(path.join(root, 'version'), 'gone-env\n');
  const inv = await devtools.inventory({ only: ['toolchains'], platform: 'linux', home, env: { NVM_DIR: '/nonexistent' }, projectsScanned: true, procs: quietProcs });
  assert.match(inv.groups.find((x) => x.id === 'pyenv').items[0].blocked, /could not work out which version pyenv/);
});

test('a project .venv (pyvenv.cfg home=) and tool virtualenvs pin the interpreter they point at', async () => {
  const home = tmp('h');
  const pyenvRoot = path.join(home, '.pyenv');
  for (const v of ['3.10.13', '3.11.9', '3.12.4']) write(path.join(pyenvRoot, 'versions', v, 'bin', 'python'), 'x');
  const uvRoot = path.join(home, '.local', 'share', 'uv', 'python');
  for (const k of ['cpython-3.12.4-linux-x86_64-gnu', 'cpython-3.13.0-linux-x86_64-gnu', 'cpython-3.11.9-linux-x86_64-gnu']) write(path.join(uvRoot, k, 'bin', 'python3'), 'x');
  const proj = tmp('proj');
  write(path.join(proj, '.venv', 'pyvenv.cfg'), 'home = ' + path.join(pyenvRoot, 'versions', '3.10.13', 'bin') + '\nversion = 3.10.13\n');
  const proj2 = tmp('proj2');
  write(path.join(proj2, '.venv', 'pyvenv.cfg'), 'home = ' + path.join(uvRoot, 'cpython-3.13.0-linux-x86_64-gnu', 'bin') + '\nimplementation = CPython\nuv = 0.4.0\n');
  // A Poetry virtualenv in its cache and a uv tool, outside any project.
  write(path.join(home, '.cache', 'pypoetry', 'virtualenvs', 'app-AbCdEf12-py3.11', 'pyvenv.cfg'), 'home = ' + path.join(pyenvRoot, 'versions', '3.11.9', 'bin') + '\n');
  write(path.join(home, '.local', 'share', 'uv', 'tools', 'ruff', 'pyvenv.cfg'), 'home = ' + path.join(uvRoot, 'cpython-3.11.9-linux-x86_64-gnu', 'bin') + '\n');
  const inv = await devtools.inventory({ only: ['toolchains'], platform: 'linux', home, env: { NVM_DIR: '/nonexistent' }, projects: [proj, proj2], projectsScanned: true, procs: quietProcs });
  const py = inv.groups.find((x) => x.id === 'pyenv');
  const uv = inv.groups.find((x) => x.id === 'uv-python');
  const pv = (v) => py.items.find((i) => i.version === v);
  const uk = (k) => uv.items.find((i) => i.version === k);
  assert.match(pv('3.10.13').blocked, /Pinned by .*\.venv\/pyvenv\.cfg/);
  assert.match(pv('3.11.9').blocked, /Poetry virtualenv/);
  assert.equal(pv('3.12.4').blocked, null);
  assert.match(uk('cpython-3.13.0-linux-x86_64-gnu').blocked, /\.venv\/pyvenv\.cfg/);
  assert.match(uk('cpython-3.11.9-linux-x86_64-gnu').blocked, /uv tool virtualenv/);
  assert.equal(uk('cpython-3.12.4-linux-x86_64-gnu').blocked, null);
});

// ---- pin files and the project scan ------------------------------------------------------

test('r2: rust-toolchain in TOML form, mise.toml and .mise.toml pin their versions', async () => {
  const home = tmp('h');
  const nvmDir = path.join(home, '.nvm');
  for (const v of ['v20.10.0', 'v22.11.0']) write(path.join(nvmDir, 'versions', 'node', v, 'bin', 'node'), 'x');
  write(path.join(nvmDir, 'alias', 'default'), 'v22.11.0\n');
  const rh = path.join(home, '.rustup');
  for (const t of ['1.75.0-aarch64-apple-darwin', 'stable-aarch64-apple-darwin', '1.70.0-aarch64-apple-darwin']) write(path.join(rh, 'toolchains', t, 'bin', 'rustc'), 'x');
  write(path.join(rh, 'settings.toml'), 'default_toolchain = "stable-aarch64-apple-darwin"\n');
  const proj2 = tmp('proj2');
  write(path.join(proj2, 'rust-toolchain'), '[toolchain]\nchannel = "1.75.0"\n');
  const proj3 = tmp('proj3');
  write(path.join(proj3, 'mise.toml'), '[env]\nNODE_ENV = "dev"\n[tools]\nnode = "20.10.0"\n');
  const inv = await devtools.inventory({ only: ['toolchains'], platform: 'darwin', home, env: {}, projects: [proj2, proj3], projectsScanned: true, procs: quietProcs });
  const nvm = inv.groups.find((x) => x.id === 'nvm');
  const rust = inv.groups.find((x) => x.id === 'rustup');
  assert.match(nvm.items.find((i) => i.version === 'v20.10.0').blocked, /Pinned by .*mise\.toml/);
  assert.match(rust.items.find((i) => i.name === '1.75.0-aarch64-apple-darwin').blocked, /Pinned by .*rust-toolchain/);
  assert.equal(rust.items.find((i) => i.name === '1.70.0-aarch64-apple-darwin').blocked, null);
  // The one-line legacy form still works.
  assert.deepEqual(toolchains.pinsFromFiles({ 'rust-toolchain': 'nightly-2024-01-01\n' }).rust.map((p) => p.spec), ['nightly-2024-01-01']);
});

test('pin files: mise forms, every .tool-versions fallback, pyproject ranges', () => {
  const pins = toolchains.pinsFromFiles({
    '.mise.toml': '[tools]\nnode = ["22", "20.10.0"]\npython = { version = "3.11" }\n"core:rust" = "1.79.0"  # comment\n[settings]\nnode = "99"\n',
    '.tool-versions': 'nodejs 20.11.1 18.19.0\npython 3.12.4 system\n',
    'pyproject.toml': '[project]\nname = "x"\nrequires-python = ">=3.10,<3.12"\n[tool.poetry.dependencies]\npython = "^3.9"\nrequests = "*"\n',
  });
  assert.deepEqual(pins.node.map((p) => p.spec).sort(), ['18.19.0', '20.10.0', '20.11.1', '22']);
  assert.deepEqual(pins.python.filter((p) => p.spec).map((p) => p.spec).sort(), ['3.11', '3.12.4']);
  assert.deepEqual(pins.rust.map((p) => p.spec), ['1.79.0']);
  assert.deepEqual(pins.python.filter((p) => p.range).map((p) => p.range), ['>=3.10,<3.12', '^3.9']);
  const sat = toolchains.satisfiesPython;
  assert.equal(sat('3.11.9', '>=3.10,<3.12'), true);
  assert.equal(sat('3.12.0', '>=3.10,<3.12'), false);
  assert.equal(sat('3.13.1', '^3.9'), true);
  assert.equal(sat('4.0.0', '^3.9'), false);
  assert.equal(sat('3.10.4', '~=3.10.2'), true);
  assert.equal(sat('3.11.0', '~=3.10.2'), false);
  assert.equal(sat('3.10.4', '==3.10.*'), true);
  assert.equal(sat('3.9.1', '~3.9'), true);
  assert.equal(sat('3.10.0', '~3.9'), false);
  assert.equal(sat('3.12.1', '>=3.8 || <2'), true);
  assert.equal(sat('3.12.1', 'banana'), null);
});

test('requires-python protects an installed version only when it is the only one that satisfies it', async () => {
  const home = tmp('h');
  const root = path.join(home, '.pyenv');
  for (const v of ['3.9.18', '3.11.9', '3.12.4']) write(path.join(root, 'versions', v, 'bin', 'python'), 'x');
  const proj = tmp('proj');
  write(path.join(proj, 'pyproject.toml'), '[project]\nrequires-python = ">=3.10,<3.12"\n');
  const opts = { only: ['toolchains'], platform: 'linux', home, env: { NVM_DIR: '/nonexistent' }, projects: [proj], projectsScanned: true, procs: quietProcs };
  let g = (await devtools.inventory(opts)).groups.find((x) => x.id === 'pyenv');
  assert.match(g.items.find((i) => i.version === '3.11.9').blocked, /only installed version that satisfies >=3\.10,<3\.12/);
  assert.equal(g.items.find((i) => i.version === '3.9.18').blocked, null);
  assert.equal(g.items.find((i) => i.version === '3.12.4').blocked, null);
  // Two versions satisfy it: either may go, the other still does.
  write(path.join(root, 'versions', '3.10.14', 'bin', 'python'), 'x');
  g = (await devtools.inventory(opts)).groups.find((x) => x.id === 'pyenv');
  assert.equal(g.items.find((i) => i.version === '3.11.9').blocked, null);
  assert.equal(g.items.find((i) => i.version === '3.10.14').blocked, null);
});

test('no project scan yet: every toolchain version stays, with the reason', async () => {
  const nvmDir = tmp('nvm');
  write(path.join(nvmDir, 'versions', 'node', 'v16.0.0', 'bin', 'node'), 'x');
  const base = { only: ['toolchains'], platform: 'linux', home: tmp('h'), env: { NVM_DIR: nvmDir }, procs: quietProcs };
  for (const extra of [{}, { projects: [], projectsScanned: false }, { projects: ['/somewhere'], projectsScanned: false }]) {
    const it = (await devtools.inventory({ ...base, ...extra })).groups.find((g) => g.id === 'nvm').items[0];
    assert.equal(it.blocked, toolchains.NO_SCAN);
    const res = await devtools.removeItem({ ...it, blocked: null }, { ...base, ...extra });
    assert.equal(res.code, 'blocked');
    assert.ok(fs.existsSync(path.join(nvmDir, 'versions', 'node', 'v16.0.0')));
  }
  // A finished scan that found no projects is a real answer: nothing pins it.
  const it = (await devtools.inventory({ ...base, projects: [], projectsScanned: true })).groups.find((g) => g.id === 'nvm').items[0];
  assert.equal(it.blocked, null);
});

// ---- JetBrains: installed, age, running, user data ---------------------------------------

/** Set every mtime under dir (and dir) to `ms`. */
function ageTree(dir, ms) {
  const t = new Date(ms);
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); fs.utimesSync(f, t, t); }
    fs.utimesSync(d, t, t);
  };
  walk(dir);
}

/** A macOS home with IntelliJ 2024.1 leftovers (old) and 2026.1 (current). */
function jbHome({ oldDays = 400 } = {}) {
  const home = tmp('jb');
  const lib = (...x) => path.join(home, 'Library', ...x);
  const old = 'IntelliJIdea2024.1';
  write(lib('Application Support', 'JetBrains', old, 'scratches', 'notes.sql'), 'my work');
  write(lib('Application Support', 'JetBrains', old, 'consoles', 'db', 'q.sql'), 'select 1');
  write(lib('Application Support', 'JetBrains', old, 'options', 'editor.xml'), '<x/>');
  write(lib('Application Support', 'JetBrains', old, 'plugins', 'p', 'lib', 'p.jar'), 'j'.repeat(4096));
  write(lib('Caches', 'JetBrains', old, 'index', 'x'), 'c'.repeat(8192));
  write(lib('Logs', 'JetBrains', old, 'idea.log'), 'log');
  write(lib('Application Support', 'JetBrains', 'IntelliJIdea2026.1', 'options', 'x.xml'), 'new');
  for (const r of ['Application Support', 'Caches', 'Logs']) { const d = lib(r, 'JetBrains', old); if (fs.existsSync(d)) ageTree(d, Date.now() - oldDays * 86400000); }
  return { home, lib, old, apps: tmp('apps') };
}

test('JetBrains: an old, uninstalled, unused version offers caches, logs and plugins only, never settings or scratches', async () => {
  const j = jbHome();
  const ctx = { platform: 'darwin', home: j.home, env: {}, jetbrainsAppDirs: [j.apps], procs: quietProcs };
  const [g] = await ide.jetbrains(ctx);
  assert.equal(g.items.length, 1);
  const it = g.items[0];
  assert.equal(it.blocked, null);
  assert.deepEqual(it.paths.sort(), [j.lib('Application Support', 'JetBrains', j.old, 'plugins'), j.lib('Caches', 'JetBrains', j.old), j.lib('Logs', 'JetBrains', j.old)].sort());
  for (const pth of it.paths) assert.ok(!/scratches|consoles|options/.test(pth));
  const del = async (pth) => { fs.rmSync(pth, { recursive: true, force: true }); return 1; };
  const res = await devtools.removePaths(it.removal, del);
  assert.equal(res.ok, true, res.error);
  assert.equal(fs.readFileSync(j.lib('Application Support', 'JetBrains', j.old, 'scratches', 'notes.sql'), 'utf8'), 'my work');
  assert.ok(fs.existsSync(j.lib('Application Support', 'JetBrains', j.old, 'consoles', 'db', 'q.sql')));
  assert.ok(fs.existsSync(j.lib('Application Support', 'JetBrains', j.old, 'options', 'editor.xml')));
  assert.ok(!fs.existsSync(j.lib('Caches', 'JetBrains', j.old)));
});

test('JetBrains: a version that is still installed is not offered (Toolbox, product-info.json, Info.plist)', async () => {
  // Toolbox's state.json.
  let j = jbHome();
  write(j.lib('Application Support', 'JetBrains', 'Toolbox', 'state.json'), JSON.stringify({ tools: [{ toolId: 'IDEA-U', productCode: 'IU', buildNumber: '241.14494.240', installLocation: path.join(j.apps, 'nothing-here.app') }] }));
  assert.deepEqual(await ide.jetbrains({ platform: 'darwin', home: j.home, env: {}, jetbrainsAppDirs: [j.apps], procs: quietProcs }), []);
  // An installed app's product-info.json.
  j = jbHome();
  write(path.join(j.apps, 'IntelliJ IDEA 2024.1.app', 'Contents', 'Resources', 'product-info.json'), JSON.stringify({ productCode: 'IU', buildNumber: '241.14494.240', dataDirectoryName: 'IntelliJIdea2024.1' }));
  assert.deepEqual(await ide.jetbrains({ platform: 'darwin', home: j.home, env: {}, jetbrainsAppDirs: [j.apps], procs: quietProcs }), []);
  // Only Info.plist (CFBundleVersion IU-241...).
  j = jbHome();
  write(path.join(j.apps, 'IDEA.app', 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleVersion</key>\n<string>IU-241.14494.240</string></dict></plist>');
  assert.deepEqual(await ide.jetbrains({ platform: 'darwin', home: j.home, env: {}, jetbrainsAppDirs: [j.apps], procs: quietProcs }), []);
  // A Toolbox list Spaci cannot read keeps everything.
  j = jbHome();
  write(j.lib('Application Support', 'JetBrains', 'Toolbox', 'state.json'), '{ not json');
  const [g] = await ide.jetbrains({ platform: 'darwin', home: j.home, env: {}, jetbrainsAppDirs: [j.apps], procs: quietProcs });
  assert.match(g.items[0].blocked, /Toolbox/);
  assert.equal(ide.jbDirFromBuild('PC', '233.1'), 'PyCharmCE2023.3');
  assert.equal(ide.jbDirFromBuild(null, 'WS-252.2.3'), 'WebStorm2025.2');
});

test('JetBrains: Windows registry install paths count as installed', async () => {
  const appData = tmp('appdata');
  const local = tmp('local');
  const old = 'PyCharm2024.1';
  write(path.join(local, 'JetBrains', old, 'caches', 'x'), 'c');
  write(path.join(local, 'JetBrains', 'PyCharm2026.1', 'caches', 'x'), 'c');
  ageTree(path.join(local, 'JetBrains', old), Date.now() - 400 * 86400000);
  const inst = tmp('inst');
  write(path.join(inst, 'product-info.json'), JSON.stringify({ productCode: 'PY', buildNumber: '241.1', dataDirectoryName: old }));
  const regOut = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\JetBrains\\PyCharm\\241.1\r\n    (Default)    REG_SZ    ' + inst + '\r\n';
  const exec = execStub({ 'reg query HKLM\\SOFTWARE\\JetBrains /s': regOut });
  const ctx = { platform: 'win32', home: tmp('h'), env: { APPDATA: appData, LOCALAPPDATA: local }, jetbrainsAppDirs: [], exec, procs: quietProcs };
  // The registry parser, on any OS: every install path under Software\\JetBrains.
  const paths = await ide.registryInstalls({ platform: 'win32', exec: execStub({ 'reg query HKLM\\SOFTWARE\\JetBrains /s': '    (Default)    REG_SZ    C:\\Program Files\\JetBrains\\PyCharm 2024.1\r\n    Exe    REG_SZ    C:\\Tools\\pc\\bin\\pycharm64.exe\r\n' }) });
  assert.deepEqual(paths, ['C:\\Program Files\\JetBrains\\PyCharm 2024.1', 'C:\\Tools\\pc']);
  if (process.platform === 'win32') {
    assert.deepEqual(await ide.jetbrains(ctx), [], 'installed per the registry: not offered');
    const [g] = await ide.jetbrains({ ...ctx, exec: execStub({}) });
    assert.equal(g.items[0].blocked, null, 'without the registry entry it is offered');
  }
});

test('JetBrains: a version used in the last 180 days is kept', async () => {
  const j = jbHome({ oldDays: 30 });
  const [g] = await ide.jetbrains({ platform: 'darwin', home: j.home, env: {}, jetbrainsAppDirs: [j.apps], procs: quietProcs });
  assert.match(g.items[0].blocked, /Used 30 days ago.*180 days/);
});

test('r3: a running IDE is matched by idea.paths.selector or its bundle, never by version text', async () => {
  const j = jbHome();
  const run = (args) => ide.jetbrains({ platform: 'darwin', home: j.home, env: {}, jetbrainsAppDirs: [j.apps], procs: { ok: true, list: [{ pid: 5, args }] } });
  // The critic's case: a generic bundle path with no version in it.
  let [g] = await run('/Users/u/Applications/IntelliJ IDEA Ultimate.app/Contents/MacOS/idea');
  assert.match(g.items[0].blocked, /IntelliJ IDEA is running and Spaci could not tell which version/);
  [g] = await run('/opt/jbr/bin/java -Didea.paths.selector=IntelliJIdea2024.1 -cp x');
  assert.match(g.items[0].blocked, /IntelliJ IDEA 2024\.1 is running/);
  // The running bundle is the 2026.1 install: 2024.1 is not in use.
  write(path.join(j.apps, 'IntelliJ IDEA.app', 'Contents', 'Resources', 'product-info.json'), JSON.stringify({ dataDirectoryName: 'IntelliJIdea2026.1' }));
  [g] = await run(path.join(j.apps, 'IntelliJ IDEA.app', 'Contents', 'MacOS', 'idea'));
  assert.equal(g.items[0].blocked, null);
  // Version text alone (a file name) means nothing.
  [g] = await run('/usr/bin/vim notes-IntelliJ-IDEA-2024.1.txt');
  assert.equal(g.items[0].blocked, null);
  [g] = await ide.jetbrains({ platform: 'darwin', home: j.home, env: {}, jetbrainsAppDirs: [j.apps], procs: { ok: false, list: [] } });
  assert.match(g.items[0].blocked, /could not check/);
});

test('r3 as written: the 2025.3 scratches are never offered', async () => {
  const home = tmp('r3');
  write(path.join(home, 'Library/Application Support/JetBrains/IntelliJIdea2025.3/scratches/notes.sql'), 'my work');
  write(path.join(home, 'Library/Application Support/JetBrains/IntelliJIdea2026.1/options/x.xml'), 'eap tried once');
  const groups = await ide.jetbrains({ platform: 'darwin', home, env: {}, jetbrainsAppDirs: [], procs: { ok: true, list: [{ pid: 5, args: '/Users/u/Applications/IntelliJ IDEA Ultimate.app/Contents/MacOS/idea' }] } });
  const paths = groups.flatMap((g) => g.items.flatMap((i) => i.paths));
  assert.ok(!paths.some((p) => /scratches|IntelliJIdea2025\.3$/.test(p)), JSON.stringify(paths));
});

// ---- VS Code-family profiles -----------------------------------------------------------------

test('r3: a newer extension version is never "replaced" by an older one in use', async () => {
  const home = tmp('vs');
  const ext = path.join(home, '.vscode', 'extensions');
  write(path.join(ext, 'ms-python.python-2024.1.0', 'package.json'), '{}');
  write(path.join(ext, 'ms-python.python-2024.8.0', 'package.json'), '{}');
  write(path.join(ext, 'extensions.json'), JSON.stringify([{ identifier: { id: 'ms-python.python' }, relativeLocation: 'ms-python.python-2024.1.0' }]));
  const ctx = { platform: 'darwin', home, env: {}, procs: quietProcs };
  assert.deepEqual(await ide.editorExtensions(ctx), []);
});

test('VS Code profiles: a version any profile uses stays; only versions older than all of them go', async () => {
  for (const [platform, dataDir] of [['darwin', (h) => path.join(h, 'Library', 'Application Support', 'Code')], ['linux', (h) => path.join(h, '.config', 'Code')]]) {
    const home = tmp('vs');
    const ext = path.join(home, '.vscode', 'extensions');
    for (const v of ['2023.9.0', '2024.1.0', '2024.8.0']) write(path.join(ext, 'ms-python.python-' + v, 'package.json'), '{}');
    write(path.join(ext, 'extensions.json'), JSON.stringify([{ identifier: { id: 'ms-python.python' }, relativeLocation: 'ms-python.python-2024.8.0' }]));
    // The "Work" profile still uses 2024.1.0, named by location only.
    write(path.join(dataDir(home), 'User', 'profiles', '-6f1a2b', 'extensions.json'), JSON.stringify([{ identifier: { id: 'ms-python.python' }, location: { $mid: 1, path: path.join(ext, 'ms-python.python-2024.1.0').replace(/\\/g, '/'), scheme: 'file' } }]));
    const groups = await ide.editorExtensions({ platform, home, env: {}, procs: quietProcs });
    assert.deepEqual(groups.flatMap((g) => g.items.map((i) => i.label)), ['ms-python.python-2023.9.0'], platform);
    // A profile manifest Spaci cannot read: nothing is offered.
    write(path.join(dataDir(home), 'User', 'profiles', 'broken', 'extensions.json'), '[{');
    assert.deepEqual(await ide.editorExtensions({ platform, home, env: {}, procs: quietProcs }), [], platform);
  }
  // .obsolete still wins only for folders no profile names.
  const json = [{ identifier: { id: 'a.b' }, relativeLocation: 'a.b-1.0.0' }];
  assert.deepEqual(ide.staleExtensions(['a.b-1.0.0', 'a.b-0.9.0'], [json, [{ identifier: { id: 'a.b' }, relativeLocation: 'a.b-0.9.0' }]], { 'a.b-0.9.0': true, 'a.b-1.0.0': true }), []);
});

// ---- simulator runtimes and NDK pins -------------------------------------------------------

test('simulators: a runtime that shut-down simulators use is kept, saying how many would stop booting', async () => {
  const rt = 'com.apple.CoreSimulator.SimRuntime.iOS-17-5';
  const devicesJson = JSON.stringify({ devices: { [rt]: [
    { udid: 'AAAAAAAA-2222-3333-4444-555555555555', name: 'iPhone 15', state: 'Shutdown', isAvailable: true, dataPath: '/x/a/data' },
    { udid: 'BBBBBBBB-2222-3333-4444-555555555555', name: 'iPad Air', state: 'Shutdown', isAvailable: true, dataPath: '/x/b/data' },
  ] } });
  const runtimes = JSON.stringify({
    'R1': { identifier: 'R1', runtimeIdentifier: rt, version: '17.5', build: '21F79', sizeBytes: 7e9, deletable: true, platformIdentifier: 'com.apple.platform.iphonesimulator' },
    'R2': { identifier: 'R2', runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-16-4', version: '16.4', build: '20E247', sizeBytes: 6e9, deletable: true, platformIdentifier: 'com.apple.platform.iphonesimulator' },
  });
  const exec = execStub({ 'xcrun simctl list -j devices': devicesJson, 'xcrun simctl runtime list -j': runtimes });
  const [g] = await simulators.inventory({ platform: 'darwin', home: tmp('home'), env: {}, exec, procs: quietProcs });
  const by = (label) => g.items.find((i) => i.label === label);
  assert.match(by('iOS 17.5 runtime').blocked, /^2 simulators use this runtime \(iPhone 15, iPad Air\) and would stop booting/);
  assert.equal(by('iOS 16.4 runtime').blocked, null);
});

test('Android NDK: ndkVersion, ndk.dir and the AGP default NDK pin an older NDK; no scan keeps them all', async () => {
  const sdk = tmp('sdk');
  for (const v of ['23.1.7779620', '25.1.8937393', '25.2.9519653', '26.3.11579264', '27.1.12297006']) write(path.join(sdk, 'ndk', v, 'source.properties'), 'x');
  const p1 = tmp('app1');
  write(path.join(p1, 'settings.gradle.kts'), 'include(":app", ":native")\n');
  write(path.join(p1, 'native', 'build.gradle.kts'), 'android {\n  ndkVersion = "25.2.9519653"\n  externalNativeBuild { cmake { path = file("CMakeLists.txt") } }\n}\n');
  write(path.join(p1, 'build.gradle.kts'), 'plugins {\n  id("com.android.application") version "8.2.2" apply false\n}\n');
  const p2 = tmp('app2');
  write(path.join(p2, 'local.properties'), 'sdk.dir=/x\nndk.dir=' + path.join(sdk, 'ndk', '23.1.7779620').replace(/\\/g, '\\\\').replace(/:/g, '\\:') + '\n');
  const opts = { platform: 'linux', home: tmp('h'), env: { ANDROID_HOME: sdk, ANDROID_AVD_HOME: tmp('avd') }, procs: quietProcs };
  const [g] = await android.inventory({ ...opts, projects: [p1, p2], projectsScanned: true });
  const by = (v) => g.items.find((i) => i.id === 'ndk:' + v);
  assert.match(by('25.2.9519653').blocked, /Pinned by .* \(native\/build\.gradle\.kts\)/);
  assert.match(by('25.1.8937393').blocked, /default NDK of Android Gradle Plugin 8\.2/);
  assert.match(by('23.1.7779620').blocked, /local\.properties/);
  assert.equal(by('26.3.11579264').blocked, null);
  // Before any project scan, no NDK can be deleted.
  const [g2] = await android.inventory({ ...opts, projects: [], projectsScanned: false });
  assert.equal(g2.items.find((i) => i.id === 'ndk:26.3.11579264').blocked, toolchains.NO_SCAN);
  // Native code with an AGP Spaci has no default for keeps every NDK.
  const p3 = tmp('app3');
  write(path.join(p3, 'app', 'build.gradle'), 'plugins { id "com.android.application" version "99.1.0" }\nandroid { externalNativeBuild { cmake { path "CMakeLists.txt" } } }\n');
  const [g3] = await android.inventory({ ...opts, projects: [p3], projectsScanned: true });
  assert.match(g3.items.find((i) => i.id === 'ndk:26.3.11579264').blocked, /cannot determine/);
  assert.deepEqual(android.gradleModules("include ':app', ':core:net'\n"), ['app', path.join('core', 'net')]);
});

// ---- command removals: measured, and partial results said as such ------------------------

/** simctl that really "deletes" a runtime, or pretends to (keep: true). */
function simctlExec({ keep = false } = {}) {
  let gone = false;
  const rt = (id, ver, size) => ({ identifier: id, runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-' + ver.replace('.', '-'), version: ver, build: 'B', sizeBytes: size, deletable: true, platformIdentifier: 'com.apple.platform.iphonesimulator' });
  const calls = [];
  const exec = (cmd, args, opts, cb) => {
    const key = [path.basename(cmd), ...args].join(' ');
    calls.push(key);
    setImmediate(() => {
      if (key === 'xcrun simctl list -j devices') return cb(null, JSON.stringify({ devices: {} }), '');
      if (key === 'xcrun simctl runtime list -j') return cb(null, JSON.stringify(gone ? { R1: rt('R1', '17.5', 7e9) } : { R1: rt('R1', '17.5', 7e9), R2: rt('R2', '16.4', 6e9) }), '');
      if (key === 'xcrun simctl runtime delete R2') { if (!keep) gone = true; return cb(null, '', ''); }
      const e = new Error('ENOENT'); e.code = 'ENOENT'; cb(e, '', '');
    });
  };
  return { exec, calls };
}

test('a command removal without expectGone records the measured drop, not the listed size', async () => {
  const home = tmp('home');
  const opts = { platform: 'darwin', home, env: {}, procs: quietProcs };
  const ok = simctlExec();
  const inv = await devtools.inventory({ ...opts, exec: ok.exec, only: ['simulators'] });
  const item = inv.groups[0].items.find((i) => i.label === 'iOS 16.4 runtime');
  const res = await devtools.removeItem(item, { ...opts, exec: ok.exec });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.freed, 6e9);
  assert.ok(ok.calls.includes('xcrun simctl runtime delete R2'));
  // simctl says it worked but the runtime is still listed: partial, nothing freed.
  const stuck = simctlExec({ keep: true });
  const inv2 = await devtools.inventory({ ...opts, exec: stuck.exec, only: ['simulators'] });
  const item2 = inv2.groups[0].items.find((i) => i.label === 'iOS 16.4 runtime');
  const res2 = await devtools.removeItem(item2, { ...opts, exec: stuck.exec });
  assert.equal(res2.ok, false);
  assert.equal(res2.code, 'partial');
  assert.equal(res2.freed, 0);
  assert.match(res2.error, /still listed/);
});

test('the result line says "partly deleted" for a partial removal, never "nothing else was touched"', () => {
  const { spaciDevtoolsFailText } = require('../src/renderer/devtools-ui.js');
  const fmt = (n) => n + ' B';
  const partial = spaciDevtoolsFailText('llama3:latest', { ok: false, error: 'partial', message: 'Some files could not be removed: EPERM', freed: 512 }, fmt);
  assert.match(partial, /^Partly deleted llama3:latest, freed 512 B\. Some files could not be removed: EPERM\. Check again/);
  assert.ok(!/Nothing else was touched/.test(partial));
  assert.match(spaciDevtoolsFailText('x', { ok: false, error: 'blocked', message: 'Loaded in Ollama right now.' }, fmt), /^Loaded in Ollama right now\. Nothing else was touched\.$/);
});
