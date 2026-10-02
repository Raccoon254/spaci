'use strict';
/**
 * Runs a developer tool's own cleanup command for a cache target (the specs in
 * native-cleanup-specs.js), in the scan worker:
 *
 *   1. refuse at once when the tool is busy: a process of it runs, or another
 *      process holds its cache lock file open. Never wait minutes on a lock,
 *      never pass a flag that skips one;
 *   2. measure the tool's cache folders (allocated bytes, hard links once);
 *   3. run the command with a timeout, streaming its output as progress and
 *      stopping it on cancel, on timeout, or as soon as it says it is waiting
 *      for a lock;
 *   4. measure again: freed is before minus after, never the tool's claim.
 *
 * When the CLI is missing, the folder is emptied instead if the spec says that
 * is safe (it is only reached after the busy check passed).
 *
 * Every process, filesystem and clock dependency is injectable, so the tests
 * drive all of it with stubs and never run a real tool.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn: nodeSpawn, execFile } = require('child_process');
const specs = require('./native-cleanup-specs');
const { processList } = require('./devtools/processes');
const util = require('./devtools/util');
const { unsafeCachePath } = require('./cache-path-guard');

const OUTPUT_TAIL = 4000;
const KILL_GRACE_MS = 3000;
const SCRIPT_HOSTS = /^(node|nodejs|python[\d.]*|ruby[\d.]*|bash|sh|zsh|dash|java)$/i;

function apiFor(platform) { return platform === 'win32' ? path.win32 : path.posix; }
function uniq(list) { return Array.from(new Set((list || []).filter(Boolean))); }

function baseCtx(o = {}) {
  return {
    platform: o.platform || process.platform,
    env: o.env || process.env,
    home: o.home || require('os').homedir(),
    selfPid: o.selfPid || process.pid,
    listDir: o.listDir || defaultListDir,
  };
}

// ---- finding the CLI --------------------------------------------------------

function defaultListDir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

// "v20.11.1" -> [20, 11, 1]; newest first.
function byVersionDesc(a, b) {
  const v = (s) => String(s).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const x = v(a);
  const y = v(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0);
  return 0;
}

/**
 * Folders a GUI app's PATH usually lacks. A Finder-launched app gets only
 * /usr/bin:/bin:/usr/sbin:/sbin, so pnpm from Homebrew or uv from ~/.local/bin
 * would read as missing without these. Version managers too: nvm and fnm keep
 * node (and npm-installed pnpm, yarn) per version; volta, asdf, mise, pyenv
 * and pipx put shims or links in one folder each.
 *
 * Only tool folders under home or the system: never a project folder, never
 * the home folder or a root itself, even when an env variable says so.
 */
function extraBinDirs({ platform, env, home, listDir = defaultListDir }) {
  const api = apiFor(platform);
  const h = (...p) => api.join(home, ...p);
  // An env override counts only when it is absolute and not a root or home.
  const envDir = (name, ...p) => {
    const v = env[name];
    if (!v || !api.isAbsolute(v) || unsafeCachePath(v, { home, platform })) return null;
    return p.length ? api.join(v, ...p) : v;
  };
  const nvmBins = (dir) => {
    const root = api.join(dir, 'versions', 'node');
    return listDir(root).filter((n) => /^v?\d+\.\d+/.test(n)).sort(byVersionDesc).map((n) => api.join(root, n, 'bin'));
  };
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA;
    const roaming = env.APPDATA;
    const pf = env.ProgramFiles || 'C:\\Program Files';
    return [
      envDir('PNPM_HOME'),
      roaming && api.join(roaming, 'npm'), local && api.join(local, 'pnpm'), h('.cargo', 'bin'), h('.local', 'bin'),
      api.join(pf, 'Go', 'bin'), h('go', 'bin'), local && api.join(local, 'Yarn', 'bin'), h('scoop', 'shims'),
      // nvm-windows links the active version here; fnm, volta, mise, pyenv-win.
      envDir('NVM_SYMLINK'),
      envDir('FNM_DIR', 'aliases', 'default'), roaming && api.join(roaming, 'fnm', 'aliases', 'default'),
      envDir('VOLTA_HOME', 'bin'), local && api.join(local, 'Volta', 'bin'),
      envDir('MISE_DATA_DIR', 'shims'), local && api.join(local, 'mise', 'shims'),
      envDir('PYENV_ROOT', 'pyenv-win', 'shims'), h('.pyenv', 'pyenv-win', 'shims'),
      envDir('PIPX_BIN_DIR'),
    ].filter(Boolean);
  }
  const dataHome = envDir('XDG_DATA_HOME') || h('.local', 'share');
  const managers = [
    envDir('NVM_BIN'), ...nvmBins(envDir('NVM_DIR') || h('.nvm')),
    envDir('FNM_DIR', 'aliases', 'default', 'bin'),
    platform === 'darwin' ? h('Library', 'Application Support', 'fnm', 'aliases', 'default', 'bin') : api.join(dataHome, 'fnm', 'aliases', 'default', 'bin'),
    h('.fnm', 'aliases', 'default', 'bin'),
    envDir('VOLTA_HOME', 'bin'),
    envDir('ASDF_DATA_DIR', 'shims'), h('.asdf', 'shims'),
    envDir('MISE_DATA_DIR', 'shims'), api.join(dataHome, 'mise', 'shims'),
    envDir('PYENV_ROOT', 'shims'), h('.pyenv', 'shims'),
    envDir('PIPX_BIN_DIR'),
  ];
  const common = [h('.local', 'bin'), h('.cargo', 'bin'), h('go', 'bin'), h('.volta', 'bin'), h('.bun', 'bin'), ...managers, '/usr/local/go/bin', '/usr/local/bin'];
  if (platform === 'darwin') return ['/opt/homebrew/bin', envDir('PNPM_HOME'), h('Library', 'pnpm'), ...common, '/opt/local/bin', '/usr/bin'].filter(Boolean);
  return [envDir('PNPM_HOME'), h('.local', 'share', 'pnpm'), ...common, '/home/linuxbrew/.linuxbrew/bin', h('.linuxbrew', 'bin'), '/snap/bin', '/usr/bin', '/bin'].filter(Boolean);
}

function searchDirs(ctx) {
  const sep = ctx.platform === 'win32' ? ';' : ':';
  const fromEnv = String(ctx.env.PATH || ctx.env.Path || '').split(sep);
  const api = apiFor(ctx.platform);
  // Relative entries ('.', node_modules/.bin) would resolve against a project.
  return uniq([...fromEnv, ...extraBinDirs({ ...ctx, listDir: ctx.listDir })]).filter((d) => api.isAbsolute(d));
}

async function defaultIsExecutable(p) {
  try {
    const st = await fsp.stat(p);
    if (!st.isFile()) return false;
    await fsp.access(p, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

/** First executable named one of `names` on PATH or in the known folders, or null. */
async function resolveBin(names, o = {}) {
  const ctx = baseCtx(o);
  const isExecutable = o.isExecutable || defaultIsExecutable;
  const api = apiFor(ctx.platform);
  const exts = ctx.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
  const dirs = searchDirs(ctx);
  for (const name of names || []) {
    for (const dir of dirs) {
      // macOS ships pip3 in /usr/bin as a stub that opens the "install the
      // command line tools" dialog when the tools are absent.
      if (ctx.platform === 'darwin' && dir === '/usr/bin' && /^pip/.test(name)) continue;
      for (const ext of exts) {
        const p = api.join(dir, name + ext);
        if (await isExecutable(p)) return p;
      }
    }
  }
  return null;
}

// ---- busy detection ---------------------------------------------------------

function base(p) { return String(p || '').replace(/["']/g, '').split(/[\\/]/).pop(); }

/** A command line split into arguments: double quotes group, and are removed. */
function tokenize(text) {
  const toks = [];
  let cur = '';
  let quoted = false;
  let has = false;
  for (const ch of String(text || '')) {
    if (ch === '"') { quoted = !quoted; has = true; continue; }
    if (!quoted && /\s/.test(ch)) { if (has) toks.push(cur); cur = ''; has = false; continue; }
    cur += ch;
    has = true;
  }
  if (has) toks.push(cur);
  return toks;
}

const isAbsPath = (t) => /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(t);
const SCRIPT_EXT = /\.(?:exe|cmd|bat|c?js|mjs|rb|sh|py)$/i;

/**
 * ps prints arguments joined by spaces without quotes, so a path with a space
 * (/Users/Bob Smith/.local/bin/uv) arrives as several tokens. From an absolute
 * path token, glue on the following tokens while they continue a path: they
 * hold a separator and are not a flag or a new path; or, when a later token
 * ends in an executable or script extension, up to that token.
 */
function joinPath(toks, i) {
  if (i >= toks.length || !isAbsPath(toks[i])) return toks;
  if (SCRIPT_EXT.test(toks[i])) return toks;
  let k = i;
  // Within a few tokens, a path piece ending in .exe/.cjs/.py...: the whole
  // path. Only for a script after a host, or a Windows executable.
  const ext = toks.findIndex((t, j) => j > i && j <= i + 4 && SCRIPT_EXT.test(t) && /[\\/]/.test(t) && !/^[-.]/.test(t));
  const extOk = ext > i && (i > 0 || /^[A-Za-z]:/.test(toks[i]))
    && toks.slice(i + 1, ext + 1).every((t) => !t.startsWith('-') && !isAbsPath(t));
  if (extOk) k = ext;
  else {
    while (k + 1 < toks.length && /[\\/]/.test(toks[k + 1]) && !/^[-./\\]/.test(toks[k + 1]) && !isAbsPath(toks[k + 1])) k++;
  }
  if (k === i) return toks;
  return [...toks.slice(0, i), toks.slice(i, k + 1).join(' '), ...toks.slice(k + 1)];
}

// Host flags whose value is the next argument (node -r x, java -cp x).
const VALUE_FLAGS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-cp', '-classpath', '--class-path', '-W', '-X']);

// The script a package manager's launcher runs, by its file name.
function scriptName(n) {
  if (/^npm-cli$/.test(n)) return 'npm';
  if (/^npx-cli$/.test(n)) return 'npx';
  if (/^pnpm(?:-\d[\w.-]*)?$/.test(n)) return 'pnpm';
  if (/^pnpx$/.test(n)) return 'pnpx';
  // Yarn berry's checked-in release (.yarn/releases/yarn-4.5.0.cjs), yarn.js.
  if (/^yarn(?:-\d[\w.-]*)?$/.test(n)) return 'yarn';
  return n;
}

/**
 * The command a process runs: { name, sub } where name is the executable, or
 * the script a node/python/ruby/bash host runs, without extension, and sub is
 * its first non-flag argument. Windows command lines quote paths with spaces
 * ("C:\Program Files\nodejs\node.exe" "C:\...\pnpm.cjs" install) and npm's
 * cmd-shim launches node on npm-cli.js, pnpm.cjs or yarn.js: all read as the
 * package manager.
 */
function commandOf(args) {
  const text = String(args || '').trim();
  let toks = tokenize(text);
  // An unquoted Windows executable path with spaces: C:\Program Files\Go\bin\go.exe build
  const win = /^([A-Za-z]:\\[^"]*?\.(?:exe|cmd|bat))(?=\s|$)/i.exec(text);
  if (win && !text.startsWith('"')) toks = [win[1], ...tokenize(text.slice(win[0].length))];
  else toks = joinPath(toks, 0);
  if (!toks.length) return { name: '', sub: null };
  let i = 0;
  let name = base(toks[0]).replace(/\.exe$/i, '');
  if (SCRIPT_HOSTS.test(name)) {
    i = 1;
    while (i < toks.length && toks[i].startsWith('-')) {
      // `python -m pip`: the module is the command.
      if (toks[i] === '-m' && toks[i + 1]) { i++; break; }
      if (VALUE_FLAGS.has(toks[i])) i++;
      i++;
      // `--max-old-space-size 4096`: a bare number is a flag's value, not a script.
      while (i < toks.length && /^\d+$/.test(toks[i])) i++;
    }
    toks = joinPath(toks, i);
    name = i < toks.length ? base(toks[i]) : name;
  }
  name = scriptName(name.replace(SCRIPT_EXT, '').toLowerCase());
  let sub = null;
  for (let k = i + 1; k < toks.length; k++) {
    if (!toks[k].startsWith('-')) { sub = toks[k].toLowerCase(); break; }
  }
  return { name, sub };
}

/** Processes that make this spec's tool busy. */
function busyProcesses(spec, procs, selfPid = process.pid) {
  if (!spec || !spec.busy || !procs || !Array.isArray(procs.list)) return [];
  const b = spec.busy;
  const names = new Set(b.names || []);
  const subs = Array.isArray(b.subcommands) ? new Set(b.subcommands) : null;
  return procs.list.filter((p) => {
    if (!p || p.pid === selfPid) return false;
    const args = p.args || '';
    if (b.argsRe && b.argsRe.test(args)) return true;
    const c = commandOf(args);
    // pythonX.Y -m pip, pip3.12
    const n = /^pip\d/.test(c.name) ? 'pip' : c.name;
    if (!names.has(n)) return false;
    if (!subs) return true;
    if (c.sub === null) return b.bare === true;
    return subs.has(c.sub);
  });
}

function busyMessage(spec, why) {
  const t = spec.tool;
  if (why === 'lock') return `${t} is busy (another process holds its cache lock). Try again when it finishes.`;
  if (why === 'daemon') return `${t} is busy (a Gradle daemon from another Gradle version is still running). Stop it with ./gradlew --stop in that project, then try again.`;
  if (why === 'unknown') return `Spaci could not check whether ${t} is running, so it left this alone.`;
  return `${t} is busy (another ${t} process is running). Try again when it finishes.`;
}

/** { busy, reason, why, pids } from a process snapshot. Fails closed. */
function checkBusy(spec, procs, selfPid) {
  if (!procs || !procs.ok) return { busy: true, why: 'unknown', reason: busyMessage(spec, 'unknown'), pids: [] };
  const hit = busyProcesses(spec, procs, selfPid);
  if (hit.length) return { busy: true, why: 'process', reason: busyMessage(spec, 'process'), pids: hit.map((p) => p.pid) };
  return { busy: false, why: null, reason: null, pids: [] };
}

function daemonPids(spec, procs, selfPid) {
  if (!spec.daemonRe || !procs || !Array.isArray(procs.list)) return [];
  return procs.list.filter((p) => p && p.pid !== selfPid && spec.daemonRe.test(p.args || '')).map((p) => p.pid);
}

/**
 * Pids (other than ours) holding any of `files` open, by lsof. Windows and a
 * missing lsof give []: the process check above still applies.
 */
async function lockHolders(files, o = {}) {
  const ctx = baseCtx(o);
  if (ctx.platform === 'win32') return [];
  const exists = o.exists || util.exists;
  const present = [];
  for (const f of files || []) if (await exists(f)) present.push(f);
  if (!present.length) return [];
  const r = await util.run('lsof', ['-t', '--', ...present], { exec: o.exec, timeout: 5000 });
  return String(r.stdout || '').split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n !== ctx.selfPid);
}

// ---- measuring --------------------------------------------------------------

/** Drop folders inside another listed folder, so nothing is counted twice. */
function outermost(dirs, platform) {
  const api = apiFor(platform);
  const list = uniq(dirs);
  return list.filter((d) => !list.some((o) => o !== d && util.isInside(o, d) && api.isAbsolute(o)));
}

function parseDuTotal(stdout) {
  let kb = 0;
  for (const line of String(stdout || '').split('\n')) {
    const n = parseInt(line.trim().split(/\s+/)[0], 10);
    if (Number.isFinite(n)) kb += n;
  }
  return kb * 1024;
}

/**
 * Allocated bytes under `dirs`, hard links once. One du for all of them on
 * macOS and Linux (du counts a hard-linked file once per run), a bounded walk
 * on Windows or when du prints nothing.
 */
async function measure(dirs, o = {}) {
  const ctx = baseCtx(o);
  const exists = o.exists || util.exists;
  const present = [];
  for (const d of outermost(dirs, ctx.platform)) if (await exists(d)) present.push(d);
  if (!present.length) return 0;
  if (ctx.platform !== 'win32') {
    const r = await util.run('du', ['-skx', '--', ...present], { exec: o.exec, timeout: o.timeout || 5 * 60 * 1000 });
    const bytes = parseDuTotal(r.stdout);
    if (bytes > 0 || r.ok) return bytes;
  }
  let total = 0;
  for (const d of present) total += (await util.dirSize(d, { deadline: Date.now() + 60000 })).bytes;
  return total;
}

/**
 * Bytes pnpm store prune would remove, about: files in the store's content
 * folder that no project links to (one link: only the store has them). Read
 * only, bounded; `partial` when the walk stopped early.
 */
async function pnpmUnreferenced(storeDir, o = {}) {
  const deadline = Date.now() + (o.budgetMs || 20000);
  const maxEntries = o.maxEntries || 2000000;
  const files = path.join(storeDir, 'files');
  const root = (await util.isDir(files)) ? files : storeDir;
  let bytes = 0;
  let count = 0;
  let entries = 0;
  let partial = false;
  const stack = [root];
  while (stack.length) {
    if (Date.now() > deadline || entries > maxEntries) { partial = true; break; }
    const dir = stack.pop();
    const list = await util.listDir(dir);
    entries += list.length;
    const stats = await util.pool(list, 32, async (d) => {
      const full = path.join(dir, d.name);
      if (d.isSymbolicLink()) return null;
      if (d.isDirectory()) { stack.push(full); return null; }
      return util.lstatSafe(full);
    });
    for (const s of stats) {
      if (!s || !s.isFile() || s.nlink !== 1) continue;
      bytes += util.allocated(s);
      count++;
    }
  }
  return { bytes, count, partial };
}

/** "This operation would free approximately 130.3MB of disk space." -> bytes */
function parseBrewDryRun(stdout) {
  const text = util.stripAnsi(stdout);
  const m = /would free approximately ([\d.]+)\s*([KMGT]?B)/i.exec(text);
  const units = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  const bytes = m ? Math.round(parseFloat(m[1]) * (units[m[2].toUpperCase()] || 1)) : 0;
  const items = (text.match(/^Would remove: /gm) || []).length;
  // brew cleanup runs `brew autoremove` too (uninstalls formulae), unless
  // HOMEBREW_NO_AUTOREMOVE is set. Its dry run says "==> Would autoremove N
  // unneeded formulae:". Spaci sets the variable; this catches a Homebrew that
  // ignores it.
  const autoremove = /^(?:==>\s*)?Would autoremove\b/im.test(text) || /^(?:==>\s*)?Autoremoving\b/im.test(text);
  return { bytes, items, autoremove };
}

const BREW_AUTOREMOVE_MESSAGE = 'Homebrew said its cleanup would also uninstall formulae (autoremove), so Spaci left it alone. Run brew cleanup yourself to choose.';

/**
 * `gradle --status`:
 *      PID STATUS   INFO
 *    82033 IDLE     8.5
 *    81852 BUSY     8.5
 * or "No Gradle daemons are running." -> { ok, daemons:[{pid,status}], busy:[pid] }.
 * ok is false when the output cannot be read: the caller then refuses.
 * Only IDLE and STOPPED daemons are safe to stop; BUSY, CANCELED (a build
 * still winding down), STOPPING and anything unknown are not.
 */
function parseGradleStatus(stdout) {
  const text = util.stripAnsi(stdout);
  const daemons = [];
  let header = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^PID\s+STATUS\b/i.test(line)) { header = true; continue; }
    const m = /^(\d+)\s+([A-Z_]+)\b/.exec(line);
    if (header && m) daemons.push({ pid: Number(m[1]), status: m[2] });
  }
  const none = /No Gradle daemons are running/i.test(text);
  if (!header && !none) return { ok: false, daemons: [], busy: [] };
  const busy = daemons.filter((d) => d.status !== 'IDLE' && d.status !== 'STOPPED').map((d) => d.pid);
  return { ok: true, daemons, busy };
}

// ---- running a command ------------------------------------------------------

function childEnv(spec, bin, ctx) {
  const sep = ctx.platform === 'win32' ? ';' : ':';
  // The CLI's own folder first: pnpm and yarn are node scripts that find node
  // beside them; then the usual folders a GUI launch leaves out.
  const dirs = uniq([apiFor(ctx.platform).dirname(bin), ...searchDirs(ctx)]);
  const env = { ...ctx.env, ...(spec.env || {}), NO_COLOR: '1', FORCE_COLOR: '0' };
  if (ctx.platform === 'win32') { delete env.Path; }
  env.PATH = dirs.join(sep);
  return env;
}

function killTree(child, platform, exec) {
  if (!child || child.exitCode !== null) return;
  if (platform === 'win32' && child.pid) {
    try { (exec || execFile)('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {}); } catch { /* best effort */ }
    return;
  }
  try { child.kill('SIGTERM'); } catch { /* gone */ }
  const t = setTimeout(() => { try { if (child.exitCode === null) child.kill('SIGKILL'); } catch { /* gone */ } }, KILL_GRACE_MS);
  if (t.unref) t.unref();
}

/**
 * Spawn bin with constant args. Resolves { exitCode, signal, timedOut,
 * cancelled, lockWait, missing, output } and never rejects.
 *
 * `o.atomic === false` (a command that must not stop part way): the signal is
 * ignored and the timeout only calls `o.onSlow(ms)`; the command is never
 * killed by Spaci, except when it says it waits for a lock, which happens
 * before it removes anything.
 */
function runCommand(bin, args, o = {}) {
  const ctx = baseCtx(o);
  const spawn = o.spawn || nodeSpawn;
  specs.validateArgs(args);
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    let cancelled = false;
    let lockWait = false;
    let done = false;
    let child;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (o.signal) o.signal.removeEventListener('abort', onAbort);
      resolve({ timedOut, cancelled, lockWait, missing: false, output: output.slice(-OUTPUT_TAIL), ...r });
    };
    const atomic = o.atomic !== false;
    const onAbort = () => { cancelled = true; killTree(child, ctx.platform, o.exec); };
    // .cmd and .bat need a shell on Windows (Node refuses them otherwise). The
    // arguments are validated constants, so the shell sees no user input.
    const shell = ctx.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
    try {
      child = spawn(shell ? `"${bin}"` : bin, args, {
        cwd: o.cwd || ctx.home,
        env: o.env || process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell,
      });
    } catch (e) {
      resolve({ exitCode: null, signal: null, timedOut: false, cancelled: false, lockWait: false, missing: e && e.code === 'ENOENT', output: String((e && e.message) || e) });
      return;
    }
    const timeoutMs = o.timeoutMs || 10 * 60 * 1000;
    const timer = atomic
      ? setTimeout(() => { timedOut = true; killTree(child, ctx.platform, o.exec); }, timeoutMs)
      : setTimeout(() => { if (o.onSlow) { try { o.onSlow(timeoutMs); } catch { /* best effort */ } } }, timeoutMs);
    if (o.signal && atomic) {
      if (o.signal.aborted) onAbort();
      else o.signal.addEventListener('abort', onAbort, { once: true });
    }
    let partial = '';
    const onData = (chunk) => {
      const text = util.stripAnsi(String(chunk));
      output = (output + text).slice(-OUTPUT_TAIL * 2);
      const lines = (partial + text).split(/\r?\n|\r/);
      partial = lines.pop();
      for (const line of lines) {
        const l = line.trim();
        if (!l) continue;
        if (o.onLine) { try { o.onLine(l); } catch { /* progress is best effort */ } }
        if (o.lockOutput && o.lockOutput.test(l) && !lockWait) { lockWait = true; killTree(child, ctx.platform, o.exec); }
      }
    };
    if (child.stdout) child.stdout.on('data', onData);
    if (child.stderr) child.stderr.on('data', onData);
    child.on('error', (e) => finish({ exitCode: null, signal: null, missing: e && e.code === 'ENOENT', output: String((e && e.message) || e) }));
    child.on('close', (code, sig) => {
      if (partial.trim() && o.lockOutput && o.lockOutput.test(partial)) lockWait = true;
      finish({ exitCode: typeof code === 'number' ? code : null, signal: sig || null });
    });
  });
}

/** Last absolute line a locate command printed, if it is a sane cache folder. */
function pickLocated(stdout, ctx) {
  const api = apiFor(ctx.platform);
  const line = String(stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
  if (!line || !api.isAbsolute(line)) return null;
  const norm = api.resolve(line);
  // Never a root, the home folder, a folder holding it, or /Users: not a cache.
  if (unsafeCachePath(norm, { home: ctx.home, platform: ctx.platform })) return null;
  return norm;
}

async function locate(spec, bin, o = {}) {
  if (!spec.locate || !bin) return null;
  const ctx = baseCtx(o);
  const r = await runCommand(bin, spec.locate, { ...o, timeoutMs: specs.PREVIEW_TIMEOUT_MS, env: o.env || childEnv(spec, bin, ctx), lockOutput: null, onLine: null, signal: o.signal });
  if (r.exitCode !== 0) return null;
  return pickLocated(r.output, ctx);
}

/** 'classic' or 'berry' for Yarn, from `yarn --version`. Unknown reads as classic. */
async function yarnVariant(spec, bin, o = {}) {
  if (!spec.versionArgs) return null;
  const ctx = baseCtx(o);
  const r = await runCommand(bin, spec.versionArgs, { ...o, timeoutMs: specs.PREVIEW_TIMEOUT_MS, env: o.env || childEnv(spec, bin, ctx), lockOutput: null, onLine: null });
  const m = /(\d+)\.\d+/.exec(r.output || '');
  return m && Number(m[1]) >= 2 ? 'berry' : 'classic';
}

function existing(paths) {
  return (paths || []).filter((p) => typeof p === 'string' && p && fs.existsSync(p));
}

/** Target paths that may be treated as a cache folder (cache-path-guard). */
function safePaths(paths, ctx) {
  return (paths || []).filter((p) => typeof p === 'string' && !unsafeCachePath(p, { home: ctx.home, platform: ctx.platform }));
}

function measureDirs(spec, target, located, bin, platform, home) {
  const api = apiFor(platform);
  const dirs = [...existing(safePaths(target.paths, { platform, home })), ...(located ? [located] : [])];
  if (bin && Array.isArray(spec.measureFromBin)) {
    const prefix = api.dirname(api.dirname(bin));
    for (const name of spec.measureFromBin) dirs.push(api.join(prefix, name));
  }
  return dirs;
}

// ---- preview ----------------------------------------------------------------

/**
 * What cleaning would do, without changing anything:
 * { id, via, command, label, available, bin, busy, estimate, estimateKind,
 *   partial, note, located }.
 */
async function preview(target, o = {}) {
  const spec = specs.specFor(target && target.id);
  if (!spec) return null;
  const ctx = baseCtx(o);
  const m = o.measure || ((dirs) => measure(dirs, o));
  const procs = o.procs || await processList({ platform: ctx.platform, exec: o.exec });
  const busy = checkBusy(spec, procs, ctx.selfPid);
  const out = { id: target.id, tool: spec.tool, via: spec.via, command: null, label: null, available: spec.via === 'folder', bin: null, busy: busy.busy ? busy.reason : null, estimate: null, estimateKind: 'all', partial: false, note: null, located: null };
  const folder = async (note) => {
    out.via = 'folder';
    out.label = 'Empties the folder';
    out.note = note;
    out.estimate = await m(existing(safePaths(target.paths, ctx)));
    return out;
  };
  if (spec.via === 'folder') { await folder(spec.why); out.label = specs.describe(target.id).label; return out; }
  const bin = await resolveBin(spec.bins, o);
  if (!bin) return folder(`${spec.tool} was not found, so Spaci empties the folder instead.`);
  out.available = true;
  out.bin = bin;
  const env = childEnv(spec, bin, ctx);
  if (spec.versionArgs && (await yarnVariant(spec, bin, { ...o, env })) === 'berry') {
    return folder('Yarn 2 and later clean their cache only from inside a project, so Spaci empties the global cache folder instead.');
  }
  const cmd = specs.commandLine(spec, 'manual');
  out.command = cmd;
  out.label = spec.via === 'stop-then-folder' ? 'Runs `' + cmd + '`, then empties the folder' : 'Runs `' + cmd + '`';
  out.located = await locate(spec, bin, { ...o, env });
  if (!out.busy && spec.lockFiles && out.located) {
    const holders = await lockHolders(spec.lockFiles.map((f) => path.join(out.located, f)), o);
    if (holders.length) out.busy = busyMessage(spec, 'lock');
  }
  if (spec.preview === 'pnpm-unreferenced' && out.located) {
    const r = await (o.pnpmUnreferenced || pnpmUnreferenced)(out.located, o);
    out.estimate = r.bytes;
    out.estimateKind = 'unreferenced';
    out.partial = r.partial;
    out.note = 'About this much is in packages no project uses. The rest stays: your projects link to it.';
  } else if (spec.preview === 'brew-dry-run') {
    const r = await runCommand(bin, spec.previewArgs, { ...o, env, timeoutMs: 2 * 60 * 1000, lockOutput: spec.lockOutput, onLine: null });
    if (r.lockWait) out.busy = busyMessage(spec, 'process');
    if (r.exitCode === 0) {
      const p = parseBrewDryRun(r.output);
      out.estimate = p.bytes;
      out.estimateKind = 'dry-run';
      out.note = `brew cleanup --dry-run lists ${p.items} ${p.items === 1 ? 'item' : 'items'}.`;
      if (p.autoremove) out.blocked = BREW_AUTOREMOVE_MESSAGE;
    }
  }
  if (out.estimate === null) out.estimate = await m(measureDirs(spec, target, out.located, null, ctx.platform, ctx.home));
  return out;
}

// ---- run --------------------------------------------------------------------

/**
 * Clean one target with its tool. `opts.folderJobs` are the guarded clean jobs
 * for the target's folders, used for 'stop-then-folder', 'folder' and the
 * missing-CLI fallback; `opts.deleteFolders(jobs, onProgress)` empties them
 * (cleaner.clean in the worker). Mode 'auto' never empties a folder: anything
 * but the tool's own auto command answers 'missing' or 'not-auto', and
 * auto-clean stages the folder instead.
 *
 * The tool is checked for busy at the start, again with a fresh process list
 * and lock check right before its command, and again right before a folder is
 * emptied: measuring can take minutes.
 *
 * Resolves { ok, id, code, via, command, exitCode, before, after, freed,
 * message, output } and never rejects. code: 'done' | 'busy' | 'missing' |
 * 'timeout' | 'cancelled' | 'failed' | 'incomplete' | 'unsafe' | 'not-auto' |
 * 'invalid'. 'incomplete': a non-atomic command stopped part way (killed from
 * outside or failed); the cache must be cleaned again before the tool uses it.
 */
async function runNative(target, o = {}) {
  const spec = specs.specFor(target && target.id);
  const res = (r) => ({ ok: false, id: target && target.id, via: null, command: null, exitCode: null, before: 0, after: 0, freed: 0, message: null, output: '', ...r });
  if (!spec) return res({ code: 'invalid', message: 'Spaci has no cleanup command for this.' });
  const ctx = baseCtx(o);
  const mode = o.mode === 'auto' ? 'auto' : 'manual';
  const args = specs.argsFor(spec, mode);
  // Auto-clean runs a tool's own gentle command or nothing: never a permanent
  // folder delete. A folder-only target is staged by auto-clean itself.
  if (mode === 'auto' && (!args || spec.via !== 'native')) return res({ code: 'not-auto', message: 'Auto-clean leaves this to you.' });
  const atomic = specs.isAtomic(spec, mode);
  const progress = (p) => { if (o.onProgress) { try { o.onProgress({ target: target.id, ...p }); } catch { /* best effort */ } } };
  const m = o.measure || ((dirs) => measure(dirs, o));
  const snapshot = o.snapshot || (() => processList({ platform: ctx.platform, exec: o.exec }));
  const holdersOf = o.lockHolders || lockHolders;
  const run = o.runCommand || runCommand;
  const paths = safePaths(target.paths, ctx);

  // 1. Busy: a running process of the tool. Fails closed.
  const procs = await snapshot();
  const busy = checkBusy(spec, procs, ctx.selfPid);
  if (busy.busy) return res({ code: 'busy', message: busy.reason });

  // 2. The CLI, its variant and its real cache folder.
  let via = spec.via;
  let note = null;
  const bin = via === 'folder' ? null : await resolveBin(spec.bins, o);
  const env = bin ? childEnv(spec, bin, ctx) : null;
  if (bin && spec.versionArgs && (await yarnVariant(spec, bin, { ...o, env })) === 'berry') {
    if (mode === 'auto') return res({ code: 'not-auto', message: 'Yarn 2 and later clean only inside a project, so auto-clean did not run it.' });
    via = 'folder';
    note = 'Yarn 2 and later clean only inside a project, so Spaci emptied the global cache folder.';
  }
  if (via !== 'folder' && !bin) {
    if (mode === 'auto') return res({ code: 'missing', message: `${spec.tool} was not found, so auto-clean did not run it.` });
    if (spec.fallback !== 'folder') return res({ code: 'missing', message: `${spec.tool} was not found, so nothing was cleaned.` });
    via = 'folder';
    note = `${spec.tool} was not found, so Spaci emptied the folder instead.`;
  }
  const located = via !== 'folder' ? await locate(spec, bin, { ...o, env }) : null;

  const lockBusy = async () => {
    if (!spec.lockFiles) return false;
    const dirs = located ? [located] : existing(paths);
    const files = dirs.flatMap((d) => spec.lockFiles.map((f) => path.join(d, f)));
    return (await holdersOf(files, o)).length > 0;
  };
  // Busy again, now: a fresh process list, the lock file, and (before a folder
  // is emptied) any Gradle daemon. Returns the reason, or null when idle.
  const recheck = async ({ daemons = false } = {}) => {
    let p;
    try { p = await snapshot(); } catch { p = null; }
    const b = checkBusy(spec, p, ctx.selfPid);
    if (b.busy) return b.reason;
    if (await lockBusy()) return busyMessage(spec, 'lock');
    if (daemons && spec.daemonRe && daemonPids(spec, p, ctx.selfPid).length) {
      return via === 'stop-then-folder' ? busyMessage(spec, 'daemon') : `${spec.tool} is busy (a Gradle daemon is running). Try again when it stops.`;
    }
    return null;
  };

  // 3. Busy: another process holds the cache lock open.
  if (await lockBusy()) return res({ code: 'busy', message: busyMessage(spec, 'lock') });
  // Gradle without its CLI: daemons cannot be stopped, so any running one is busy.
  if (spec.daemonRe && (via === 'folder' || !bin) && daemonPids(spec, procs, ctx.selfPid).length) {
    return res({ code: 'busy', message: `${spec.tool} is busy (a Gradle daemon is running). Try again when it stops.` });
  }

  const dirs = measureDirs(spec, target, located, via === 'folder' ? null : bin, ctx.platform, ctx.home);
  const before = await m(dirs);
  const command = via === 'folder' ? null : [base(bin).replace(/\.(exe|cmd|bat)$/i, ''), ...args].join(' ');
  let exitCode = null;
  let output = '';
  const partly = async (fields) => { const a = await m(dirs); return res({ via, command, exitCode, before, after: a, freed: Math.max(0, before - a), output, ...fields }); };
  const refuse = (fields) => res({ via, command, before, after: before, ...fields });

  // 4. The tool's own command.
  if (via === 'native' || via === 'stop-then-folder') {
    // Measuring may have taken minutes: is the tool still idle, right now?
    const now = await recheck();
    if (now) return refuse({ code: 'busy', message: now });
    const quiet = { ...o, env, cwd: ctx.home, timeoutMs: specs.PREVIEW_TIMEOUT_MS, lockOutput: spec.lockOutput || null, onLine: null, atomic: true };
    // Gradle: gradle --stop would kill a daemon mid build. Ask first, read only.
    if (spec.status) {
      const st = await run(bin, spec.status, quiet);
      const g = st.exitCode === 0 ? parseGradleStatus(st.output) : { ok: false, busy: [] };
      if (!g.ok) return refuse({ code: 'busy', message: `Spaci could not read ${[base(bin).replace(/\.(exe|cmd|bat)$/i, ''), ...spec.status].join(' ')}, so it left ${spec.tool} alone.` });
      if (g.busy.length) return refuse({ code: 'busy', message: `${spec.tool} is busy (a Gradle daemon is running a build). Try again when the build finishes.` });
    }
    // Homebrew: the dry run must not plan an autoremove, even with the env set.
    if (spec.preview === 'brew-dry-run' && spec.previewArgs) {
      const dr = await run(bin, spec.previewArgs, { ...quiet, timeoutMs: 2 * 60 * 1000 });
      if (dr.lockWait) return refuse({ code: 'busy', message: busyMessage(spec, 'process') });
      if (dr.exitCode !== 0) return refuse({ code: 'failed', message: `${[base(bin), ...spec.previewArgs].join(' ')} failed, so Spaci did not run the cleanup.` });
      if (parseBrewDryRun(dr.output).autoremove) return refuse({ code: 'unsafe', message: BREW_AUTOREMOVE_MESSAGE });
    }
    if (o.signal && o.signal.aborted) return refuse({ code: 'cancelled', message: `Stopped before ${command} started.` });
    const reportMs = o.reportAfterMs || specs.NON_ATOMIC_REPORT_MS;
    progress({ phase: 'native-start', command, atomic });
    const r = await run(bin, args, {
      ...o, env, cwd: ctx.home, lockOutput: spec.lockOutput, atomic,
      // A non-atomic command is never cancelled or killed on timeout.
      timeoutMs: atomic ? (o.timeoutMs || spec.timeoutMs) : reportMs,
      signal: atomic ? o.signal : undefined,
      onSlow: (ms) => {
        const mins = Math.max(1, Math.round(ms / 60000));
        progress({ phase: 'native', command, line: `Still running after ${mins} ${mins === 1 ? 'minute' : 'minutes'}. Spaci waits for it: stopping it part way would leave a broken cache.` });
      },
      onLine: (line) => progress({ phase: 'native', command, line }),
    });
    exitCode = r.exitCode;
    output = r.output || '';
    const last = output.trim().split(/\r?\n/).filter(Boolean).pop() || '';
    if (r.missing) {
      if (mode === 'auto') return res({ code: 'missing', command, message: `${spec.tool} could not be started, so auto-clean did not run it.` });
      if (spec.fallback !== 'folder') return res({ code: 'missing', command, message: `${spec.tool} could not be started.` });
      via = 'folder';
      note = `${spec.tool} could not be started, so Spaci emptied the folder instead.`;
    } else if (r.lockWait) {
      // Said before it removed anything: it was waiting for the lock.
      return partly({ code: 'busy', message: busyMessage(spec, 'process') });
    } else if (!atomic && (r.cancelled || r.timedOut || r.signal || exitCode !== 0)) {
      const why = r.signal ? `${command} was stopped (${r.signal})` : `${command} exited with ${exitCode === null ? 'a signal' : 'status ' + exitCode}${last ? ': ' + last.slice(0, 300) : ''}`;
      return partly({ code: 'incomplete', message: `${specs.INCOMPLETE_MESSAGE} ${why}.` });
    } else if (r.cancelled) {
      return partly({ code: 'cancelled', message: `Stopped: ${command} was cancelled.` });
    } else if (r.timedOut) {
      const mins = Math.max(1, Math.round((o.timeoutMs || spec.timeoutMs) / 60000));
      return partly({ code: 'timeout', message: `${command} did not finish in ${mins} ${mins === 1 ? 'minute' : 'minutes'}, so Spaci stopped it.` });
    } else if (exitCode !== 0) {
      return partly({ code: 'failed', message: `${command} exited with ${exitCode === null ? 'a signal' : 'status ' + exitCode}${last ? ': ' + last.slice(0, 300) : '.'}` });
    }
  }

  // 5. The folder, when that is the plan or the fallback (never in auto mode).
  let folderError = null;
  if (via === 'folder' || via === 'stop-then-folder') {
    if (mode === 'auto') return res({ code: 'not-auto', message: 'Auto-clean leaves this to you.' });
    const all = Array.isArray(o.folderJobs) ? o.folderJobs : [];
    const unsafe = all.map((j) => ({ j, why: unsafeCachePath(j && j.path, { home: ctx.home, platform: ctx.platform }) })).find((x) => x.why);
    if (unsafe) {
      folderError = `Spaci will not empty ${unsafe.j && unsafe.j.path}: ${unsafe.why}.`;
    } else if (!all.length || typeof o.deleteFolders !== 'function') {
      folderError = 'Spaci had no folder to empty.';
    } else {
      // The last word before anything is deleted: idle now, no daemon left
      // (daemons of other Gradle versions survive gradle --stop).
      const now = await recheck({ daemons: true });
      if (now) return partly({ code: 'busy', message: now });
      progress({ phase: 'folder-start' });
      if (o.signal && o.signal.aborted) folderError = 'Stopped before the folder was emptied.';
      else {
        const d = await o.deleteFolders(all, (p) => progress({ phase: 'folder', ...p }));
        const bad = (d && Array.isArray(d.results) ? d.results : []).find((x) => !x.ok && !x.missing);
        if (bad) folderError = bad.error || 'Part of the folder could not be removed.';
      }
    }
  }

  const after = await m(dirs);
  const freed = Math.max(0, before - after);
  if (folderError) return res({ code: 'failed', via, command, exitCode, before, after, freed, output, message: folderError });
  return { ok: true, id: target.id, code: 'done', via, command, exitCode, before, after, freed, message: note, output };
}

module.exports = {
  extraBinDirs, searchDirs, resolveBin, tokenize, commandOf, busyProcesses, checkBusy, busyMessage, daemonPids, lockHolders,
  outermost, parseDuTotal, measure, pnpmUnreferenced, parseBrewDryRun, parseGradleStatus, BREW_AUTOREMOVE_MESSAGE, childEnv,
  runCommand, pickLocated, locate, yarnVariant, measureDirs, safePaths, preview, runNative,
};
