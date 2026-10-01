'use strict';
/**
 * IDE leftovers and per-version tool caches.
 *
 *   JetBrains   folders of IDE versions you have upgraded from (config,
 *               caches, logs, plugins), the same set as the IDE's own
 *               Help > Delete Leftover IDE Directories.
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

const JB_PRODUCTS = {
  IntelliJIdea: 'IntelliJ IDEA', IdeaIC: 'IntelliJ IDEA CE', PyCharm: 'PyCharm', PyCharmCE: 'PyCharm CE', WebStorm: 'WebStorm',
  PhpStorm: 'PhpStorm', GoLand: 'GoLand', CLion: 'CLion', Rider: 'Rider', RubyMine: 'RubyMine', DataGrip: 'DataGrip',
  DataSpell: 'DataSpell', RustRover: 'RustRover', Aqua: 'Aqua', AppCode: 'AppCode', Writerside: 'Writerside',
};
const JB_RE = new RegExp('^(' + Object.keys(JB_PRODUCTS).join('|') + ')(\\d{4}\\.\\d+)$');

function jetbrainsRoots(ctx) {
  const p = api(ctx);
  const env = ctx.env || {};
  if (ctx.platform === 'darwin') {
    const lib = (...x) => p.join(ctx.home, 'Library', ...x);
    return [lib('Application Support', 'JetBrains'), lib('Caches', 'JetBrains'), lib('Logs', 'JetBrains')];
  }
  if (ctx.platform === 'win32') return [env.APPDATA && p.join(env.APPDATA, 'JetBrains'), env.LOCALAPPDATA && p.join(env.LOCALAPPDATA, 'JetBrains')].filter(Boolean);
  return [p.join(absEnv(env, 'XDG_CONFIG_HOME') || p.join(ctx.home, '.config'), 'JetBrains'),
    p.join(absEnv(env, 'XDG_CACHE_HOME') || p.join(ctx.home, '.cache'), 'JetBrains'),
    p.join(absEnv(env, 'XDG_DATA_HOME') || p.join(ctx.home, '.local', 'share'), 'JetBrains')];
}

/** Old versions: { product, version, dirs: [{ root, dir }] } where a newer version of the product exists. */
function jetbrainsLeftovers(listing) {
  const byProduct = new Map();
  for (const { root, name } of listing) {
    const m = JB_RE.exec(name);
    if (!m) continue;
    const [, product, version] = m;
    if (!byProduct.has(product)) byProduct.set(product, new Map());
    const versions = byProduct.get(product);
    if (!versions.has(version)) versions.set(version, []);
    versions.get(version).push({ root, dir: path.join(root, name) });
  }
  const out = [];
  for (const [product, versions] of byProduct) {
    const sorted = [...versions.keys()].sort((a, b) => compareVersions(b, a));
    for (const v of sorted.slice(1)) out.push({ product, version: v, newest: sorted[0], dirs: versions.get(v) });
  }
  return out;
}

async function jetbrains(ctx) {
  const roots = jetbrainsRoots(ctx);
  const listing = [];
  for (const r of roots) for (const e of await listDir(r)) if (e.isDirectory()) listing.push({ root: r, name: e.name });
  const old = jetbrainsLeftovers(listing);
  if (!old.length) return [];
  const items = await pool(old, 3, async (o) => {
    let size = 0;
    for (const d of o.dirs) size += (await dirSize(d.dir)).bytes;
    const label = (JB_PRODUCTS[o.product] || o.product) + ' ' + o.version;
    const appName = (JB_PRODUCTS[o.product] || o.product).replace(/ CE$/, '');
    const running = ctx.procs && ctx.procs.ok ? ctx.procs.list.some((pr) => (pr.args || '').includes(appName) && (pr.args || '').includes(o.version)) : null;
    return makeItem({
      id: 'jetbrains:' + o.product + o.version,
      group: 'jetbrains',
      kind: 'ide',
      label,
      name: o.product,
      version: o.version,
      detail: 'Upgraded to ' + o.newest + ' · ' + o.dirs.length + (o.dirs.length === 1 ? ' folder' : ' folders'),
      size,
      blocked: running ? label + ' is still running.' : running === null ? 'Spaci could not check whether ' + label + ' is running.' : null,
      restoreHint: 'Nothing to restore: ' + o.newest + ' keeps its own settings and caches.',
      paths: o.dirs.map((d) => d.dir),
      removal: { type: 'paths', roots: o.dirs.map((d) => d.root), paths: o.dirs.map((d) => d.dir) },
    });
  });
  return [makeGroup({ id: 'jetbrains', section: 'dev', category: 'ide', title: 'JetBrains IDE leftovers', brand: 'intellij', icon: 'monitor', roots, items: items.sort((a, b) => b.size - a.size), note: 'Settings, caches, plugins and logs of IDE versions you have upgraded from, as in Help > Delete Leftover IDE Directories.' })];
}

// ---- VS Code and forks ----------------------------------------------------------

/** Extension folders safe to remove: listed in .obsolete, or an older version of an extension extensions.json points elsewhere. */
function staleExtensions(folders, extensionsJson, obsolete) {
  const active = new Set((Array.isArray(extensionsJson) ? extensionsJson : []).map((e) => e && e.relativeLocation).filter(Boolean));
  const activeIds = new Set((Array.isArray(extensionsJson) ? extensionsJson : []).map((e) => e && e.identifier && String(e.identifier.id || '').toLowerCase()).filter(Boolean));
  const obs = obsolete && typeof obsolete === 'object' ? obsolete : {};
  const out = [];
  for (const f of folders) {
    if (active.has(f)) continue; // never a folder VS Code says is installed
    const m = /^([a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-._]*?)-(\d+\.\d+\.\d+[^]*)$/i.exec(f);
    if (obs[f] === true) { out.push({ folder: f, id: m ? m[1] : f, reason: 'obsolete' }); continue; }
    if (m && activeIds.has(m[1].toLowerCase())) out.push({ folder: f, id: m[1], reason: 'replaced' });
  }
  return out;
}

const EDITORS = [
  { id: 'vscode', title: 'VS Code', dir: '.vscode', brand: 'vscode', proc: /Visual Studio Code\.app|[\\/]code(\.exe)?(\s|$)|Code\.exe/i },
  { id: 'vscode-insiders', title: 'VS Code Insiders', dir: '.vscode-insiders', brand: 'vscode', proc: /Insiders/i },
  { id: 'cursor-ext', title: 'Cursor', dir: '.cursor', brand: 'cursor', proc: /Cursor\.app|cursor(\.exe)?(\s|$)/i },
  { id: 'windsurf-ext', title: 'Windsurf', dir: '.windsurf', brand: 'windsurf', proc: /Windsurf\.app|windsurf(\.exe)?(\s|$)/i },
];

async function editorExtensions(ctx) {
  const p = api(ctx);
  const groups = [];
  for (const ed of EDITORS) {
    const root = ed.id === 'vscode' && absEnv(ctx.env, 'VSCODE_EXTENSIONS') ? ctx.env.VSCODE_EXTENSIONS : p.join(homeOf(ctx), ed.dir, 'extensions');
    const json = await readJson(p.join(root, 'extensions.json'), 16 * 1024 * 1024);
    if (!Array.isArray(json)) continue; // without the editor's own list, nothing is offered
    const obsolete = await readJson(p.join(root, '.obsolete'));
    const folders = (await listDir(root)).filter((e) => e.isDirectory()).map((e) => e.name);
    const stale = staleExtensions(folders, json, obsolete);
    if (!stale.length) continue;
    const items = await pool(stale, 4, async (s) => {
      const dir = p.join(root, s.folder);
      return makeItem({
        id: ed.id + ':' + s.folder,
        group: ed.id,
        kind: 'cache',
        label: s.folder,
        name: s.id,
        detail: s.reason === 'obsolete' ? ed.title + ' marked this version obsolete' : 'Replaced by a newer version',
        size: (await dirSize(dir)).bytes,
        restoreHint: 'Not needed: ' + ed.title + ' uses the newer version.',
        paths: [dir],
        removal: { type: 'paths', root, paths: [dir] },
      });
    });
    groups.push(makeGroup({ id: ed.id, section: 'dev', category: 'ide', title: ed.title + ' old extension versions', brand: ed.brand, icon: 'monitor', roots: [root], items: items.sort((a, b) => b.size - a.size), note: ed.title + ' keeps superseded extension versions until it cleans them up itself.' }));
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

module.exports = { jetbrainsLeftovers, staleExtensions, jetbrains, editorExtensions, playwright, puppeteer, cypress, electronCache, terraform, gradleWrapper, homebrew, inventory, run };
