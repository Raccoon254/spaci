'use strict';
/**
 * IDE leftovers and per-version tool caches.
 *
 *   JetBrains   caches, logs and plugins of IDE versions that are no longer
 *               installed and unused for 180 days. Settings, scratches and
 *               consoles are never deleted (see the JetBrains section).
 *   VS Code     extension versions VS Code itself marked obsolete (.obsolete)
 *               or replaced by a newer version in extensions.json. Cursor,
 *               Windsurf and Insiders keep the same layout.
 *   Playwright, Puppeteer, Cypress, Electron: browser and binary downloads,
 *               one item per version.
 *   Terraform   provider plugin cache, one item per provider version.
 *   Homebrew    formula versions `brew cleanup` would remove, per formula.
 *   Gradle      wrapper distributions, one per Gradle version.
 */

const path = require('path');
const { run, listDir, lstatSafe, readText, readJson, dirSize, pool, absEnv, compareVersions } = require('./util');
const { makeGroup, makeItem } = require('./model');

function api(ctx) { return ctx.platform === 'win32' ? path.win32 : path.posix; }
function homeOf(ctx) { return ctx.platform === 'win32' ? (ctx.env.USERPROFILE || ctx.home) : ctx.home; }

// ---- JetBrains -----------------------------------------------------------------
//
// Each IDE version keeps folders named <Product><year>.<n> under a config root
// (settings, scratches, consoles, and plugins on macOS and Windows), a caches
// root, a logs root and, on Linux, a data root (plugins). Spaci offers one
// version's folders only when:
//   - that version is not installed (Toolbox's state.json, the installed
//     apps' product-info.json or Info.plist, the Windows registry and install
//     folders, Toolbox's and ~/.local/share/JetBrains on Linux);
//   - a newer version of the same product has folders too;
//   - nothing in them changed for 180 days (JetBrains' own leftover cleanup
//     uses about the same span);
//   - no running IDE uses them: a process is matched by its
//     idea.paths.selector or its install path, never by version text.
// From the config folder it takes only plugins/: settings, scratches/ and
// consoles/ are the user's own files and are never deleted here.

const JB_PRODUCTS = {
  IntelliJIdea: 'IntelliJ IDEA', IdeaIC: 'IntelliJ IDEA CE', PyCharm: 'PyCharm', PyCharmCE: 'PyCharm CE', WebStorm: 'WebStorm',
  PhpStorm: 'PhpStorm', GoLand: 'GoLand', CLion: 'CLion', Rider: 'Rider', RubyMine: 'RubyMine', DataGrip: 'DataGrip',
  DataSpell: 'DataSpell', RustRover: 'RustRover', Aqua: 'Aqua', AppCode: 'AppCode', Writerside: 'Writerside',
};
const JB_RE = new RegExp('^(' + Object.keys(JB_PRODUCTS).join('|') + ')(\\d{4}\\.\\d+)$');
// Product codes in build numbers ("IU-253.28294.334") and Toolbox's state.json.
const JB_CODES = {
  IU: 'IntelliJIdea', IC: 'IdeaIC', PY: 'PyCharm', PC: 'PyCharmCE', WS: 'WebStorm', PS: 'PhpStorm', GO: 'GoLand', CL: 'CLion',
  RD: 'Rider', RM: 'RubyMine', DB: 'DataGrip', DS: 'DataSpell', RR: 'RustRover', QA: 'Aqua', OC: 'AppCode', WRS: 'Writerside',
};
// Launcher names (Contents/MacOS/<x>, bin/<x>.sh, bin/<x>64.exe) and the products they start.
const JB_LAUNCHERS = {
  idea: ['IntelliJIdea', 'IdeaIC'], pycharm: ['PyCharm', 'PyCharmCE'], webstorm: ['WebStorm'], phpstorm: ['PhpStorm'], goland: ['GoLand'],
  clion: ['CLion'], rider: ['Rider'], rubymine: ['RubyMine'], datagrip: ['DataGrip'], dataspell: ['DataSpell'], rustrover: ['RustRover'],
  aqua: ['Aqua'], appcode: ['AppCode'], writerside: ['Writerside'],
};
const JB_LAUNCHER_RE = new RegExp('(?:^|[\\\\/"\'\\s])(' + Object.keys(JB_LAUNCHERS).join('|') + ')(?:64)?(?:\\.exe|\\.sh)?(?=$|[\\s"\'])', 'i');
const JB_UNUSED_DAYS = 180;
const DAY = 24 * 3600 * 1000;

/** "IU-253.28294.334" (or code "IU" and build "253.28294") -> "IntelliJIdea2025.3". */
function jbDirFromBuild(code, build) {
  let c = code;
  let b = String(build || '');
  const m = /^([A-Z]{2,3})-(\d{3})/.exec(b);
  if (m) { c = c || m[1]; b = m[2]; }
  const product = JB_CODES[String(c || '').toUpperCase()];
  const branch = /^(\d{2})(\d)/.exec(b);
  return product && branch ? product + '20' + branch[1] + '.' + branch[2] : null;
}

/** The data folder name of an install, from product-info.json, else Info.plist (macOS). */
async function jbInstallDir(ctx, install) {
  const p = api(ctx);
  const mac = /\.app[\\/]?$/i.test(install);
  const info = await readJson(mac ? p.join(install, 'Contents', 'Resources', 'product-info.json') : p.join(install, 'product-info.json'), 1024 * 1024);
  if (info && typeof info.dataDirectoryName === 'string' && JB_RE.test(info.dataDirectoryName)) return info.dataDirectoryName;
  if (info) { const d = jbDirFromBuild(info.productCode, info.buildNumber); if (d) return d; }
  if (mac) {
    const plist = await readText(p.join(install, 'Contents', 'Info.plist'), 1024 * 1024);
    const m = plist && /<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
    if (m) return jbDirFromBuild(null, m[1].trim());
  }
  return null;
}

/** Folders that may be IDE installs, by OS. ctx.jetbrainsAppDirs overrides the system ones (tests). */
function jbInstallParents(ctx) {
  const p = api(ctx);
  const env = ctx.env || {};
  const h = homeOf(ctx);
  if (Array.isArray(ctx.jetbrainsAppDirs)) return ctx.jetbrainsAppDirs.map((d) => ({ dir: d, depth: 4 }));
  if (ctx.platform === 'darwin') {
    return [{ dir: '/Applications', depth: 1 }, { dir: p.join(h, 'Applications'), depth: 2 },
      { dir: p.join(h, 'Library', 'Application Support', 'JetBrains', 'Toolbox', 'apps'), depth: 4 }];
  }
  if (ctx.platform === 'win32') {
    return [env.ProgramFiles && p.join(env.ProgramFiles, 'JetBrains'), env['ProgramFiles(x86)'] && p.join(env['ProgramFiles(x86)'], 'JetBrains'),
      env.LOCALAPPDATA && p.join(env.LOCALAPPDATA, 'Programs'), env.LOCALAPPDATA && p.join(env.LOCALAPPDATA, 'JetBrains', 'Toolbox', 'apps')]
      .filter(Boolean).map((d) => ({ dir: d, depth: 4 }));
  }
  const data = absEnv(env, 'XDG_DATA_HOME') || p.join(ctx.home, '.local', 'share');
  return [{ dir: p.join(data, 'JetBrains'), depth: 4 }, { dir: '/opt', depth: 2 }, { dir: '/snap', depth: 2 }];
}

/** Installs under a folder: dirs holding product-info.json, or *.app bundles on macOS. */
async function findInstalls(ctx, dir, depth, out, budget) {
  if (depth < 0 || budget.n <= 0) return;
  const p = api(ctx);
  for (const e of await listDir(dir)) {
    if (--budget.n <= 0) return;
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const full = p.join(dir, e.name);
    if (ctx.platform === 'darwin' ? /\.app$/i.test(e.name) : await lstatSafe(p.join(full, 'product-info.json'))) { out.push(full); continue; }
    if (e.isDirectory()) await findInstalls(ctx, full, depth - 1, out, budget);
  }
}

/** Toolbox's own list of what it installed. -> { tools: [...], error } */
async function toolboxState(ctx) {
  const p = api(ctx);
  const env = ctx.env || {};
  const file = ctx.platform === 'darwin' ? p.join(ctx.home, 'Library', 'Application Support', 'JetBrains', 'Toolbox', 'state.json')
    : ctx.platform === 'win32' ? (env.LOCALAPPDATA ? p.join(env.LOCALAPPDATA, 'JetBrains', 'Toolbox', 'state.json') : null)
      : p.join(absEnv(env, 'XDG_DATA_HOME') || p.join(ctx.home, '.local', 'share'), 'JetBrains', 'Toolbox', 'state.json');
  if (!file || !(await lstatSafe(file))) return { tools: [], error: null };
  const json = await readJson(file, 16 * 1024 * 1024);
  if (!json || !Array.isArray(json.tools)) return { tools: [], error: 'Spaci could not read JetBrains Toolbox\'s list of installed IDEs, so it keeps every IDE folder.' };
  return { tools: json.tools.filter((t) => t && typeof t === 'object'), error: null };
}

/** Install paths named in the Windows registry under Software\JetBrains. */
async function registryInstalls(ctx) {
  if (ctx.platform !== 'win32') return [];
  const out = [];
  for (const key of ['HKCU\\Software\\JetBrains', 'HKLM\\SOFTWARE\\JetBrains', 'HKLM\\SOFTWARE\\WOW6432Node\\JetBrains']) {
    const res = await run('reg', ['query', key, '/s'], { exec: ctx.exec, timeout: 10000 });
    if (!res.ok) continue;
    for (const m of res.stdout.matchAll(/REG_(?:EXPAND_)?SZ\s+([A-Za-z]:\\[^\r\n]*?)\s*$/gm)) out.push(m[1].replace(/\\bin\\[^\\]+\.exe$/i, ''));
  }
  return out;
}

/** -> { dirs: Set(dataDirName), installs: [{ path, dir }], error } */
async function jetbrainsInstalls(ctx) {
  const state = await toolboxState(ctx);
  const dirs = new Set();
  const installs = [];
  const candidates = [];
  for (const t of state.tools) {
    const d = jbDirFromBuild(t.productCode, t.buildNumber);
    if (d) dirs.add(d);
    if (typeof t.installLocation === 'string' && t.installLocation) candidates.push(t.installLocation);
  }
  const budget = { n: 5000 };
  for (const { dir, depth } of jbInstallParents(ctx)) await findInstalls(ctx, dir, depth, candidates, budget);
  candidates.push(...await registryInstalls(ctx));
  for (const c of Array.from(new Set(candidates))) {
    const d = await jbInstallDir(ctx, c);
    if (!d) continue;
    dirs.add(d);
    installs.push({ path: c, dir: d });
  }
  return { dirs, installs, error: state.error };
}

/**
 * Which IDE folders running processes use. -> { dirs: Set, products: Set,
 * all: bool } where products are those with a running launcher Spaci could
 * not tie to a version, and all means it could not check.
 */
async function jetbrainsRunning(ctx, installs) {
  const out = { dirs: new Set(), products: new Set(), all: false };
  if (!ctx.procs || !ctx.procs.ok) { out.all = true; return out; }
  const p = api(ctx);
  for (const pr of ctx.procs.list) {
    const args = String(pr.args || '');
    const sel = /-Didea\.paths\.selector=([^\s"']+)/.exec(args);
    if (sel) { out.dirs.add(sel[1]); continue; }
    const inst = installs.find((i) => args.includes(i.path + p.sep) || args.includes(i.path + '/') || args.startsWith(i.path + ' ') || args === i.path);
    if (inst) { out.dirs.add(inst.dir); continue; }
    const l = JB_LAUNCHER_RE.exec(args);
    if (!l || !/Contents[\\/]MacOS|[\\/]bin[\\/]/.test(args)) continue;
    // A launcher from an install Spaci did not list: read the install itself.
    const app = /^(.*?\.app)[\\/]Contents[\\/]MacOS[\\/]/i.exec(args) || /^"?(.*?)[\\/]bin[\\/][^\\/]+$/i.exec(args.split(/\s+-/)[0].trim());
    const d = app ? await jbInstallDir(ctx, app[1].replace(/^"/, '')) : null;
    if (d) out.dirs.add(d);
    else for (const prod of JB_LAUNCHERS[l[1].toLowerCase()] || []) out.products.add(prod);
  }
  return out;
}

function jetbrainsRoots(ctx) {
  const p = api(ctx);
  const env = ctx.env || {};
  if (ctx.platform === 'darwin') {
    const lib = (...x) => p.join(ctx.home, 'Library', ...x);
    return [{ root: lib('Application Support', 'JetBrains'), config: true }, { root: lib('Caches', 'JetBrains') }, { root: lib('Logs', 'JetBrains') }];
  }
  if (ctx.platform === 'win32') return [env.APPDATA && { root: p.join(env.APPDATA, 'JetBrains'), config: true }, env.LOCALAPPDATA && { root: p.join(env.LOCALAPPDATA, 'JetBrains') }].filter(Boolean);
  return [{ root: p.join(absEnv(env, 'XDG_CONFIG_HOME') || p.join(ctx.home, '.config'), 'JetBrains'), config: true },
    { root: p.join(absEnv(env, 'XDG_CACHE_HOME') || p.join(ctx.home, '.cache'), 'JetBrains') },
    { root: p.join(absEnv(env, 'XDG_DATA_HOME') || p.join(ctx.home, '.local', 'share'), 'JetBrains') }];
}

/** Old versions: { product, version, newest, dirs: [{ root, dir, config }] } where a newer version of the product exists. */
function jetbrainsLeftovers(listing) {
  const byProduct = new Map();
  for (const { root, name, config } of listing) {
    const m = JB_RE.exec(name);
    if (!m) continue;
    const [, product, version] = m;
    if (!byProduct.has(product)) byProduct.set(product, new Map());
    const versions = byProduct.get(product);
    if (!versions.has(version)) versions.set(version, []);
    versions.get(version).push({ root, dir: path.join(root, name), config: Boolean(config) });
  }
  const out = [];
  for (const [product, versions] of byProduct) {
    const sorted = [...versions.keys()].sort((a, b) => compareVersions(b, a));
    for (const v of sorted.slice(1)) out.push({ product, version: v, newest: sorted[0], dirs: versions.get(v) });
  }
  return out;
}

/** Newest mtime under some folders, depth-limited. complete is false when the budget ran out. */
async function newestChange(dirs, { maxEntries = 20000, depth = 4, deadline = Date.now() + 5000 } = {}) {
  let newest = 0;
  let n = 0;
  let complete = true;
  const walk = async (d, left) => {
    const st = await lstatSafe(d);
    if (!st) return;
    newest = Math.max(newest, st.mtimeMs);
    if (!st.isDirectory() || left < 0) return;
    for (const e of await listDir(d)) {
      if (++n > maxEntries || Date.now() > deadline) { complete = false; return; }
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full, left - 1);
      else { const s2 = await lstatSafe(full); if (s2) newest = Math.max(newest, s2.mtimeMs); }
    }
  };
  for (const d of dirs) await walk(d, depth);
  return { newest, complete };
}

async function jetbrains(ctx) {
  const p = api(ctx);
  const roots = jetbrainsRoots(ctx);
  const listing = [];
  for (const r of roots) for (const e of await listDir(r.root)) if (e.isDirectory()) listing.push({ root: r.root, name: e.name, config: r.config });
  const old = jetbrainsLeftovers(listing);
  if (!old.length) return [];
  const installed = await jetbrainsInstalls(ctx);
  const running = await jetbrainsRunning(ctx, installed.installs);
  const now = ctx.now || Date.now();
  const items = await pool(old, 3, async (o) => {
    const dirName = o.product + o.version;
    if (installed.dirs.has(dirName)) return null; // still installed: its folders are in use
    // What may go: caches, logs and plugin folders. From the config folder,
    // only plugins/ (settings, scratches and consoles stay).
    const targets = [];
    for (const d of o.dirs) {
      if (!d.config) { targets.push(d); continue; }
      const plugins = p.join(d.dir, 'plugins');
      const st = await lstatSafe(plugins);
      if (st && st.isDirectory()) targets.push({ root: d.root, dir: plugins });
    }
    if (!targets.length) return null;
    let size = 0;
    for (const d of targets) size += (await dirSize(d.dir)).bytes;
    const label = (JB_PRODUCTS[o.product] || o.product) + ' ' + o.version;
    // Age counts every folder of the version, settings included.
    const age = await newestChange(o.dirs.map((d) => d.dir));
    const days = Math.floor((now - age.newest) / DAY);
    let blocked = null;
    let state = 'idle';
    if (installed.error) blocked = installed.error;
    else if (running.all) blocked = 'Spaci could not check whether ' + label + ' is running.';
    else if (running.dirs.has(dirName)) { blocked = label + ' is running.'; state = 'running'; }
    else if (running.products.has(o.product)) blocked = (JB_PRODUCTS[o.product] || o.product) + ' is running and Spaci could not tell which version, so it keeps these folders.';
    else if (!age.complete) blocked = 'Spaci could not tell when ' + label + ' was last used, so it keeps these folders.';
    else if (days < JB_UNUSED_DAYS) blocked = 'Used ' + (days <= 0 ? 'today' : days + (days === 1 ? ' day' : ' days') + ' ago') + '. Spaci offers an old IDE version\'s folders after ' + JB_UNUSED_DAYS + ' days unused.';
    return makeItem({
      id: 'jetbrains:' + dirName,
      group: 'jetbrains',
      kind: 'ide',
      label,
      name: o.product,
      version: o.version,
      detail: 'Not installed, newest is ' + o.newest + ' · caches, logs and plugins · settings and scratch files stay',
      size,
      state,
      modifiedAt: age.newest || null,
      blocked,
      restoreHint: 'Nothing to restore: ' + o.newest + ' keeps its own settings and caches.',
      paths: targets.map((d) => d.dir),
      removal: { type: 'paths', roots: targets.map((d) => d.root), paths: targets.map((d) => d.dir) },
    });
  });
  const list = items.filter(Boolean);
  if (!list.length) return [];
  return [makeGroup({ id: 'jetbrains', section: 'dev', category: 'ide', title: 'JetBrains IDE leftovers', brand: 'intellij', icon: 'monitor', roots: roots.map((r) => r.root), items: list.sort((a, b) => b.size - a.size), note: 'Caches, logs and plugins of IDE versions that are no longer installed and unused for ' + JB_UNUSED_DAYS + ' days. Settings, scratch files and consoles are never deleted here.' })];
}

// ---- VS Code and forks ----------------------------------------------------------
//
// Extensions live in one shared folder (~/.vscode/extensions), but every
// profile has its own manifest: the default profile's is
// extensions/extensions.json, the others' are
// <user data>/User/profiles/<id>/extensions.json. A folder any manifest names
// is in use. Spaci offers only folders the editor marked .obsolete, and
// versions strictly older than every version a manifest uses.

/** The folder a manifest entry points at. */
function entryFolder(e) {
  if (!e || typeof e !== 'object') return null;
  if (typeof e.relativeLocation === 'string' && e.relativeLocation) return e.relativeLocation;
  const loc = e.location;
  const p = loc && (typeof loc === 'string' ? loc : loc.fsPath || loc.path);
  return typeof p === 'string' && p ? p.split(/[\\/]/).filter(Boolean).pop() : null;
}

const EXT_FOLDER_RE = /^([a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-._]*?)-(\d+\.\d+\.\d+[^]*)$/i;

/**
 * Extension folders safe to remove: listed in .obsolete, or a version older
 * than every version any profile uses. `manifests` is one extensions.json or
 * a list of them (one per profile); a folder any of them names is never offered.
 */
function staleExtensions(folders, manifests, obsolete) {
  const lists = Array.isArray(manifests) && manifests.length && manifests.every((m) => Array.isArray(m)) ? manifests : [Array.isArray(manifests) ? manifests : []];
  const entries = lists.flat();
  const active = new Set(entries.map(entryFolder).filter(Boolean));
  const activeVersions = new Map(); // id -> [versions in use]
  for (const e of entries) {
    const id = e && e.identifier && String(e.identifier.id || '').toLowerCase();
    if (!id) continue;
    const m = EXT_FOLDER_RE.exec(entryFolder(e) || '');
    const v = (m && /^\d+\.\d+\.\d+/.exec(m[2])) ? /^\d+\.\d+\.\d+/.exec(m[2])[0] : (typeof e.version === 'string' ? e.version : null);
    if (!activeVersions.has(id)) activeVersions.set(id, []);
    if (v) activeVersions.get(id).push(v);
  }
  const obs = obsolete && typeof obsolete === 'object' ? obsolete : {};
  const out = [];
  for (const f of folders) {
    if (active.has(f)) continue; // never a folder any profile says is installed
    const m = EXT_FOLDER_RE.exec(f);
    if (obs[f] === true) { out.push({ folder: f, id: m ? m[1] : f, reason: 'obsolete' }); continue; }
    if (!m) continue;
    const inUse = activeVersions.get(m[1].toLowerCase());
    const mine = /^\d+\.\d+\.\d+/.exec(m[2]);
    // Strictly older than every version in use; an unknown version is never "older".
    if (inUse && inUse.length && mine && inUse.every((v) => compareVersions(mine[0], v) < 0)) out.push({ folder: f, id: m[1], reason: 'replaced' });
  }
  return out;
}

const EDITORS = [
  { id: 'vscode', title: 'VS Code', dir: '.vscode', data: 'Code', brand: 'vscode', proc: /Visual Studio Code\.app|[\\/]code(\.exe)?(\s|$)|Code\.exe/i },
  { id: 'vscode-insiders', title: 'VS Code Insiders', dir: '.vscode-insiders', data: 'Code - Insiders', brand: 'vscode', proc: /Insiders/i },
  { id: 'cursor-ext', title: 'Cursor', dir: '.cursor', data: 'Cursor', brand: 'cursor', proc: /Cursor\.app|cursor(\.exe)?(\s|$)/i },
  { id: 'windsurf-ext', title: 'Windsurf', dir: '.windsurf', data: 'Windsurf', brand: 'windsurf', proc: /Windsurf\.app|windsurf(\.exe)?(\s|$)/i },
];

/** An editor's user data folder (where User/profiles lives). */
function editorDataDir(ctx, name) {
  const p = api(ctx);
  const env = ctx.env || {};
  if (ctx.platform === 'darwin') return p.join(ctx.home, 'Library', 'Application Support', name);
  if (ctx.platform === 'win32') return env.APPDATA ? p.join(env.APPDATA, name) : null;
  return p.join(absEnv(env, 'XDG_CONFIG_HOME') || p.join(ctx.home, '.config'), name);
}

/** Every profile's extensions.json, or null when one exists but cannot be read. */
async function profileManifests(ctx, name) {
  const p = api(ctx);
  const data = editorDataDir(ctx, name);
  if (!data) return [];
  const out = [];
  const root = p.join(data, 'User', 'profiles');
  for (const e of await listDir(root)) {
    if (!e.isDirectory()) continue;
    const file = p.join(root, e.name, 'extensions.json');
    if (!(await lstatSafe(file))) continue;
    const json = await readJson(file, 16 * 1024 * 1024);
    if (!Array.isArray(json)) return null;
    out.push(json);
  }
  return out;
}

async function editorExtensions(ctx) {
  const p = api(ctx);
  const groups = [];
  for (const ed of EDITORS) {
    const root = ed.id === 'vscode' && absEnv(ctx.env, 'VSCODE_EXTENSIONS') ? ctx.env.VSCODE_EXTENSIONS : p.join(homeOf(ctx), ed.dir, 'extensions');
    const json = await readJson(p.join(root, 'extensions.json'), 16 * 1024 * 1024);
    if (!Array.isArray(json)) continue; // without the editor's own list, nothing is offered
    const profiles = await profileManifests(ctx, ed.data);
    if (profiles === null) continue; // a profile list Spaci cannot read: offer nothing
    const obsolete = await readJson(p.join(root, '.obsolete'));
    const folders = (await listDir(root)).filter((e) => e.isDirectory()).map((e) => e.name);
    const stale = staleExtensions(folders, [json, ...profiles], obsolete);
    if (!stale.length) continue;
    const items = await pool(stale, 4, async (s) => {
      const dir = p.join(root, s.folder);
      return makeItem({
        id: ed.id + ':' + s.folder,
        group: ed.id,
        kind: 'cache',
        label: s.folder,
        name: s.id,
        detail: s.reason === 'obsolete' ? ed.title + ' marked this version obsolete' : 'Older than the version every profile uses',
        size: (await dirSize(dir)).bytes,
        restoreHint: 'Not needed: ' + ed.title + ' uses the newer version.',
        paths: [dir],
        removal: { type: 'paths', root, paths: [dir] },
      });
    });
    groups.push(makeGroup({ id: ed.id, section: 'dev', category: 'ide', title: ed.title + ' old extension versions', brand: ed.brand, icon: 'monitor', roots: [root], items: items.sort((a, b) => b.size - a.size), note: ed.title + ' keeps superseded extension versions until it cleans them up itself. Versions any profile uses are never listed.' }));
  }
  return groups;
}

// ---- per-version download caches ------------------------------------------------

function cacheBase(ctx) {
  const p = api(ctx);
  if (ctx.platform === 'darwin') return p.join(ctx.home, 'Library', 'Caches');
  if (ctx.platform === 'win32') return ctx.env.LOCALAPPDATA || null;
  return absEnv(ctx.env, 'XDG_CACHE_HOME') || p.join(ctx.home, '.cache');
}

/** A cache folder whose children are versions: one item per child. */
async function versionedCache(ctx, spec) {
  const p = api(ctx);
  const st = spec.root ? await lstatSafe(spec.root) : null;
  if (!st || !st.isDirectory()) return [];
  const entries = (await listDir(spec.root)).filter((e) => (spec.files ? e.isFile() || e.isDirectory() : e.isDirectory()) && !e.name.startsWith('.') && (!spec.match || spec.match(e.name)));
  if (!entries.length) return [];
  const running = spec.procRe && ctx.procs ? (ctx.procs.ok ? ctx.procs.list.some((pr) => spec.procRe.test(pr.args || '')) : null) : false;
  const items = await pool(entries, 4, async (e) => {
    const dir = p.join(spec.root, e.name);
    const size = (await dirSize(dir)).bytes;
    if (!size) return null;
    const s = await lstatSafe(dir);
    // @electron/get keeps each zip in a folder named by a hash of its URL.
    let inner = null;
    if (spec.innerName && e.isDirectory()) inner = ((await listDir(dir)).find((f) => f.isFile()) || {}).name || null;
    return makeItem({
      id: spec.id + ':' + e.name,
      group: spec.id,
      kind: 'cache',
      label: spec.label ? spec.label(inner || e.name) : e.name,
      name: e.name,
      detail: spec.detail ? spec.detail(e.name, inner) : '',
      size,
      modifiedAt: s ? s.mtimeMs : null,
      blocked: running ? spec.title + ' is running.' : running === null ? 'Spaci could not check whether ' + spec.title + ' is running.' : null,
      restoreHint: spec.restore(e.name),
      paths: [dir],
      removal: { type: 'paths', root: spec.root, paths: [dir] },
    });
  });
  const list = items.filter(Boolean);
  if (!list.length) return [];
  return [makeGroup({ id: spec.id, section: 'dev', category: 'caches', title: spec.title, tech: spec.tech, icon: 'driver', roots: [spec.root], items: list.sort((a, b) => b.size - a.size), note: spec.note || null })];
}

function playwright(ctx) {
  const p = api(ctx);
  const env = ctx.env || {};
  const custom = env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== '0' ? absEnv(env, 'PLAYWRIGHT_BROWSERS_PATH') : null;
  const base = cacheBase(ctx);
  return versionedCache(ctx, {
    id: 'playwright', title: 'Playwright browsers', tech: 'playwright', root: custom || (base && p.join(base, 'ms-playwright')),
    match: (n) => /^[a-z_]+-\d+$/i.test(n),
    label: (n) => n.replace(/_/g, ' ').replace(/-(\d+)$/, ' build $1'),
    restore: () => 'npx playwright install',
    note: 'Browsers Playwright downloaded. npx playwright install fetches the ones your installed Playwright needs.',
  });
}

function puppeteer(ctx) {
  const p = api(ctx);
  const root = absEnv(ctx.env, 'PUPPETEER_CACHE_DIR') || p.join(homeOf(ctx), '.cache', 'puppeteer');
  return versionedCache(ctx, {
    id: 'puppeteer', title: 'Puppeteer browsers', root, label: (n) => n, restore: () => 'npx puppeteer browsers install chrome',
  });
}

function cypress(ctx) {
  const p = api(ctx);
  const base = cacheBase(ctx);
  const root = absEnv(ctx.env, 'CYPRESS_CACHE_FOLDER') || (ctx.platform === 'win32' ? base && p.join(base, 'Cypress', 'Cache') : base && p.join(base, 'Cypress'));
  return versionedCache(ctx, {
    id: 'cypress', title: 'Cypress binaries', tech: 'cypress', root, match: (n) => /^\d+\.\d+\.\d+/.test(n),
    label: (n) => 'Cypress ' + n, restore: (n) => 'npx cypress install (or install cypress@' + n + ')',
    procRe: /Cypress\.app|[\\/]Cypress(\.exe)?(\s|$)/,
  });
}

function electronCache(ctx) {
  const p = api(ctx);
  const base = cacheBase(ctx);
  const root = absEnv(ctx.env, 'electron_config_cache') || (ctx.platform === 'win32' ? base && p.join(base, 'electron', 'Cache') : base && p.join(base, 'electron'));
  return versionedCache(ctx, {
    id: 'electron-cache', title: 'Electron downloads', tech: 'electron', root, files: true, innerName: true,
    label: (n) => (/\.zip$/.test(n) ? n.replace(/\.zip$/, '') : 'Cached download ' + n.slice(0, 12)),
    detail: (n, inner) => (inner ? 'Cache folder ' + n.slice(0, 8) : 'Downloaded zip'),
    restore: () => 'Downloaded again the next time a project installs that Electron version.',
  });
}

async function terraform(ctx) {
  const p = api(ctx);
  let root = absEnv(ctx.env, 'TF_PLUGIN_CACHE_DIR');
  if (!root) {
    const rc = await readText(p.join(homeOf(ctx), ctx.platform === 'win32' ? 'terraform.rc' : '.terraformrc'), 64 * 1024);
    const m = rc && /plugin_cache_dir\s*=\s*"([^"]+)"/.exec(rc);
    if (m) root = m[1].replace(/^\$HOME|^~/, homeOf(ctx));
  }
  if (!root) return [];
  // <host>/<namespace>/<type>/<version>/<os_arch>
  const items = [];
  for (const host of await listDir(root)) {
    if (!host.isDirectory()) continue;
    for (const ns of await listDir(p.join(root, host.name))) {
      if (!ns.isDirectory()) continue;
      for (const type of await listDir(p.join(root, host.name, ns.name))) {
        if (!type.isDirectory()) continue;
        for (const ver of await listDir(p.join(root, host.name, ns.name, type.name))) {
          if (!ver.isDirectory()) continue;
          const dir = p.join(root, host.name, ns.name, type.name, ver.name);
          items.push(makeItem({
            id: 'terraform:' + [host.name, ns.name, type.name, ver.name].join('/'),
            group: 'terraform', kind: 'cache',
            label: ns.name + '/' + type.name + ' ' + ver.name,
            name: type.name, version: ver.name, detail: host.name,
            size: (await dirSize(dir)).bytes,
            restoreHint: 'terraform init downloads it again.',
            paths: [dir],
            removal: { type: 'paths', root, paths: [dir] },
          }));
        }
      }
    }
  }
  if (!items.length) return [];
  return [makeGroup({ id: 'terraform', section: 'dev', category: 'caches', title: 'Terraform provider cache', tech: 'terraform', icon: 'driver', roots: [root], items: items.sort((a, b) => b.size - a.size) })];
}

async function gradleWrapper(ctx) {
  const p = api(ctx);
  const gHome = absEnv(ctx.env, 'GRADLE_USER_HOME') || p.join(homeOf(ctx), '.gradle');
  const root = p.join(gHome, 'wrapper', 'dists');
  // Versions projects still ask for, from gradle-wrapper.properties.
  const wanted = new Set();
  await pool((ctx.projects || []).slice(0, 600), 8, async (proj) => {
    const t = await readText(p.join(proj, 'gradle', 'wrapper', 'gradle-wrapper.properties'), 64 * 1024);
    const m = t && /distributionUrl=.*?(gradle-[\d.]+(?:-rc-?\d+)?-(?:bin|all))\.zip/.exec(t);
    if (m) wanted.add(m[1]);
  });
  const running = ctx.procs ? (ctx.procs.ok ? ctx.procs.list.filter((pr) => /GradleDaemon|GradleWrapperMain|gradle-launcher/.test(pr.args || '')).map((pr) => pr.args) : null) : [];
  const groups = await versionedCache(ctx, {
    id: 'gradle-dists', title: 'Gradle wrapper distributions', tech: 'gradle', root, match: (n) => /^gradle-/.test(n),
    label: (n) => n.replace(/^gradle-/, 'Gradle ').replace(/-(bin|all)$/, ' ($1)'),
    detail: (n) => (wanted.has(n) ? 'A scanned project uses this version' : 'No scanned project uses it'),
    restore: () => './gradlew downloads it again on the next build.',
  });
  for (const g of groups) {
    for (const it of g.items) {
      if (running === null) it.blocked = 'Spaci could not check whether Gradle is running.';
      else if (running.some((a) => a.includes(it.name))) { it.blocked = 'A Gradle daemon from this version is running.'; it.badges.push({ text: 'Running', kind: 'running' }); }
      else if (wanted.has(it.name)) { it.badges.push({ text: 'Used by a project', kind: 'info' }); }
    }
  }
  return groups;
}

// ---- Homebrew -------------------------------------------------------------------

async function homebrew(ctx) {
  if (ctx.platform === 'win32') return [];
  const p = api(ctx);
  const prefixes = ctx.platform === 'darwin' ? ['/opt/homebrew', '/usr/local'] : ['/home/linuxbrew/.linuxbrew', p.join(ctx.home, '.linuxbrew')];
  const items = [];
  for (const prefix of prefixes) {
    const cellar = p.join(prefix, 'Cellar');
    const formulae = (await listDir(cellar)).filter((e) => e.isDirectory());
    if (!formulae.length) continue;
    await pool(formulae, 8, async (f) => {
      const versions = (await listDir(p.join(cellar, f.name))).filter((e) => e.isDirectory()).map((e) => e.name);
      if (versions.length < 2) return;
      let linked = null;
      try { linked = path.basename(require('fs').readlinkSync(p.join(prefix, 'opt', f.name))); } catch { linked = null; }
      if (!linked || !versions.includes(linked)) return; // unclear which is current: leave it
      if (await lstatSafe(p.join(prefix, 'var', 'homebrew', 'pinned', f.name))) return; // brew cleanup skips pinned formulae
      const old = versions.filter((v) => v !== linked);
      let size = 0;
      for (const v of old) size += (await dirSize(p.join(cellar, f.name, v))).bytes;
      const dirs = old.map((v) => p.join(cellar, f.name, v));
      const running = ctx.procs && ctx.procs.ok ? ctx.procs.list.some((pr) => dirs.some((d) => (pr.args || '').includes(d + '/'))) : null;
      items.push(makeItem({
        id: 'brew:' + prefix + ':' + f.name,
        group: 'homebrew',
        kind: 'cache',
        label: f.name + ' ' + old.join(', '),
        name: f.name,
        detail: 'Older versions (current: ' + linked + ')',
        size,
        blocked: running ? 'A running program uses one of these versions.' : running === null ? 'Spaci could not check whether a program uses these versions.' : null,
        restoreHint: 'Not needed: ' + f.name + ' ' + linked + ' stays installed.',
        paths: dirs,
        removal: { type: 'command', cmd: p.join(prefix, 'bin', 'brew'), args: ['cleanup', '--prune=all', f.name], env: { HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1' }, timeout: 180000, expectGone: dirs },
      }));
    });
  }
  if (!items.length) return [];
  return [makeGroup({ id: 'homebrew', section: 'dev', category: 'caches', title: 'Homebrew old versions', icon: 'driver', roots: prefixes, items: items.sort((a, b) => b.size - a.size), note: 'Removed with brew cleanup <formula>, which also drops that formula\'s old downloads.' })];
}

async function inventory(ctx) {
  const parts = await Promise.all([jetbrains(ctx), editorExtensions(ctx), playwright(ctx), puppeteer(ctx), cypress(ctx), electronCache(ctx), terraform(ctx), gradleWrapper(ctx), homebrew(ctx)].map((pr) => pr.catch(() => [])));
  return parts.flat();
}

module.exports = { entryFolder, profileManifests, registryInstalls, jbDirFromBuild, jbInstallDir, jetbrainsInstalls, jetbrainsRunning, newestChange, JB_UNUSED_DAYS, jetbrainsLeftovers, staleExtensions, jetbrains, editorExtensions, playwright, puppeteer, cypress, electronCache, terraform, gradleWrapper, homebrew, inventory, run };
