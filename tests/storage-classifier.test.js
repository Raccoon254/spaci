'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildStoryCategories, buildSystemTargets } = require('../src/storage-classifier');
const { parseDuBytes: parseDiskDuBytes } = require('../src/diskbreakdown');
const { parseDuBytes: parseSystemDuBytes } = require('../src/system');
const { detectTypes } = require('../src/scanner');

test('du parsers keep usable stdout even when the command reports an error', () => {
  assert.equal(parseDiskDuBytes('6176172\t/Users/user/Library/Caches\n'), 6176172 * 1024);
  assert.equal(parseSystemDuBytes('1888864 /Users/user/Library/Logs\n'), 1888864 * 1024);
  assert.equal(parseDiskDuBytes(''), 0);
  assert.equal(parseSystemDuBytes('du: permission denied'), 0);
});

test('macOS cache story subtracts known child cache buckets', () => {
  const home = '/Users/example';
  const cats = buildStoryCategories({ platform: 'darwin', home, env: {} });
  const caches = cats.find((c) => c.key === 'caches');

  assert.ok(caches);
  assert.ok(caches.dirs.includes('/Users/example/Library/Caches'));
  assert.ok(caches.dirs.includes('/Users/example/Library/Logs'));
  assert.ok(caches.subtractDirs.includes('/Users/example/Library/Caches/CocoaPods'));
  assert.ok(caches.subtractDirs.includes('/Users/example/Library/Caches/pip'));
});

test('Windows target construction uses supplied env and stable categories', () => {
  const env = {
    USERPROFILE: 'C:\\Users\\Demo',
    LOCALAPPDATA: 'C:\\Users\\Demo\\AppData\\Local',
    APPDATA: 'C:\\Users\\Demo\\AppData\\Roaming',
    TEMP: 'C:\\Users\\Demo\\AppData\\Local\\Temp',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  };
  const targets = buildSystemTargets({ platform: 'win32', home: env.USERPROFILE, env });
  const ids = new Set(targets.map((t) => t.id));
  const cats = buildStoryCategories({ platform: 'win32', home: env.USERPROFILE, env });
  const appdata = cats.find((c) => c.key === 'appdata');
  const applications = cats.find((c) => c.key === 'applications');

  assert.ok(ids.has('npm'));
  assert.ok(ids.has('nuget'));
  assert.ok(ids.has('local-temp'));
  assert.ok(ids.has('browser-chrome'));
  assert.ok(targets.every((t) => t.paths.length > 0));
  assert.ok(targets.some((t) => t.paths.some((p) => p === 'C:\\Users\\Demo\\AppData\\Local\\npm-cache')));
  assert.ok(targets.every((t) => t.paths.every((p) => !p.includes('/'))));
  assert.ok(appdata.dirs.includes('C:\\Users\\Demo\\AppData\\Local\\Packages'));
  assert.ok(applications.dirs.includes('C:\\Program Files'));
  assert.ok(applications.dirs.includes('C:\\Program Files (x86)'));
});

test('Linux target construction includes app data, cache, browser and developer stories', () => {
  const home = '/home/demo';
  const targets = buildSystemTargets({ platform: 'linux', home, env: {} });
  const stories = new Set(targets.map((t) => t.storyCategory));
  const cats = buildStoryCategories({ platform: 'linux', home, env: {} });
  const catIds = new Set(cats.map((c) => c.key));

  assert.ok(stories.has('developer'));
  assert.ok(stories.has('browsers'));
  assert.ok(stories.has('caches'));
  assert.ok(catIds.has('appdata'));
  assert.ok(catIds.has('applications'));
  assert.ok(catIds.has('downloads'));
  assert.ok(cats.find((c) => c.key === 'applications').dirs.includes('/opt'));
  assert.ok(cats.find((c) => c.key === 'appdata').dirs.includes('/home/demo/.local/share'));
});

test('mixed project scoring prefers specific app markers while preserving secondary types', () => {
  const android = detectTypes(['package.json', 'settings.gradle', 'gradlew']);
  assert.equal(android[0].id, 'android');
  assert.ok(android.some((t) => t.id === 'node'));

  const flutter = detectTypes(['package.json', 'pubspec.yaml']);
  assert.equal(flutter[0].id, 'flutter');
  assert.ok(flutter.some((t) => t.id === 'node'));
});

test('developer targets cover the caches found on real machines, on every platform', () => {
  const posixHome = '/Users/example';
  const winEnv = {
    USERPROFILE: 'C:\\Users\\Demo',
    LOCALAPPDATA: 'C:\\Users\\Demo\\AppData\\Local',
    APPDATA: 'C:\\Users\\Demo\\AppData\\Roaming',
    TEMP: 'C:\\Users\\Demo\\AppData\\Local\\Temp',
  };
  const cases = [
    ['darwin', buildSystemTargets({ platform: 'darwin', home: posixHome, env: {} })],
    ['linux', buildSystemTargets({ platform: 'linux', home: '/home/example', env: {} })],
    ['win32', buildSystemTargets({ platform: 'win32', home: winEnv.USERPROFILE, env: winEnv })],
  ];
  for (const [platform, targets] of cases) {
    const ids = new Set(targets.map((t) => t.id));
    for (const id of ['nuget', 'gradle-wrapper', 'dart-server', 'huggingface', 'go']) {
      assert.ok(ids.has(id), `${platform} is missing target ${id}`);
    }
  }
});

test('Windows developer paths use backslashes and never leak posix separators', () => {
  const env = { USERPROFILE: 'C:\\Users\\Demo', LOCALAPPDATA: 'C:\\Users\\Demo\\AppData\\Local', TEMP: 'C:\\Temp' };
  const targets = buildSystemTargets({ platform: 'win32', home: env.USERPROFILE, env });
  for (const t of targets) {
    for (const p of t.paths) assert.ok(!p.includes('/'), `${t.id} has a posix separator in ${p}`);
  }
  const byId = Object.fromEntries(targets.map((t) => [t.id, t]));
  assert.ok(byId['dart-server'].paths.includes('C:\\Users\\Demo\\AppData\\Local\\.dartServer'));
  assert.ok(byId.pnpm.paths.includes('C:\\Users\\Demo\\AppData\\Local\\pnpm\\store'));
});

test('Go module cache honours GOMODCACHE, then the first GOPATH entry, then ~/go', () => {
  const find = (env, platform = 'darwin', home = '/Users/example') =>
    buildSystemTargets({ platform, home, env }).find((t) => t.id === 'go').paths;
  assert.ok(find({ GOMODCACHE: '/opt/gomod' }).includes('/opt/gomod'));
  assert.ok(find({ GOPATH: '/work/go:/other/go' }).includes('/work/go/pkg/mod'));
  assert.ok(find({}).includes('/Users/example/go/pkg/mod'));
  const win = find({ GOPATH: 'D:\\go;E:\\go', LOCALAPPDATA: 'C:\\L' }, 'win32', 'C:\\Users\\Demo');
  assert.ok(win.includes('D:\\go\\pkg\\mod'));
});

test('Hugging Face models are opt-in and protected from the generic cache wipe', () => {
  for (const platform of ['darwin', 'linux']) {
    const home = platform === 'darwin' ? '/Users/example' : '/home/example';
    const targets = buildSystemTargets({ platform, home, env: {} });
    const hf = targets.find((t) => t.id === 'huggingface');
    assert.equal(hf.safe, false, `${platform} huggingface must not be preselected`);
    const generic = targets.find((t) => t.paths.includes(`${home}/.cache`));
    assert.ok(generic, `${platform} has a generic ~/.cache target`);
    assert.equal(generic.safe, false, `${platform} generic ~/.cache must be opt-in`);
    for (const name of ['huggingface', 'lm-studio', 'whisper', 'ollama']) {
      assert.ok(generic.protect.includes(name), `${platform} generic ~/.cache must protect ${name}`);
    }
  }
  assert.ok(buildSystemTargets({ platform: 'darwin', home: '/u', env: { HF_HOME: '/data/hf' } })
    .find((t) => t.id === 'huggingface').paths.includes('/data/hf'));
});

test('macOS ~/.cache is counted as caches, not left in the unexplained System remainder', () => {
  const cats = buildStoryCategories({ platform: 'darwin', home: '/Users/example', env: {} });
  const caches = cats.find((c) => c.key === 'caches');
  assert.ok(caches.dirs.includes('/Users/example/.cache'));
  assert.ok(caches.subtractDirs.includes('/Users/example/.cache/huggingface'));
});

test('targets without protect do not carry an empty protect field', () => {
  const targets = buildSystemTargets({ platform: 'darwin', home: '/Users/example', env: {} });
  for (const t of targets) {
    if ('protect' in t) assert.ok(Array.isArray(t.protect) && t.protect.length > 0, t.id);
  }
});

test('Linux cache targets follow XDG_CACHE_HOME, and ignore a relative value', () => {
  const find = (env) => buildSystemTargets({ platform: 'linux', home: '/home/x', env });
  const moved = find({ XDG_CACHE_HOME: '/fast/cache' });
  assert.ok(moved.find((t) => t.id === 'pip').paths.includes('/fast/cache/pip'));
  assert.ok(moved.find((t) => t.id === 'user-cache').paths.includes('/fast/cache'));
  const relative = find({ XDG_CACHE_HOME: 'relative/cache' });
  assert.ok(relative.find((t) => t.id === 'pip').paths.includes('/home/x/.cache/pip'));
  const cats = buildStoryCategories({ platform: 'linux', home: '/home/x', env: { XDG_CACHE_HOME: '/fast/cache' } });
  assert.ok(cats.find((c) => c.key === 'caches').dirs.includes('/fast/cache'));
});

test('Windows %TEMP% is not counted twice when it is the local Temp folder', () => {
  const base = { USERPROFILE: 'C:\\Users\\D', LOCALAPPDATA: 'C:\\Users\\D\\AppData\\Local' };
  const same = buildSystemTargets({ platform: 'win32', home: base.USERPROFILE, env: { ...base, TEMP: 'c:\\users\\d\\appdata\\local\\temp' } });
  assert.ok(!same.some((t) => t.id === 'windows-temp'));
  const elsewhere = buildSystemTargets({ platform: 'win32', home: base.USERPROFILE, env: { ...base, TEMP: 'D:\\Temp' } });
  assert.ok(elsewhere.some((t) => t.id === 'windows-temp'));
});

test('the Trash is never preselected and is marked irreversible on macOS and Linux', () => {
  for (const platform of ['darwin', 'linux']) {
    const trash = buildSystemTargets({ platform, home: '/home/demo', env: {} }).find((t) => t.id === 'trash');
    assert.ok(trash, platform);
    assert.equal(trash.safe, false, platform);
    assert.equal(trash.reversible, false, platform);
    assert.match(trash.description, /permanently/);
  }
});

test('Xcode archives are irreversible and unsafe', () => {
  const t = buildSystemTargets({ platform: 'darwin', home: '/Users/demo', env: {} }).find((x) => x.id === 'xcode-archives');
  assert.equal(t.safe, false);
  assert.equal(t.reversible, false);
});

test('no target description claims nothing is lost for logs or saved state', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const env = platform === 'win32' ? { LOCALAPPDATA: 'C:\\Users\\D\\AppData\\Local', USERPROFILE: 'C:\\Users\\D' } : {};
    for (const t of buildSystemTargets({ platform, home: platform === 'win32' ? 'C:\\Users\\D' : '/home/d', env })) {
      assert.doesNotMatch(t.description, /nothing is lost|just open fresh|one click/i, t.id);
      assert.doesNotMatch(t.description, /\u2014/, t.id);
    }
  }
  const mac = buildSystemTargets({ platform: 'darwin', home: '/Users/d', env: {} });
  assert.match(mac.find((t) => t.id === 'user-logs').description, /cannot be recovered/);
  assert.match(mac.find((t) => t.id === 'saved-state').restoreHint, /not restored/);
  for (const id of ['user-logs', 'saved-state']) assert.equal(mac.find((t) => t.id === id).reversible, false, id + ' cannot be restored');
});
