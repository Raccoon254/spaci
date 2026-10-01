'use strict';
/**
 * Android SDK system images, NDK versions and emulators (AVDs).
 *
 * SDK root: ANDROID_HOME, else ANDROID_SDK_ROOT (deprecated), else the
 * default per OS. AVDs: ANDROID_AVD_HOME, else $ANDROID_EMULATOR_HOME/avd,
 * else $ANDROID_USER_HOME/avd, else ~/.android/avd (developer.android.com/tools/variables).
 *
 * Everything is read from disk (a <name>.ini plus <name>.avd/config.ini per
 * AVD; system-images/<api>/<tag>/<abi>); the SDK tools only run to delete:
 *   avdmanager delete avd -n <name>
 *   sdkmanager --sdk_root=<root> --uninstall "<package path>"
 * Without the tools, Spaci removes the same folders itself.
 *
 * A running emulator (its qemu process names the AVD, or its .avd folder
 * holds a *.lock file) blocks deleting that AVD and the system image it uses.
 *
 * An older side-by-side NDK stays when a scanned project needs it: its
 * ndkVersion (build.gradle or build.gradle.kts, in the project or a module
 * settings.gradle includes), ndk.dir in local.properties, or the default NDK
 * of the Android Gradle Plugin version it builds with. Before a project scan
 * every NDK stays.
 */

// The NDK each Android Gradle Plugin version uses when a module sets no
// ndkVersion (developer.android.com/studio/projects/configure-agp-ndk).
const AGP_DEFAULT_NDK = {
  '4.1': '21.1.6352462', '4.2': '21.4.7075529', '7.0': '21.4.7075529', '7.1': '21.4.7075529', '7.2': '21.4.7075529',
  '7.3': '23.1.7779620', '7.4': '23.1.7779620', '8.0': '25.1.8937393', '8.1': '25.1.8937393', '8.2': '25.1.8937393',
  '8.3': '26.1.10909125', '8.4': '26.1.10909125', '8.5': '26.1.10909125', '8.6': '26.1.10909125', '8.7': '27.0.12077973',
  '8.8': '27.0.12077973', '8.9': '27.0.12077973', '8.10': '27.0.12077973', '8.11': '27.0.12077973',
};

/** One project's NDK needs from its Gradle files: { versions, paths, agp, native }. */
function ndkNeedsFromFiles(files) {
  const out = { versions: [], paths: [], agp: null, native: false };
  for (const [name, text] of Object.entries(files)) {
    if (typeof text !== 'string') continue;
    for (const m of text.matchAll(/\bndkVersion\s*(?:=\s*)?\(?\s*["']([\d.]+)["']/g)) out.versions.push({ version: m[1], source: name.replace(/\\/g, '/') });
    if (/\bexternalNativeBuild\b|\bcmake\s*\{|\bndkBuild\s*\{/.test(text)) out.native = true;
    const agp = /com\.android\.tools\.build:gradle:(\d+\.\d+)/.exec(text)
      || /id\s*\(?\s*["']com\.android\.(?:application|library)["']\s*\)?\s*version\s*\(?\s*["'](\d+\.\d+)/.exec(text)
      || (/\.toml$/.test(name) && /^\s*(?:agp|androidGradlePlugin|android-gradle-plugin|androidGradle|android-gradle)\s*=\s*["'](\d+\.\d+)/m.exec(text));
    if (agp && !out.agp) out.agp = agp[1];
    if (/local\.properties$/.test(name)) { const d = /^\s*ndk\.dir\s*=\s*(.+?)\s*$/m.exec(text); if (d) out.paths.push({ path: d[1].replace(/\\:/g, ':').replace(/\\\\/g, '\\'), source: 'local.properties' }); }
  }
  return out;
}

/** Modules settings.gradle(.kts) includes: include ':app', ':core:net' -> app, core/net. */
function gradleModules(settings) {
  const out = [];
  for (const m of String(settings || '').matchAll(/include\s*\(?([^\n)]*)/g)) {
    for (const q of m[1].matchAll(/["']:?([A-Za-z0-9_.:-]+)["']/g)) out.push(q[1].split(':').join(path.sep));
  }
  return Array.from(new Set(out)).slice(0, 40);
}

/** NDK needs across scanned projects. -> { versions: [{ version, project, source }], paths, unknownDefault: [project] } */
async function ndkPins(projects) {
  const out = { versions: [], paths: [], unknownDefault: [] };
  await pool((Array.isArray(projects) ? projects : []).slice(0, 600), 8, async (proj) => {
    const read = (f) => readText(path.join(proj, f), 512 * 1024);
    const settings = (await read('settings.gradle')) || (await read('settings.gradle.kts'));
    const files = {};
    for (const f of ['build.gradle', 'build.gradle.kts', 'local.properties', path.join('gradle', 'libs.versions.toml'), ...['app', ...gradleModules(settings)].flatMap((d) => [path.join(d, 'build.gradle'), path.join(d, 'build.gradle.kts')])]) {
      const t = await read(f);
      if (t != null) files[f] = t;
    }
    if (settings) files['settings.gradle'] = settings; // the plugins block may name AGP
    if (!Object.keys(files).length) return;
    const need = ndkNeedsFromFiles(files);
    for (const v of need.versions) out.versions.push({ ...v, project: proj });
    for (const pth of need.paths) out.paths.push({ ...pth, project: proj });
    if (need.agp) {
      const def = AGP_DEFAULT_NDK[need.agp];
      if (def) out.versions.push({ version: def, project: proj, source: 'default NDK of Android Gradle Plugin ' + need.agp });
      else if (need.native) out.unknownDefault.push(proj);
    } else if (need.native && !need.versions.length) out.unknownDefault.push(proj);
  });
  return out;
}

const path = require('path');
const { run, listDir, lstatSafe, readText, dirSize, pool, absEnv } = require('./util');
const { matching } = require('./processes');
const { projectsScanned, NO_SCAN } = require('./toolchains');
const { makeGroup, makeItem } = require('./model');

function api(ctx) { return ctx.platform === 'win32' ? path.win32 : path.posix; }

function sdkRoot(ctx) {
  const p = api(ctx);
  const { env = {} } = ctx;
  const fromEnv = absEnv(env, 'ANDROID_HOME') || absEnv(env, 'ANDROID_SDK_ROOT');
  if (fromEnv) return fromEnv;
  if (ctx.platform === 'darwin') return p.join(ctx.home, 'Library', 'Android', 'sdk');
  if (ctx.platform === 'win32') return env.LOCALAPPDATA ? p.join(env.LOCALAPPDATA, 'Android', 'Sdk') : null;
  return p.join(ctx.home, 'Android', 'Sdk');
}

function avdHome(ctx) {
  const p = api(ctx);
  const { env = {} } = ctx;
  const direct = absEnv(env, 'ANDROID_AVD_HOME');
  if (direct) return direct;
  const emu = absEnv(env, 'ANDROID_EMULATOR_HOME');
  if (emu) return p.join(emu, 'avd');
  const user = absEnv(env, 'ANDROID_USER_HOME') || p.join(ctx.platform === 'win32' ? (env.USERPROFILE || ctx.home) : ctx.home, '.android');
  return p.join(user, 'avd');
}

/** key=value lines (config.ini, source.properties, <name>.ini). */
function parseIni(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*([^#=\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** "system-images/android-34/google_apis/arm64-v8a/" -> "system-images;android-34;google_apis;arm64-v8a" */
function imagePackage(sysdir) {
  const parts = String(sysdir || '').replace(/\\/g, '/').split('/').filter(Boolean);
  const i = parts.indexOf('system-images');
  if (i < 0 || parts.length < i + 4) return null;
  return parts.slice(i, i + 4).join(';');
}

/** `avdmanager list avd` -> [{ name, path, target, abi }] (used by tests and as a cross-check). */
function parseAvdList(stdout) {
  const out = [];
  let cur = null;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = /^\s*(Name|Path|Target|Based on|Tag\/ABI|Device|Sdcard|Error):\s*(.*)$/.exec(line);
    if (!m) { if (/^-{5,}/.test(line.trim()) && cur) { out.push(cur); cur = null; } continue; }
    if (m[1] === 'Name') { if (cur) out.push(cur); cur = { name: m[2].trim() }; continue; }
    if (!cur) continue;
    if (m[1] === 'Path') cur.path = m[2].trim();
    else if (m[1] === 'Target' || m[1] === 'Based on') {
      // "Based on: Android 14.0 (...) Tag/ABI: google_apis/arm64-v8a" is one line.
      const abi = /\s*Tag\/ABI:\s*(\S+)\s*$/.exec(m[2]);
      const text = abi ? m[2].slice(0, abi.index) : m[2];
      if (abi) cur.abi = abi[1];
      cur.target = (cur.target ? cur.target + ' ' : '') + text.trim();
    }
    else if (m[1] === 'Tag/ABI') cur.abi = m[2].trim();
    else if (m[1] === 'Error') cur.error = m[2].trim();
  }
  if (cur) out.push(cur);
  return out;
}

/** `sdkmanager --list_installed` -> [{ path, version, description, location }] */
function parseSdkInstalled(stdout) {
  const out = [];
  let inTable = false;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (/^\s*Installed packages:/i.test(line)) { inTable = true; continue; }
    if (!inTable) continue;
    if (/^\s*Available (Packages|Updates):/i.test(line)) break;
    const cols = line.split('|').map((c) => c.trim());
    if (cols.length < 4 || cols[0] === 'Path' || /^-+$/.test(cols[0])) continue;
    out.push({ path: cols[0], version: cols[1], description: cols[2], location: cols[3] });
  }
  return out;
}

async function readAvds(ctx) {
  const p = api(ctx);
  const home = avdHome(ctx);
  const avds = [];
  for (const e of await listDir(home)) {
    if (!e.isFile() || !e.name.endsWith('.ini')) continue;
    const name = e.name.slice(0, -4);
    const ini = parseIni(await readText(p.join(home, e.name), 64 * 1024));
    const dir = ini.path && /^([A-Za-z]:[\\/]|[\\/])/.test(ini.path) ? ini.path : p.join(home, name + '.avd');
    const st = await lstatSafe(dir);
    if (!st || !st.isDirectory()) continue;
    const cfg = parseIni(await readText(p.join(dir, 'config.ini'), 256 * 1024));
    const locks = (await listDir(dir)).filter((f) => f.name.endsWith('.lock')).map((f) => f.name);
    avds.push({
      name,
      displayName: cfg['avd.ini.displayname'] || name.replace(/_/g, ' '),
      ini: p.join(home, e.name),
      dir,
      image: imagePackage(cfg['image.sysdir.1']),
      locks,
    });
  }
  return { home, avds };
}

function emulatorRunning(ctx, avd) {
  if (avd.locks.length) return 'yes';
  if (!ctx.procs || !ctx.procs.ok) return 'unknown';
  const esc = avd.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('(qemu-system|emulator)[^ ]*\\s.*-avd\\s+' + esc + '(\\s|$)|@' + esc + '(\\s|$)');
  return matching(ctx.procs, re).length ? 'yes' : 'no';
}

async function inventory(ctx) {
  const p = api(ctx);
  const root = sdkRoot(ctx);
  const { home, avds } = await readAvds(ctx);
  const items = [];
  const runningImages = new Set();
  const avdsByImage = new Map();
  await pool(avds, 3, async (a) => {
    const state = emulatorRunning(ctx, a);
    if (state !== 'no' && a.image) runningImages.add(a.image);
    if (a.image) avdsByImage.set(a.image, [...(avdsByImage.get(a.image) || []), a.displayName]);
    const size = (await dirSize(a.dir)).bytes;
    items.push(makeItem({
      id: 'avd:' + a.name,
      group: 'android',
      kind: 'userdata',
      label: a.displayName,
      name: a.name,
      detail: ['Emulator', a.image ? a.image.split(';').slice(1).join(' ') : null].filter(Boolean).join(' · '),
      size,
      state: state === 'yes' ? 'running' : 'idle',
      blocked: state === 'yes' ? 'This emulator is running. Close it first.' : state === 'unknown' ? 'Spaci could not check whether this emulator is running.' : null,
      badges: state === 'yes' ? [{ text: 'Running', kind: 'running' }] : [],
      tierReason: 'Holds the apps, files and snapshots on this emulator, which nothing can rebuild.',
      restoreHint: a.image ? 'avdmanager create avd -n ' + a.name + ' -k "' + a.image + '" (a new, empty emulator)' : null,
      paths: [a.dir, a.ini],
      removal: { type: 'command', cmd: 'avdmanager', args: ['delete', 'avd', '-n', a.name], expectGone: [a.dir], fallback: { type: 'paths', root: home, paths: [a.dir, a.ini] } },
    }));
  });

  if (root) {
    const imgRoot = p.join(root, 'system-images');
    for (const apiDir of await listDir(imgRoot)) {
      if (!apiDir.isDirectory()) continue;
      for (const tag of await listDir(p.join(imgRoot, apiDir.name))) {
        if (!tag.isDirectory()) continue;
        for (const abi of await listDir(p.join(imgRoot, apiDir.name, tag.name))) {
          if (!abi.isDirectory()) continue;
          const dir = p.join(imgRoot, apiDir.name, tag.name, abi.name);
          const pkg = ['system-images', apiDir.name, tag.name, abi.name].join(';');
          const size = (await dirSize(dir)).bytes;
          const users = avdsByImage.get(pkg) || [];
          const busy = runningImages.has(pkg);
          items.push(makeItem({
            id: 'sysimage:' + pkg,
            group: 'android',
            kind: 'runtime',
            label: 'System image ' + apiDir.name.replace('android-', 'API ') + ' ' + tag.name,
            name: pkg,
            detail: [abi.name, users.length ? 'Used by ' + users.slice(0, 2).join(', ') + (users.length > 2 ? ' and ' + (users.length - 2) + ' more' : '') : 'No emulator uses it'].join(' · '),
            size,
            state: busy ? 'running' : 'idle',
            blocked: busy ? 'An emulator using this image is running. Close it first.' : users.length ? 'Emulators use this image (' + users.join(', ') + '). Delete them first, or keep it.' : null,
            badges: users.length ? [{ text: 'Used by ' + users.length + (users.length === 1 ? ' emulator' : ' emulators'), kind: 'info' }] : [],
            restoreHint: 'sdkmanager "' + pkg + '"',
            paths: [dir],
            removal: { type: 'command', cmd: 'sdkmanager', args: ['--sdk_root=' + root, '--uninstall', pkg], timeout: 120000, expectGone: [dir], fallback: { type: 'paths', root: imgRoot, paths: [dir] } },
          }));
        }
      }
    }
    // Side-by-side NDKs: several versions pile up. The newest is never offered.
    const ndkRoot = p.join(root, 'ndk');
    const ndks = (await listDir(ndkRoot)).filter((e) => e.isDirectory() && /^\d+\.\d+\.\d+/.test(e.name)).map((e) => e.name);
    if (ndks.length > 1) {
      const { compareVersions } = require('./util');
      ndks.sort((a, b) => compareVersions(b, a));
      const needs = await ndkPins(ctx.projects);
      for (const v of ndks.slice(1)) {
        const dir = p.join(ndkRoot, v);
        const norm = (x) => String(x).replace(/\\/g, '/').replace(/\/+$/, '');
        const pin = needs.versions.find((x) => x.version === v)
          || needs.paths.find((x) => norm(x.path) === norm(dir) || norm(x.path).startsWith(norm(dir) + '/') || norm(x.path).split('/').pop() === v);
        let blocked = null;
        if (pin) blocked = 'Pinned by ' + path.basename(pin.project) + ' (' + pin.source + ')';
        else if (needs.unknownDefault.length) blocked = path.basename(needs.unknownDefault[0]) + ' builds native code with an NDK Spaci cannot determine, so every NDK stays.';
        else if (!projectsScanned(ctx)) blocked = NO_SCAN;
        items.push(makeItem({
          id: 'ndk:' + v,
          group: 'android',
          kind: 'toolchain',
          label: 'NDK ' + v,
          name: 'ndk;' + v,
          detail: 'Older side-by-side NDK (newest is ' + ndks[0] + ')',
          size: (await dirSize(dir)).bytes,
          blocked,
          pinned: Boolean(pin),
          tier: pin ? 'C' : 'B',
          badges: pin ? [{ text: 'Pinned', kind: 'pinned' }] : [],
          restoreHint: 'sdkmanager "ndk;' + v + '"',
          paths: [dir],
          removal: { type: 'command', cmd: 'sdkmanager', args: ['--sdk_root=' + root, '--uninstall', 'ndk;' + v], timeout: 120000, expectGone: [dir], fallback: { type: 'paths', root: ndkRoot, paths: [dir] } },
        }));
      }
    }
  }
  if (!items.length) return [];
  return [makeGroup({
    id: 'android', section: 'dev', category: 'emulators', title: 'Android emulators and SDK', brand: 'android', icon: 'mobile',
    roots: [root, home].filter(Boolean),
    items: items.sort((a, b) => b.size - a.size),
    note: 'Removed with avdmanager and sdkmanager when they are installed.',
  })];
}

module.exports = { AGP_DEFAULT_NDK, ndkNeedsFromFiles, gradleModules, ndkPins, sdkRoot, avdHome, parseIni, imagePackage, parseAvdList, parseSdkInstalled, readAvds, inventory };
