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
 */

const path = require('path');
const { run, listDir, lstatSafe, readText, dirSize, pool, absEnv } = require('./util');
const { matching } = require('./processes');
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
      for (const v of ndks.slice(1)) {
        const dir = p.join(ndkRoot, v);
        items.push(makeItem({
          id: 'ndk:' + v,
          group: 'android',
          kind: 'toolchain',
          label: 'NDK ' + v,
          name: 'ndk;' + v,
          detail: 'Older side-by-side NDK (newest is ' + ndks[0] + ')',
          size: (await dirSize(dir)).bytes,
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

module.exports = { sdkRoot, avdHome, parseIni, imagePackage, parseAvdList, parseSdkInstalled, readAvds, inventory };
