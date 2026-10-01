'use strict';
/**
 * Xcode simulators (macOS only): devices, runtimes and DeviceSupport folders.
 *
 *   xcrun simctl list -j devices      devices per runtime, with state
 *   xcrun simctl runtime list -j      installed runtime images with sizeBytes
 *   xcrun simctl delete <udid>        Apple's delete for one device
 *   xcrun simctl runtime delete <id>  Apple's delete for one runtime
 *
 * A booted device, and a runtime any simulator uses (booted or not: without
 * its runtime a simulator can never boot again), is never deleted.
 * DeviceSupport folders (symbols Xcode copies from a connected device) have
 * no command; Xcode copies them again when a device on that version connects.
 */

const path = require('path');
const { run, listDir, lstatSafe, dirSize, pool } = require('./util');
const { makeGroup, makeItem } = require('./model');

/** `simctl list -j devices` -> [{ udid, name, state, available, runtime, dataPath, dataPathSize, availabilityError }] */
function parseDevices(stdout) {
  let json;
  try { json = JSON.parse(stdout); } catch { return null; }
  if (!json || typeof json.devices !== 'object') return null;
  const out = [];
  for (const [runtime, list] of Object.entries(json.devices)) {
    for (const d of Array.isArray(list) ? list : []) {
      if (!d || typeof d.udid !== 'string' || !/^[0-9A-F-]{36}$/i.test(d.udid)) continue;
      out.push({
        udid: d.udid,
        name: String(d.name || 'Simulator'),
        state: String(d.state || ''),
        available: d.isAvailable !== false,
        runtime,
        runtimeName: runtimeLabel(runtime),
        dataPath: typeof d.dataPath === 'string' ? d.dataPath : null,
        dataPathSize: Number(d.dataPathSize) || 0,
        availabilityError: d.availabilityError || null,
        lastBootedAt: d.lastBootedAt ? Date.parse(d.lastBootedAt) || null : null,
      });
    }
  }
  return out;
}

/** 'com.apple.CoreSimulator.SimRuntime.iOS-17-5' -> 'iOS 17.5' */
function runtimeLabel(id) {
  const m = /SimRuntime\.([A-Za-z]+)-(\d+(?:-\d+)*)$/.exec(String(id || ''));
  if (!m) return String(id || '');
  return m[1].replace(/^xrOS$/, 'visionOS') + ' ' + m[2].split('-').join('.');
}

/** `simctl runtime list -j` -> [{ identifier, runtimeIdentifier, version, build, sizeBytes, deletable, lastUsedAt, state, platform }] */
function parseRuntimes(stdout) {
  let json;
  try { json = JSON.parse(stdout); } catch { return null; }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  return Object.values(json).filter((r) => r && typeof r.identifier === 'string').map((r) => ({
    identifier: r.identifier,
    runtimeIdentifier: r.runtimeIdentifier || null,
    version: r.version || '',
    build: r.build || '',
    sizeBytes: Number(r.sizeBytes) || 0,
    deletable: r.deletable !== false,
    lastUsedAt: r.lastUsedAt ? Date.parse(r.lastUsedAt) || null : null,
    state: r.state || '',
    platform: String(r.platformIdentifier || '').replace(/^com\.apple\.platform\./, '').replace(/simulator$/, ''),
  }));
}

const PLATFORM_NAME = { iphone: 'iOS', watch: 'watchOS', appletv: 'tvOS', xr: 'visionOS' };

async function devicesGroup(ctx) {
  const res = await run('xcrun', ['simctl', 'list', '-j', 'devices'], { exec: ctx.exec, timeout: 20000 });
  if (res.missing) return null;
  const devices = res.ok ? parseDevices(res.stdout) : null;
  if (!devices) return null;
  const items = [];
  await pool(devices, 4, async (d) => {
    let size = d.dataPathSize;
    if (!size && d.dataPath) size = (await dirSize(path.dirname(d.dataPath), { deadline: Date.now() + 8000 })).bytes;
    const booted = /^booted$/i.test(d.state) || /^booting|shutting down$/i.test(d.state);
    const badges = [];
    if (booted) badges.push({ text: 'Booted', kind: 'running' });
    if (!d.available) badges.push({ text: 'Unavailable', kind: 'warn' });
    items.push(makeItem({
      id: 'simdevice:' + d.udid,
      group: 'simulators',
      kind: 'userdata',
      label: d.name,
      name: d.name,
      detail: [d.runtimeName, d.available ? null : (d.availabilityError || 'runtime missing'), d.udid.slice(0, 8)].filter(Boolean).join(' · '),
      size,
      state: booted ? 'running' : 'idle',
      blocked: booted ? 'This simulator is running. Shut it down first.' : null,
      badges,
      // An unavailable device can never boot again: its runtime is gone.
      tier: d.available ? 'C' : 'B',
      tierReason: d.available ? 'Holds the apps and data installed on this simulator.' : 'Its runtime is no longer installed, so it cannot boot. Xcode lists it as unavailable.',
      restoreHint: d.available ? 'Create it again in Xcode (Window > Devices and Simulators) or with xcrun simctl create.' : null,
      paths: d.dataPath ? [path.dirname(d.dataPath)] : [],
      removal: { type: 'command', cmd: 'xcrun', args: ['simctl', 'delete', d.udid], expectGone: d.dataPath ? [path.dirname(d.dataPath)] : [] },
      runtime: d.runtime,
    }));
  });
  return items;
}

async function runtimesGroup(ctx, devices) {
  const res = await run('xcrun', ['simctl', 'runtime', 'list', '-j'], { exec: ctx.exec, timeout: 20000 });
  const runtimes = res.ok ? parseRuntimes(res.stdout) : null;
  if (!runtimes) return [];
  const bootedRuntimes = new Set(devices.filter((d) => d.state === 'running').map((d) => d.runtime));
  const usedBy = (rt) => devices.filter((d) => d.runtime === rt.runtimeIdentifier).length;
  return runtimes.map((rt) => {
    const name = (PLATFORM_NAME[rt.platform] || rt.platform || 'Simulator') + ' ' + rt.version;
    const inUse = bootedRuntimes.has(rt.runtimeIdentifier);
    let blocked = null;
    if (inUse) blocked = 'A booted simulator uses this runtime. Shut it down first.';
    else if (!rt.deletable) blocked = 'Xcode marks this runtime as not deletable (it ships with Xcode).';
    const n = usedBy(rt);
    // Deleting a runtime leaves every simulator made for it unable to boot,
    // with its apps and data stuck. Those go first, or the runtime stays.
    if (!blocked && !rt.runtimeIdentifier) blocked = 'Spaci could not tell which simulators use this runtime.';
    else if (!blocked && n) {
      const names = devices.filter((d) => d.runtime === rt.runtimeIdentifier).map((d) => d.name);
      blocked = n + (n === 1 ? ' simulator uses' : ' simulators use') + ' this runtime (' + names.slice(0, 3).join(', ') + (n > 3 ? ' and ' + (n - 3) + ' more' : '') + ') and would stop booting. Delete ' + (n === 1 ? 'it' : 'them') + ' first, or keep the runtime.';
    }
    return makeItem({
      id: 'simruntime:' + rt.identifier,
      group: 'simulators',
      kind: 'runtime',
      label: name + ' runtime',
      name,
      version: rt.version,
      detail: [rt.build, n ? n + (n === 1 ? ' simulator uses it' : ' simulators use it') : 'No simulator uses it', rt.lastUsedAt ? null : null].filter(Boolean).join(' · '),
      size: rt.sizeBytes,
      lastUsedAt: rt.lastUsedAt,
      state: inUse ? 'running' : 'idle',
      blocked,
      badges: inUse ? [{ text: 'In use', kind: 'running' }] : [],
      restoreHint: 'xcodebuild -downloadPlatform ' + (PLATFORM_NAME[rt.platform] || 'iOS') + ' (or Xcode > Settings > Components)',
      removal: { type: 'command', cmd: 'xcrun', args: ['simctl', 'runtime', 'delete', rt.identifier] },
    });
  });
}

async function deviceSupportItems(ctx) {
  const base = path.join(ctx.home, 'Library', 'Developer', 'Xcode');
  const items = [];
  for (const os of ['iOS', 'watchOS', 'tvOS', 'visionOS']) {
    const root = path.join(base, os + ' DeviceSupport');
    const list = (await listDir(root)).filter((e) => e.isDirectory());
    await pool(list, 4, async (e) => {
      const full = path.join(root, e.name);
      const size = (await dirSize(full)).bytes;
      const st = await lstatSafe(full);
      items.push(makeItem({
        id: 'devicesupport:' + full,
        group: 'simulators',
        kind: 'cache',
        label: os + ' ' + e.name + ' device symbols',
        name: e.name,
        detail: os + ' DeviceSupport',
        size,
        modifiedAt: st ? st.mtimeMs : null,
        restoreHint: 'Xcode copies the symbols again when a device on this version connects.',
        paths: [full],
        removal: { type: 'paths', root, paths: [full] },
      }));
    });
  }
  return items;
}

async function inventory(ctx) {
  if (ctx.platform !== 'darwin') return [];
  const devices = await devicesGroup(ctx);
  if (devices === null) {
    // No Xcode tools: DeviceSupport folders may still be there.
    const ds = await deviceSupportItems(ctx);
    return ds.length ? [makeGroup({ id: 'simulators', section: 'dev', category: 'simulators', title: 'Xcode simulators', icon: 'mobile', tech: 'xcode', roots: [], items: ds })] : [];
  }
  const runtimes = await runtimesGroup(ctx, devices);
  const ds = await deviceSupportItems(ctx);
  const items = [...devices, ...runtimes, ...ds].sort((a, b) => b.size - a.size);
  if (!items.length) return [];
  return [makeGroup({
    id: 'simulators', section: 'dev', category: 'simulators', title: 'Xcode simulators', icon: 'mobile', tech: 'xcode',
    roots: [path.join(ctx.home, 'Library', 'Developer', 'CoreSimulator')],
    items,
    note: 'Removed with xcrun simctl. Runtimes are system disk images; macOS frees their space after removal.',
  })];
}

module.exports = { parseDevices, parseRuntimes, runtimeLabel, inventory };
