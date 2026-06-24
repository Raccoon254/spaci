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
