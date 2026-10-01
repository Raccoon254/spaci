'use strict';
/**
 * Language toolchain versions: nvm, fnm and Volta (Node), pyenv and uv
 * (Python), conda environments, rustup toolchains.
 *
 * A version is protected (shown, never deletable) when:
 *   - a scanned project pins it (.nvmrc, .node-version, .python-version,
 *     rust-toolchain(.toml), .tool-versions (asdf), mise.toml / .mise.toml,
 *     package.json engines or volta). pyproject.toml requires-python (and
 *     Poetry's python dependency) is a range: an installed version that
 *     satisfies it is protected when it is the only one that does;
 *   - Spaci has not scanned projects yet: then it cannot see any pin, so
 *     every version is kept until a scan has run;
 *   - it is the tool's default (nvm alias default, pyenv global, rustup
 *     default, fnm default, Volta's default platform), resolved the way the
 *     tool resolves it (nvm: alias chains, lts/<codename>, lts/*, node and
 *     stable). A default Spaci cannot resolve to an installed version blocks
 *     every version of that tool: it fails closed;
 *   - a running process uses it;
 *   - a virtualenv points at it: pyenv virtualenvs under versions/<v>/envs/
 *     (and their versions/<name> symlinks, which pins may name), a scanned
 *     project's .venv or venv (pyvenv.cfg home=), and the venvs Poetry,
 *     Pipenv, pipx and uv tools keep in their own folders.
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
const fs = require('fs');
const { run, listDir, lstatSafe, readText, readJson, dirSize, pool, absEnv, compareVersions, isInside } = require('./util');
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
    const text = String(raw || '').trim();
    // Python pins may name a pyenv virtualenv or a non-CPython build
    // (myenv, pypy3.10-7.3.12): keep the name so it can be resolved.
    const spec = lang === 'rust' ? text : cleanSpec(raw) || (lang === 'python' && text && text !== 'system' && !/\s/.test(text) ? text : null);
    if (spec) out[lang].push({ spec, source });
  };
  for (const f of VENV_CFGS) {
    const home = venvHome(files[f]);
    if (home) out.python.push({ path: home, source: f.replace(/\\/g, '/') });
  }
  if (files['.nvmrc']) add('node', files['.nvmrc'].split(/\r?\n/)[0], '.nvmrc');
  if (files['.node-version']) add('node', files['.node-version'].split(/\r?\n/)[0], '.node-version');
  if (files['.python-version']) for (const l of files['.python-version'].split(/\r?\n/)) if (l.trim()) add('python', l, '.python-version');
  // The legacy rust-toolchain file is either one channel line or, like
  // rust-toolchain.toml, TOML with a [toolchain] table.
  if (files['rust-toolchain']) {
    const t = files['rust-toolchain'];
    if (/^\s*\[/.test(t)) { const m = /^\s*channel\s*=\s*["']([^"']+)["']/m.exec(t); if (m) add('rust', m[1], 'rust-toolchain'); }
    else add('rust', t.split(/\r?\n/)[0], 'rust-toolchain');
  }
  if (files['rust-toolchain.toml']) {
    const m = /^\s*channel\s*=\s*["']([^"']+)["']/m.exec(files['rust-toolchain.toml']);
    if (m) add('rust', m[1], 'rust-toolchain.toml');
  }
  const TOOL_LANG = { node: 'node', nodejs: 'node', python: 'python', rust: 'rust' };
  if (files['.tool-versions']) {
    for (const l of files['.tool-versions'].split(/\r?\n/)) {
      // "nodejs 20.11.1 18.19.0": every listed version is a fallback asdf may use.
      const [tool, ...vers] = l.replace(/#.*$/, '').trim().split(/\s+/);
      if (TOOL_LANG[tool]) for (const v of vers) add(TOOL_LANG[tool], v, '.tool-versions');
    }
  }
  for (const f of MISE_FILES) {
    if (!files[f]) continue;
    for (const { tool, version } of miseTools(files[f])) if (TOOL_LANG[tool]) add(TOOL_LANG[tool], version, f.replace(/\\/g, '/'));
  }
  if (files['pyproject.toml']) {
    for (const r of pythonRanges(files['pyproject.toml'])) out.python.push({ range: r.range, source: 'pyproject.toml ' + r.key });
  }
  if (files['package.json']) {
    let pkg = null;
    try { pkg = JSON.parse(files['package.json']); } catch { pkg = null; }
    if (pkg && pkg.volta && pkg.volta.node) add('node', pkg.volta.node, 'package.json volta');
    if (pkg && pkg.engines && typeof pkg.engines.node === 'string') add('node', pkg.engines.node, 'package.json engines');
  }
  return out;
}

// A project's own virtualenv names the interpreter it was made from.
const VENV_CFGS = [path.join('.venv', 'pyvenv.cfg'), path.join('venv', 'pyvenv.cfg')];
const MISE_FILES = ['mise.toml', '.mise.toml', 'mise.local.toml', '.mise.local.toml', path.join('.config', 'mise.toml'), path.join('.config', 'mise', 'config.toml')];
const PIN_FILES = ['.nvmrc', '.node-version', '.python-version', 'rust-toolchain', 'rust-toolchain.toml', '.tool-versions', 'package.json', 'pyproject.toml', ...MISE_FILES, ...VENV_CFGS];

/**
 * [tools] entries of a mise config: node = "20", python = ["3.12", "3.11"],
 * rust = { version = "1.79" }. Other tables end the section.
 */
function miseTools(text) {
  const out = [];
  let inTools = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    if (/^\[/.test(line)) { inTools = /^\[\s*tools\s*\]$/.test(line); continue; }
    if (!inTools) continue;
    const m = /^["']?([A-Za-z0-9_:@/-]+)["']?\s*=\s*(.+)$/.exec(line);
    if (!m) continue;
    const tool = m[1].replace(/^(core|asdf|aqua|ubi|vfox):/, '').toLowerCase();
    let val = m[2];
    const tbl = /version\s*=\s*["']([^"']+)["']/.exec(val);
    if (tbl) val = '"' + tbl[1] + '"';
    for (const q of val.matchAll(/["']([^"']+)["']/g)) out.push({ tool, version: q[1] });
  }
  return out;
}

/** requires-python (PEP 621) and Poetry's python dependency, as range strings. */
function pythonRanges(text) {
  const out = [];
  const t = String(text || '');
  const req = /^\s*requires-python\s*=\s*["']([^"']+)["']/m.exec(t);
  if (req) out.push({ key: 'requires-python', range: req[1] });
  const poetry = /^\s*\[tool\.poetry\.dependencies\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m.exec(t);
  if (poetry) {
    const m = /^\s*python\s*=\s*["']([^"']+)["']/m.exec(poetry[1]);
    if (m) out.push({ key: 'python', range: m[1] });
  }
  return out;
}

function pyNums(v) {
  const m = /^v?(\d+(?:\.\d+)*)/.exec(String(v || '').trim());
  return m ? m[1].split('.').map(Number) : null;
}

function cmpNums(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * Does version satisfy a Python range? PEP 440 clauses (>=, >, <=, <, ==,
 * ===, !=, ~=, ==X.*) joined by commas, Poetry's ^ and ~, and || between
 * alternatives. null when the range cannot be read.
 */
function satisfiesPython(version, range) {
  const v = pyNums(version);
  if (!v) return null;
  const alts = String(range || '').split('||');
  let any = false;
  for (const alt of alts) {
    const clauses = alt.split(',').map((c) => c.trim()).filter(Boolean);
    if (!clauses.length) return null;
    let all = true;
    for (const c of clauses) {
      const m = /^(===|==|!=|~=|>=|<=|>|<|\^|~)?\s*v?(\d+(?:\.\d+)*)(\.\*)?$/.exec(c);
      if (!m) return null;
      const op = m[1] || '==';
      const want = m[2].split('.').map(Number);
      const star = Boolean(m[3]);
      const prefixEq = () => want.every((n, i) => (v[i] || 0) === n);
      let ok;
      if (op === '==' || op === '===') ok = star ? prefixEq() : cmpNums(v, want) === 0;
      else if (op === '!=') ok = star ? !prefixEq() : cmpNums(v, want) !== 0;
      else if (op === '>=') ok = cmpNums(v, want) >= 0;
      else if (op === '>') ok = cmpNums(v, want) > 0;
      else if (op === '<=') ok = cmpNums(v, want) <= 0;
      else if (op === '<') ok = cmpNums(v, want) < 0;
      else if (op === '~=') {
        if (want.length < 2) return null;
        ok = cmpNums(v, want) >= 0 && want.slice(0, -1).every((n, i) => (v[i] || 0) === n);
      } else if (op === '^') {
        // ^3.10 -> >=3.10,<4; ^0.2 -> >=0.2,<0.3
        const lead = want.findIndex((n) => n !== 0);
        const k = lead < 0 ? want.length - 1 : lead;
        const upper = want.slice(0, k + 1); upper[k] += 1;
        ok = cmpNums(v, want) >= 0 && cmpNums(v.slice(0, k + 1), upper) < 0;
      } else { // ~3.10 -> >=3.10,<3.11; ~3 -> >=3,<4
        const k = want.length >= 2 ? 1 : 0;
        const upper = want.slice(0, k + 1); upper[k] += 1;
        ok = cmpNums(v, want) >= 0 && cmpNums(v.slice(0, k + 1), upper) < 0;
      }
      if (!ok) { all = false; break; }
    }
    if (all) any = true;
  }
  return any;
}

/** The interpreter folder a pyvenv.cfg names (its home= line), or null. */
function venvHome(text) {
  if (typeof text !== 'string') return null;
  const m = /^\s*home\s*=\s*(.+?)\s*$/m.exec(text);
  return m && /^([A-Za-z]:[\\/]|[\\/])/.test(m[1]) ? m[1] : null;
}

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

function realOr(p) { try { return fs.realpathSync.native(p); } catch { return null; } }

/** p is inside dir, by string or by real path (venv homes often go through symlinks). */
function insideEither(dir, p) {
  if (isInside(dir, p)) return true;
  const rd = realOr(dir);
  const rp = realOr(p);
  return Boolean(rd && rp && isInside(rd, rp));
}

/** Map version -> reason it is protected, from pins, defaults and processes. */
function protections(versions, { pins = [], defaults = [], running = [], dirOf = null, versionOf = (v) => v }) {
  const reasons = new Map();
  const add = (v, why) => { if (v && !reasons.has(v)) reasons.set(v, why); };
  for (const d of defaults) add(resolveSpec(d.spec, versions), d.why);
  for (const p of pins) {
    const why = 'Pinned by ' + path.basename(p.project) + ' (' + p.source + ')';
    if (p.path) { if (dirOf) for (const v of versions) if (insideEither(dirOf(v), p.path)) add(v, why); continue; }
    if (p.range) {
      // A range keeps the one installed version that satisfies it; with
      // several, any one of them still does.
      const ok = versions.filter((v) => satisfiesPython(versionOf(v), p.range) === true);
      if (ok.length === 1) add(ok[0], why + ': the only installed version that satisfies ' + p.range);
      continue;
    }
    add(resolveSpec(p.spec, versions), why);
  }
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

const NO_SCAN = 'Scan your projects first so Spaci can see which versions they use.';

/**
 * Whether the project list is a real scan. Main says so explicitly; a caller
 * that passes no flag counts as scanned only when it passes projects.
 */
function projectsScanned(ctx) {
  if (ctx && ctx.projectsScanned !== undefined) return Boolean(ctx.projectsScanned);
  return Boolean(ctx && Array.isArray(ctx.projects) && ctx.projects.length);
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
  const prot = protections(versions, { pins: spec.pins || [], defaults: spec.defaults || [], running: running || [], dirOf: (v) => p.join(spec.root, v), versionOf: spec.versionOf });
  const extra = spec.blockFor ? await spec.blockFor(versions) : new Map();
  const items = await pool(versions, 4, async (v) => {
    const dir = p.join(spec.root, v);
    const why = prot.get(v) || extra.get(v) || spec.blockAll || (running === null ? 'Spaci could not check whether a running program uses this version.' : null) || (projectsScanned(ctx) ? null : NO_SCAN);
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

/** Why every version stays when a tool's default cannot be resolved. */
function unresolvedDefault(tool, value) {
  return 'Spaci could not work out which version ' + tool + ' uses by default' + (value ? ' (' + String(value).slice(0, 60) + ')' : '') + ', so it keeps every version.';
}

/** Installed version folder names under a root, filtered. */
async function installedNames(root, match) {
  return (await listDir(root)).filter((e) => e.isDirectory() && match(e.name)).map((e) => e.name);
}

function newestOf(versions) {
  return versions.slice().sort((a, b) => compareVersions(String(b).replace(/^v/i, ''), String(a).replace(/^v/i, '')))[0] || null;
}

/**
 * nvm's default, resolved the way nvm_resolve_alias does:
 *   alias/<name> files chain to other aliases or versions; lts/* and
 *   lts/<codename> are files under alias/lts/; "node" and "stable" mean the
 *   newest installed version; "system" means no nvm version at all.
 * -> { version } | { none: true } | { error: reason }
 */
async function nvmDefault(dir, versions, p) {
  const raw = await readText(p.join(dir, 'alias', 'default'), 1024);
  if (raw == null) return (await lstatSafe(p.join(dir, 'alias', 'default'))) ? { error: unresolvedDefault('nvm') } : { none: true };
  const first = raw.trim();
  let name = first;
  const seen = new Set();
  for (let i = 0; i < 16; i++) {
    if (!name) break;
    if (name === 'system') return { none: true };
    if (name === 'node' || name === 'stable') { const v = newestOf(versions); return v ? { version: v } : { error: unresolvedDefault('nvm', first) }; }
    if (/^v?\d+(\.\d+){0,2}$/i.test(name)) {
      const v = resolveSpec(name, versions);
      return v ? { version: v } : { error: unresolvedDefault('nvm', first) };
    }
    if (seen.has(name) || !/^[A-Za-z0-9_.*/-]+$/.test(name) || name.split('/').some((x) => !x || x === '..' || x === '.')) break;
    seen.add(name);
    const next = await readText(p.join(dir, 'alias', ...name.split('/')), 1024);
    if (next == null) break;
    name = next.trim();
  }
  return { error: unresolvedDefault('nvm', first) };
}

// ---- Node ----------------------------------------------------------------------

async function nvm(ctx, pins) {
  const p = api(ctx);
  const dir = absEnv(ctx.env, 'NVM_DIR') || (absEnv(ctx.env, 'XDG_CONFIG_HOME') && ctx.platform !== 'win32' ? p.join(ctx.env.XDG_CONFIG_HOME, 'nvm') : null) || p.join(ctx.home, '.nvm');
  if (ctx.platform === 'win32') return []; // nvm-windows keeps versions elsewhere and has its own uninstall
  const match = (n) => /^v\d+\.\d+\.\d+/.test(n);
  const def = await nvmDefault(dir, await installedNames(p.join(dir, 'versions', 'node'), match), p);
  return versionGroup(ctx, {
    id: 'nvm', title: 'Node versions (nvm)', tech: 'node', root: p.join(dir, 'versions', 'node'),
    match,
    pins: pins.node, defaults: def.version ? [{ spec: def.version, why: 'nvm default version' }] : [],
    blockAll: def.error || null,
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
  // aliases/default is a symlink (a junction on Windows) to
  // node-versions/<version>/installation.
  const match = (n) => /^v\d+\.\d+\.\d+/.test(n);
  const installed = await installedNames(p.join(base, 'node-versions'), match);
  let def = null;
  let blockAll = null;
  try { def = await require('fs').promises.readlink(p.join(base, 'aliases', 'default')); } catch (e) {
    if (e.code !== 'ENOENT') blockAll = unresolvedDefault('fnm');
  }
  const defVer = def ? (/(v\d+\.\d+\.\d+)/.exec(def) || [])[1] : null;
  if (def && (!defVer || !installed.includes(defVer))) blockAll = unresolvedDefault('fnm', def);
  return versionGroup(ctx, {
    id: 'fnm', title: 'Node versions (fnm)', tech: 'node', root: p.join(base, 'node-versions'),
    match,
    pins: pins.node, defaults: defVer && !blockAll ? [{ spec: defVer, why: 'fnm default version' }] : [],
    blockAll,
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
  const platformFile = p.join(home, 'tools', 'user', 'platform.json');
  const platform = await readJson(platformFile);
  const def = platform && platform.node && (platform.node.runtime || platform.node);
  const match = (n) => /^\d+\.\d+\.\d+/.test(n);
  const installed = await installedNames(p.join(home, 'tools', 'image', 'node'), match);
  let blockAll = null;
  if (!platform && (await lstatSafe(platformFile))) blockAll = unresolvedDefault('Volta');
  else if (platform && platform.node && (typeof def !== 'string' || !resolveSpec(def, installed))) blockAll = unresolvedDefault('Volta', typeof def === 'string' ? def : null);
  return versionGroup(ctx, {
    id: 'volta', title: 'Node versions (Volta)', tech: 'node', root: p.join(home, 'tools', 'image', 'node'),
    match,
    pins: pins.node, defaults: typeof def === 'string' && !blockAll ? [{ spec: def, why: 'Volta default version' }] : [],
    blockAll,
    label: (v) => 'Node ' + v,
    restore: (v) => 'volta install node@' + v,
    removal: (v, d) => ({ type: 'paths', root: p.join(home, 'tools', 'image', 'node'), paths: [d] }),
    note: 'Volta cannot uninstall Node versions; Spaci removes the unpacked version folder.',
  });
}

// ---- Python --------------------------------------------------------------------

/**
 * pyenv-virtualenv keeps each env in versions/<base>/envs/<name> and links
 * versions/<name> to it, so "myenv" in .python-version or the global file
 * means <base>. -> { base: Map(name -> base), envs: Map(base -> [names]) }
 */
async function pyenvVirtualenvs(versionsDir, p) {
  const base = new Map();
  const envs = new Map();
  for (const e of await listDir(versionsDir)) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) {
      const names = (await listDir(p.join(versionsDir, e.name, 'envs'))).filter((x) => !x.name.startsWith('.')).map((x) => x.name);
      if (names.length) envs.set(e.name, names);
      for (const n of names) { base.set(e.name + '/envs/' + n, e.name); if (!base.has(n)) base.set(n, e.name); }
    } else if (e.isSymbolicLink()) {
      let target = null;
      try { target = await fs.promises.readlink(p.join(versionsDir, e.name)); } catch { target = null; }
      if (!target) continue;
      const abs = p.resolve(versionsDir, target);
      const rel = p.relative(versionsDir, abs).split(/[\\/]/);
      if (rel.length >= 3 && rel[0] !== '..' && rel[1] === 'envs') base.set(e.name, rel[0]);
    }
  }
  return { base, envs };
}

/** A pyenv name as the version folder it runs: a virtualenv becomes its base. */
function pyenvBase(spec, venvs) {
  const s = String(spec || '').trim().replace(/\\/g, '/');
  if (venvs.base.has(s)) return venvs.base.get(s);
  const m = /^([^/]+)\/envs\/[^/]+$/.exec(s);
  return m ? m[1] : s;
}

async function pyenv(ctx, pins) {
  const p = api(ctx);
  const root = absEnv(ctx.env, 'PYENV_ROOT') || (ctx.platform === 'win32' ? p.join(homeOf(ctx), '.pyenv', 'pyenv-win') : p.join(ctx.home, '.pyenv'));
  const versionsDir = p.join(root, 'versions');
  const global = (await readText(p.join(root, 'version'), 4096) || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && s !== 'system');
  const venvs = await pyenvVirtualenvs(versionsDir, p);
  const installed = await installedNames(versionsDir, (n) => !n.startsWith('.'));
  const defaults = global.map((g) => ({ spec: pyenvBase(g, venvs), why: 'pyenv global version' }));
  const ownVenvs = [];
  for (const v of installed) {
    const home = venvHome(await readText(p.join(versionsDir, v, 'pyvenv.cfg'), 64 * 1024));
    if (home) ownVenvs.push({ path: home, source: 'pyenv virtualenv', project: p.join(versionsDir, v) });
  }
  const unresolved = defaults.find((d) => !resolveSpec(d.spec, installed));
  return versionGroup(ctx, {
    id: 'pyenv', title: 'Python versions (pyenv)', tech: 'python', root: versionsDir,
    match: (n) => !n.startsWith('.'),
    pins: [...pins.python.map((pin) => (pin.spec ? { ...pin, spec: pyenvBase(pin.spec, venvs) } : pin)), ...ownVenvs],
    defaults,
    blockAll: unresolved && installed.length ? unresolvedDefault('pyenv', unresolved.spec) : null,
    // A version with virtualenvs: deleting it deletes them, and each is a
    // set of packages someone installed.
    blockFor: async (versions) => new Map(versions.filter((v) => venvs.envs.has(v)).map((v) => {
      const names = venvs.envs.get(v);
      return [v, 'Has pyenv virtualenvs (' + names.slice(0, 3).join(', ') + (names.length > 3 ? ' and ' + (names.length - 3) + ' more' : '') + '). Delete them first with pyenv virtualenv-delete.'];
    })),
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
  const pyPins = pins.python.filter((pin) => pin.spec);
  const otherPins = pins.python.filter((pin) => pin.path || pin.range);
  const groups = await versionGroup(ctx, {
    id: 'uv-python', title: 'Python versions (uv)', tech: 'python', root,
    match: (n) => keys.includes(n),
    // Pins name versions; map them onto keys.
    pins: [...pyPins.map((pin) => ({ ...pin, spec: keys[byVersion.indexOf(resolveSpec(pin.spec, byVersion))] || '__none__' })), ...otherPins],
    versionOf: verOf,
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
  const settingsRaw = await readText(p.join(root, 'settings.toml'), 256 * 1024);
  const settingsUnreadable = settingsRaw == null && Boolean(await lstatSafe(p.join(root, 'settings.toml')));
  const settings = settingsRaw || '';
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
    defaults: def && forChannel(def) ? [{ spec: forChannel(def), why: 'rustup default toolchain' }] : [],
    // A default that names no installed toolchain (a linked one, a typo):
    // Spaci cannot tell which one rustup runs, so it keeps them all.
    blockAll: settingsUnreadable || (def && !forChannel(def)) ? unresolvedDefault('rustup', def) : null,
    label: (v) => 'Rust ' + v,
    restore: (v) => 'rustup toolchain install ' + v,
    removal: (v, d) => ({ type: 'command', cmd: rustupBin, args: ['toolchain', 'uninstall', v], env: { RUSTUP_HOME: root }, expectGone: [d], fallback: { type: 'paths', root: root2, paths: [d] } }),
  });
}

/**
 * Virtualenvs tools keep outside projects (Poetry's cache, Pipenv, pipx, uv
 * tools): each one's pyvenv.cfg names the interpreter it needs.
 */
async function toolVenvPins(ctx) {
  const p = api(ctx);
  const env = ctx.env || {};
  const h = homeOf(ctx);
  const xdgData = absEnv(env, 'XDG_DATA_HOME') || p.join(ctx.home, '.local', 'share');
  const xdgCache = absEnv(env, 'XDG_CACHE_HOME') || p.join(ctx.home, '.cache');
  const dirs = [
    ['Poetry', absEnv(env, 'POETRY_VIRTUALENVS_PATH') || (ctx.platform === 'darwin' ? p.join(ctx.home, 'Library', 'Caches', 'pypoetry', 'virtualenvs')
      : ctx.platform === 'win32' ? (env.LOCALAPPDATA ? p.join(env.LOCALAPPDATA, 'pypoetry', 'Cache', 'virtualenvs') : null) : p.join(xdgCache, 'pypoetry', 'virtualenvs'))],
    ['Pipenv', absEnv(env, 'WORKON_HOME') || p.join(h, '.virtualenvs')],
    ['Pipenv', ctx.platform === 'win32' ? null : p.join(xdgData, 'virtualenvs')],
    ['pipx', absEnv(env, 'PIPX_HOME') ? p.join(env.PIPX_HOME, 'venvs') : p.join(h, '.local', 'pipx', 'venvs')],
    ['pipx', ctx.platform === 'win32' ? null : p.join(xdgData, 'pipx', 'venvs')],
    ['uv tool', absEnv(env, 'UV_TOOL_DIR') || (ctx.platform === 'win32' ? (env.APPDATA ? p.join(env.APPDATA, 'uv', 'data', 'tools') : null) : p.join(xdgData, 'uv', 'tools'))],
  ].filter((d) => d[1]);
  const out = [];
  const seen = new Set();
  for (const [tool, dir] of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    for (const e of (await listDir(dir)).slice(0, 2000)) {
      if (!e.isDirectory()) continue;
      const home = venvHome(await readText(p.join(dir, e.name, 'pyvenv.cfg'), 64 * 1024));
      if (home) out.push({ path: home, source: tool + ' virtualenv', project: p.join(dir, e.name) });
    }
  }
  return out;
}

async function inventory(ctx) {
  const pins = await projectPins(ctx.projects);
  pins.python.push(...await toolVenvPins(ctx).catch(() => []));
  const parts = await Promise.all([nvm(ctx, pins), fnm(ctx, pins), volta(ctx, pins), pyenv(ctx, pins), uvPython(ctx, pins), conda(ctx), rustup(ctx, pins)].map((p) => p.catch(() => [])));
  return parts.flat();
}

module.exports = { NO_SCAN, projectsScanned, miseTools, pythonRanges, satisfiesPython, nvmDefault, pyenvVirtualenvs, pyenvBase, venvHome, toolVenvPins, cleanSpec, pinsFromFiles, projectPins, resolveSpec, protections, uvPythonDir, inventory, nvm, fnm, volta, pyenv, uvPython, conda, rustup, run };
