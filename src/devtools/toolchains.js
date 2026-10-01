'use strict';
/**
 * Language toolchain versions: nvm, fnm and Volta (Node), pyenv and uv
 * (Python), conda environments, rustup toolchains.
 *
 * A version is protected (shown, never deletable) when:
 *   - a scanned project pins it (.nvmrc, .node-version, .python-version,
 *     rust-toolchain(.toml), .tool-versions, package.json engines or volta);
 *   - it is the tool's default (nvm alias default, pyenv global, rustup
 *     default, fnm default, Volta's default platform);
 *   - a running process uses it.
 * Pins are matched the way the tools resolve them: "20" means the newest
 * installed 20.x, an exact version means that version.
 *
 * Deletion uses the tool's own command where there is one (fnm uninstall,
 * pyenv uninstall -f, uv python uninstall, conda env remove, rustup toolchain
 * uninstall). nvm is a shell function and Volta has no uninstall for Node, so
 * for those Spaci removes the version folder, which is what `nvm uninstall`
 * itself does.
 */

const path = require('path');
const { run, listDir, lstatSafe, readText, readJson, dirSize, pool, absEnv, compareVersions } = require('./util');
const { makeGroup, makeItem } = require('./model');

function api(ctx) { return ctx.platform === 'win32' ? path.win32 : path.posix; }
function homeOf(ctx) { return ctx.platform === 'win32' ? (ctx.env.USERPROFILE || ctx.home) : ctx.home; }
const MAX_PROJECTS = 600;

// ---- project pins --------------------------------------------------------------

/** Normalise a version request: 'v20.11.1' -> '20.11.1', 'lts/*' -> null. */
function cleanSpec(s) {
  const v = String(s || '').trim().replace(/^v/i, '');
  const m = /^(?:[~^]|>=?\s*)?(\d+(?:\.\d+){0,2})(?:\.x)?\b/.exec(v);
  return m ? m[1] : null;
}

/**
 * Pins from one project's files: { node: [{ spec, source }], python: [...], rust: [...] }.
 * files: { name: text } for the files present.
 */
function pinsFromFiles(files) {
  const out = { node: [], python: [], rust: [] };
  const add = (lang, raw, source) => {
    const spec = lang === 'rust' ? String(raw || '').trim() : cleanSpec(raw);
    if (spec) out[lang].push({ spec, source });
  };
  if (files['.nvmrc']) add('node', files['.nvmrc'].split(/\r?\n/)[0], '.nvmrc');
  if (files['.node-version']) add('node', files['.node-version'].split(/\r?\n/)[0], '.node-version');
  if (files['.python-version']) for (const l of files['.python-version'].split(/\r?\n/)) if (l.trim()) add('python', l, '.python-version');
  if (files['rust-toolchain']) add('rust', files['rust-toolchain'].split(/\r?\n/)[0], 'rust-toolchain');
  if (files['rust-toolchain.toml']) {
    const m = /^\s*channel\s*=\s*["']([^"']+)["']/m.exec(files['rust-toolchain.toml']);
    if (m) add('rust', m[1], 'rust-toolchain.toml');
  }
  if (files['.tool-versions']) {
    for (const l of files['.tool-versions'].split(/\r?\n/)) {
      const [tool, ver] = l.trim().split(/\s+/);
      if (tool === 'nodejs' || tool === 'node') add('node', ver, '.tool-versions');
      else if (tool === 'python') add('python', ver, '.tool-versions');
      else if (tool === 'rust') add('rust', ver, '.tool-versions');
    }
  }
  if (files['package.json']) {
    let pkg = null;
    try { pkg = JSON.parse(files['package.json']); } catch { pkg = null; }
    if (pkg && pkg.volta && pkg.volta.node) add('node', pkg.volta.node, 'package.json volta');
    if (pkg && pkg.engines && typeof pkg.engines.node === 'string') add('node', pkg.engines.node, 'package.json engines');
  }
  return out;
}

const PIN_FILES = ['.nvmrc', '.node-version', '.python-version', 'rust-toolchain', 'rust-toolchain.toml', '.tool-versions', 'package.json'];

/** Pins across scanned projects: { node: [{ spec, source, project }], ... }. */
async function projectPins(projects) {
  const out = { node: [], python: [], rust: [] };
  const list = (Array.isArray(projects) ? projects : []).filter((p) => typeof p === 'string').slice(0, MAX_PROJECTS);
  await pool(list, 8, async (dir) => {
    const files = {};
    for (const f of PIN_FILES) {
      const t = await readText(path.join(dir, f), 256 * 1024);
      if (t != null) files[f] = t;
    }
    const pins = pinsFromFiles(files);
    for (const lang of Object.keys(pins)) for (const pin of pins[lang]) out[lang].push({ ...pin, project: dir });
  });
  return out;
}

/** The installed version a spec resolves to: exact match, else newest with that prefix. */
function resolveSpec(spec, versions) {
  const s = String(spec || '').replace(/^v/i, '');
  if (!s) return null;
  const clean = versions.map((v) => ({ v, n: String(v).replace(/^v/i, '') }));
  const exact = clean.find((x) => x.n === s);
  if (exact) return exact.v;
  const prefixed = clean.filter((x) => x.n.startsWith(s + '.')).sort((a, b) => compareVersions(b.n, a.n));
  return prefixed.length ? prefixed[0].v : null;
}

/** Map version -> reason it is protected, from pins, defaults and processes. */
function protections(versions, { pins = [], defaults = [], running = [] }) {
  const reasons = new Map();
  const add = (v, why) => { if (v && !reasons.has(v)) reasons.set(v, why); };
  for (const d of defaults) add(resolveSpec(d.spec, versions), d.why);
  for (const p of pins) add(resolveSpec(p.spec, versions), 'Pinned by ' + path.basename(p.project) + ' (' + p.source + ')');
  for (const r of running) add(r.version, r.why);
  return reasons;
}

/** Versions whose folder a running process executes from. */
function runningFrom(ctx, dirOf, versions) {
  const out = [];
  if (!ctx.procs || !ctx.procs.ok) return null;
  for (const v of versions) {
    const dir = dirOf(v);
    if (ctx.procs.list.some((pr) => (pr.args || '').includes(dir + path.sep) || (pr.args || '').includes(dir + '/'))) out.push({ version: v, why: 'A running program uses this version.' });
  }
  return out;
}

/** Build one toolchain group from installed version folders. */
async function versionGroup(ctx, spec) {
  const p = api(ctx);
  const st = await lstatSafe(spec.root);
  if (!st || !st.isDirectory()) return [];
  const entries = (await listDir(spec.root)).filter((e) => e.isDirectory() && spec.match(e.name));
  if (!entries.length) return [];
  const versions = entries.map((e) => e.name);
  const dirOf = (v) => p.join(spec.root, v, spec.sub || '');
  const running = runningFrom(ctx, (v) => p.join(spec.root, v), versions);
  const prot = protections(versions, { pins: spec.pins || [], defaults: spec.defaults || [], running: running || [] });
  const items = await pool(versions, 4, async (v) => {
    const dir = p.join(spec.root, v);
    const why = prot.get(v) || (running === null ? 'Spaci could not check whether a running program uses this version.' : null);
    const pinned = Boolean(prot.get(v)) && /^Pinned|default/i.test(prot.get(v) || '');
    const size = (await dirSize(dir)).bytes;
    const badges = [];
    if (prot.get(v)) badges.push({ text: /^Pinned/.test(prot.get(v)) ? 'Pinned' : /default/i.test(prot.get(v)) ? 'Default' : 'In use', kind: 'pinned' });
    return makeItem({
      id: spec.id + ':' + v,
      group: spec.id,
      kind: 'toolchain',
      label: spec.label(v),
      name: v,
      version: v,
      detail: prot.get(v) || spec.detail || '',
      size,
      state: prot.get(v) ? 'in-use' : 'idle',
      blocked: why,
      pinned,
      tier: prot.get(v) ? 'C' : 'B',
      badges,
      restoreHint: spec.restore(v),
      paths: [dir],
      removal: spec.removal(v, dir),
    });
  });
  return [makeGroup({
    id: spec.id, section: 'dev', category: 'toolchains', title: spec.title, tech: spec.tech, icon: 'code', roots: [spec.root],
    items: items.sort((a, b) => compareVersions(String(b.version).replace(/^[a-z-]*/i, ''), String(a.version).replace(/^[a-z-]*/i, ''))),
    note: spec.note || null,
  })];
}

// ---- Node ----------------------------------------------------------------------

async function nvm(ctx, pins) {
  const p = api(ctx);
  const dir = absEnv(ctx.env, 'NVM_DIR') || (absEnv(ctx.env, 'XDG_CONFIG_HOME') && ctx.platform !== 'win32' ? p.join(ctx.env.XDG_CONFIG_HOME, 'nvm') : null) || p.join(ctx.home, '.nvm');
  if (ctx.platform === 'win32') return []; // nvm-windows keeps versions elsewhere and has its own uninstall
  const def = (await readText(p.join(dir, 'alias', 'default'), 1024) || '').trim();
  return versionGroup(ctx, {
    id: 'nvm', title: 'Node versions (nvm)', tech: 'node', root: p.join(dir, 'versions', 'node'),
    match: (n) => /^v\d+\.\d+\.\d+/.test(n),
    pins: pins.node, defaults: def ? [{ spec: cleanSpec(def) || def, why: 'nvm default version' }] : [],
    label: (v) => 'Node ' + v,
    restore: (v) => 'nvm install ' + v,
    removal: (v, d) => ({ type: 'paths', root: p.join(dir, 'versions', 'node'), paths: [d] }),
    note: 'nvm uninstall is a shell function that deletes the version folder; Spaci does the same.',
  });
}

async function fnm(ctx, pins) {
  const p = api(ctx);
  const env = ctx.env || {};
  const candidates = [absEnv(env, 'FNM_DIR'),
    p.join(absEnv(env, 'XDG_DATA_HOME') || p.join(ctx.home, '.local', 'share'), 'fnm'),
    p.join(ctx.home, '.fnm'),
    ctx.platform === 'darwin' ? p.join(ctx.home, 'Library', 'Application Support', 'fnm') : null,
    ctx.platform === 'win32' && env.APPDATA ? p.join(env.APPDATA, 'fnm') : null].filter(Boolean);
  let base = null;
  for (const c of candidates) { const st = await lstatSafe(p.join(c, 'node-versions')); if (st && st.isDirectory()) { base = c; break; } }
  if (!base) return [];
  let def = null;
  try { def = require('fs').readlinkSync(p.join(base, 'aliases', 'default')); } catch { def = null; }
  const defVer = def ? (/(v\d+\.\d+\.\d+)/.exec(def) || [])[1] : null;
  return versionGroup(ctx, {
    id: 'fnm', title: 'Node versions (fnm)', tech: 'node', root: p.join(base, 'node-versions'),
    match: (n) => /^v\d+\.\d+\.\d+/.test(n),
    pins: pins.node, defaults: defVer ? [{ spec: defVer, why: 'fnm default version' }] : [],
    label: (v) => 'Node ' + v,
    restore: (v) => 'fnm install ' + v,
    removal: (v, d) => ({ type: 'command', cmd: 'fnm', args: ['uninstall', v], env: { FNM_DIR: base }, expectGone: [d], fallback: { type: 'paths', root: p.join(base, 'node-versions'), paths: [d] } }),
  });
}

async function volta(ctx, pins) {
  const p = api(ctx);
  const env = ctx.env || {};
  const home = absEnv(env, 'VOLTA_HOME') || (ctx.platform === 'win32' ? (env.LOCALAPPDATA ? p.join(env.LOCALAPPDATA, 'Volta') : null) : p.join(ctx.home, '.volta'));
  if (!home) return [];
  const platform = await readJson(p.join(home, 'tools', 'user', 'platform.json'));
  const def = platform && platform.node && (platform.node.runtime || platform.node);
  return versionGroup(ctx, {
    id: 'volta', title: 'Node versions (Volta)', tech: 'node', root: p.join(home, 'tools', 'image', 'node'),
    match: (n) => /^\d+\.\d+\.\d+/.test(n),
    pins: pins.node, defaults: typeof def === 'string' ? [{ spec: def, why: 'Volta default version' }] : [],
    label: (v) => 'Node ' + v,
    restore: (v) => 'volta install node@' + v,
    removal: (v, d) => ({ type: 'paths', root: p.join(home, 'tools', 'image', 'node'), paths: [d] }),
    note: 'Volta cannot uninstall Node versions; Spaci removes the unpacked version folder.',
  });
}

// ---- Python --------------------------------------------------------------------

async function pyenv(ctx, pins) {
  const p = api(ctx);
  const root = absEnv(ctx.env, 'PYENV_ROOT') || (ctx.platform === 'win32' ? p.join(homeOf(ctx), '.pyenv', 'pyenv-win') : p.join(ctx.home, '.pyenv'));
  const global = (await readText(p.join(root, 'version'), 4096) || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && s !== 'system');
  return versionGroup(ctx, {
    id: 'pyenv', title: 'Python versions (pyenv)', tech: 'python', root: p.join(root, 'versions'),
    match: (n) => !n.startsWith('.'),
    pins: pins.python, defaults: global.map((g) => ({ spec: g, why: 'pyenv global version' })),
    label: (v) => 'Python ' + v,
    restore: (v) => 'pyenv install ' + v,
    removal: (v, d) => ({ type: 'command', cmd: 'pyenv', args: ['uninstall', '-f', v], env: { PYENV_ROOT: root }, expectGone: [d], fallback: { type: 'paths', root: p.join(root, 'versions'), paths: [d] } }),
  });
}

function uvPythonDir(ctx) {
  const p = api(ctx);
  const env = ctx.env || {};
  const custom = absEnv(env, 'UV_PYTHON_INSTALL_DIR');
  if (custom) return custom;
  if (ctx.platform === 'win32') return env.APPDATA ? p.join(env.APPDATA, 'uv', 'data', 'python') : null;
  return p.join(absEnv(env, 'XDG_DATA_HOME') || p.join(ctx.home, '.local', 'share'), 'uv', 'python');
}

async function uvPython(ctx, pins) {
  const p = api(ctx);
  const root = uvPythonDir(ctx);
  if (!root) return [];
  // Folder names are uv's keys: cpython-3.12.4-macos-aarch64-none.
  const verOf = (key) => (/^[a-z]+-(\d+\.\d+\.\d+[a-z0-9]*)/.exec(key) || [])[1] || key;
  const st = await lstatSafe(root);
  if (!st) return [];
  const keys = (await listDir(root)).filter((e) => e.isDirectory() && /^[a-z]+-\d+\.\d+/.test(e.name)).map((e) => e.name);
  const byVersion = keys.map(verOf);
  const pyPins = pins.python.map((pin) => ({ ...pin, spec: pin.spec }));
  const groups = await versionGroup(ctx, {
    id: 'uv-python', title: 'Python versions (uv)', tech: 'python', root,
    match: (n) => keys.includes(n),
    // Pins name versions; map them onto keys.
    pins: pyPins.map((pin) => ({ ...pin, spec: keys[byVersion.indexOf(resolveSpec(pin.spec, byVersion))] || '__none__' })),
    label: (k) => 'Python ' + verOf(k) + (k.includes('freethreaded') ? ' (free-threaded)' : ''),
    restore: (k) => 'uv python install ' + verOf(k),
    removal: (k, d) => ({ type: 'command', cmd: 'uv', args: ['python', 'uninstall', k], env: { UV_PYTHON_INSTALL_DIR: root }, expectGone: [d], fallback: { type: 'paths', root, paths: [d] } }),
  });
  return groups;
}

async function conda(ctx) {
  const p = api(ctx);
  // ~/.conda/environments.txt lists every environment conda created.
  const listed = (await readText(p.join(homeOf(ctx), '.conda', 'environments.txt'), 256 * 1024) || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!listed.length) return [];
  const envs = [];
  for (const e of Array.from(new Set(listed))) {
    const st = await lstatSafe(p.join(e, 'conda-meta'));
    if (st && st.isDirectory()) envs.push(e);
  }
  if (!envs.length) return [];
  // The base install is the one with no envs/ parent; it is never offered.
  const isBase = (e) => p.basename(p.dirname(e)) !== 'envs';
  const active = absEnv(ctx.env, 'CONDA_PREFIX');
  const items = await pool(envs, 3, async (e) => {
    const name = isBase(e) ? 'base' : p.basename(e);
    const running = ctx.procs && ctx.procs.ok ? ctx.procs.list.some((pr) => (pr.args || '').includes(e + p.sep)) : null;
    let blocked = null;
    if (isBase(e)) blocked = 'The base environment is conda itself.';
    else if (active && active === e) blocked = 'This environment is active.';
    else if (running) blocked = 'A running program uses this environment.';
    else if (running === null) blocked = 'Spaci could not check whether a running program uses this environment.';
    return makeItem({
      id: 'conda:' + e,
      group: 'conda',
      kind: 'userdata',
      label: 'conda env ' + name,
      name,
      detail: e,
      size: (await dirSize(e)).bytes,
      blocked,
      badges: isBase(e) ? [{ text: 'Base', kind: 'pinned' }] : [],
      tierReason: 'Holds the packages you installed into it. Recreate it from an environment file if you have one.',
      restoreHint: 'conda env create -f environment.yml (if you exported it)',
      paths: [e],
      removal: { type: 'command', cmd: 'conda', args: ['env', 'remove', '-p', e, '-y'], expectGone: [e] },
    });
  });
  return [makeGroup({ id: 'conda', section: 'dev', category: 'toolchains', title: 'conda environments', tech: 'python', icon: 'code', roots: envs.filter(isBase), items: items.sort((a, b) => b.size - a.size), note: 'Removed with conda env remove. Run conda clean --all to drop unused package downloads.' })];
}

// ---- Rust ----------------------------------------------------------------------

async function rustup(ctx, pins) {
  const p = api(ctx);
  const root = absEnv(ctx.env, 'RUSTUP_HOME') || p.join(homeOf(ctx), '.rustup');
  const settings = await readText(p.join(root, 'settings.toml'), 256 * 1024) || '';
  const def = (/^\s*default_toolchain\s*=\s*"([^"]+)"/m.exec(settings) || [])[1];
  const overrides = [];
  const ov = /\[overrides\]([\s\S]*?)(\n\[|$)/.exec(settings);
  if (ov) for (const m of ov[1].matchAll(/"([^"]+)"\s*=\s*"([^"]+)"/g)) overrides.push({ spec: m[2], source: 'rustup override', project: m[1] });
  const cargoHome = absEnv(ctx.env, 'CARGO_HOME') || p.join(homeOf(ctx), '.cargo');
  const rustupBin = p.join(cargoHome, 'bin', ctx.platform === 'win32' ? 'rustup.exe' : 'rustup');
  // Toolchain folders are "<channel>-<host triple>"; a pin names the channel.
  const rustPins = [...pins.rust, ...overrides];
  const root2 = p.join(root, 'toolchains');
  const names = (await listDir(root2)).filter((e) => e.isDirectory()).map((e) => e.name);
  const forChannel = (spec) => names.find((n) => n === spec || n.startsWith(spec + '-')) || null;
  return versionGroup(ctx, {
    id: 'rustup', title: 'Rust toolchains (rustup)', tech: 'rust', root: root2,
    match: () => true,
    pins: rustPins.map((pin) => ({ ...pin, spec: forChannel(pin.spec) || '__none__' })),
    defaults: def ? [{ spec: forChannel(def) || def, why: 'rustup default toolchain' }] : [],
    label: (v) => 'Rust ' + v,
    restore: (v) => 'rustup toolchain install ' + v,
    removal: (v, d) => ({ type: 'command', cmd: rustupBin, args: ['toolchain', 'uninstall', v], env: { RUSTUP_HOME: root }, expectGone: [d], fallback: { type: 'paths', root: root2, paths: [d] } }),
  });
}

async function inventory(ctx) {
  const pins = await projectPins(ctx.projects);
  const parts = await Promise.all([nvm(ctx, pins), fnm(ctx, pins), volta(ctx, pins), pyenv(ctx, pins), uvPython(ctx, pins), conda(ctx), rustup(ctx, pins)].map((p) => p.catch(() => [])));
  return parts.flat();
}

module.exports = { cleanSpec, pinsFromFiles, projectPins, resolveSpec, protections, uvPythonDir, inventory, nvm, fnm, volta, pyenv, uvPython, conda, rustup, run };
