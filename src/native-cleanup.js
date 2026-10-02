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
  };
}

// ---- finding the CLI --------------------------------------------------------

/**
 * Folders a GUI app's PATH usually lacks. A Finder-launched app gets only
 * /usr/bin:/bin:/usr/sbin:/sbin, so pnpm from Homebrew or uv from ~/.local/bin
 * would read as missing without these.
 */
function extraBinDirs({ platform, env, home }) {
  const api = apiFor(platform);
  const h = (...p) => api.join(home, ...p);
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA;
    const roaming = env.APPDATA;
    const pf = env.ProgramFiles || 'C:\\Program Files';
    return [
      roaming && api.join(roaming, 'npm'), local && api.join(local, 'pnpm'), h('.cargo', 'bin'), h('.local', 'bin'),
      api.join(pf, 'Go', 'bin'), h('go', 'bin'), local && api.join(local, 'Yarn', 'bin'), h('scoop', 'shims'),
    ].filter(Boolean);
  }
  const common = [h('.local', 'bin'), h('.cargo', 'bin'), h('go', 'bin'), h('.volta', 'bin'), h('.bun', 'bin'), '/usr/local/go/bin', '/usr/local/bin'];
  if (platform === 'darwin') return ['/opt/homebrew/bin', h('Library', 'pnpm'), ...common, '/opt/local/bin', '/usr/bin'];
  return [h('.local', 'share', 'pnpm'), ...common, '/home/linuxbrew/.linuxbrew/bin', h('.linuxbrew', 'bin'), '/snap/bin', '/usr/bin', '/bin'];
}

function searchDirs(ctx) {
  const sep = ctx.platform === 'win32' ? ';' : ':';
  const fromEnv = String(ctx.env.PATH || ctx.env.Path || '').split(sep);
  const api = apiFor(ctx.platform);
  return uniq([...fromEnv, ...extraBinDirs(ctx)]).filter((d) => api.isAbsolute(d));
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

function base(p) { return String(p || '').split(/[\\/]/).pop(); }

/**
 * The command a process runs: { name, sub } where name is the executable, or
 * the script a node/python/ruby/bash host runs, without extension, and sub is
 * its first non-flag argument.
 */
function commandOf(args) {
  let text = String(args || '').trim();
  // A Windows executable path may hold spaces (C:\Program Files\Go\bin\go.exe).
  const win = /^"?([A-Za-z]:\\.*?\.(?:exe|cmd|bat))"?(?=\s|$)/i.exec(text);
  if (win) text = win[1].replace(/\s/g, '_') + text.slice(win[0].length);
  const toks = text.split(/\s+/).filter(Boolean);
  if (!toks.length) return { name: '', sub: null };
  let i = 0;
  let name = base(toks[0]).replace(/\.exe$/i, '');
  if (SCRIPT_HOSTS.test(name)) {
    i = 1;
    while (i < toks.length && toks[i].startsWith('-')) {
      // `python -m pip`: the module is the command.
      if (toks[i] === '-m' && toks[i + 1]) { i++; break; }
      i++;
    }
    name = i < toks.length ? base(toks[i]) : name;
  }
  name = name.replace(/\.(exe|cmd|bat|c?js|mjs|rb|sh|py)$/i, '').toLowerCase();
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
  return { bytes, items };
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
    const timer = setTimeout(() => { timedOut = true; killTree(child, ctx.platform, o.exec); }, o.timeoutMs || 10 * 60 * 1000);
    if (o.signal) {
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
  // Never the root or the home folder itself: those are not a cache.
  if (norm === api.parse(norm).root || norm === api.resolve(ctx.home)) return null;
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

function measureDirs(spec, target, located, bin, platform) {
  const api = apiFor(platform);
  const dirs = [...existing(target.paths), ...(located ? [located] : [])];
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
    out.estimate = await m(existing(target.paths));
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
    }
  }
  if (out.estimate === null) out.estimate = await m(measureDirs(spec, target, out.located, null, ctx.platform));
  return out;
}

// ---- run --------------------------------------------------------------------

/**
 * Clean one target with its tool. `opts.folderJobs` are the guarded clean jobs
 * for the target's folders, used for 'stop-then-folder', 'folder' and the
 * missing-CLI fallback; `opts.deleteFolders(jobs, onProgress)` empties them
 * (cleaner.clean in the worker).
 *
 * Resolves { ok, id, code, via, command, exitCode, before, after, freed,
 * message, output } and never rejects. code: 'done' | 'busy' | 'missing' |
 * 'timeout' | 'cancelled' | 'failed' | 'not-auto' | 'invalid'.
 */
async function runNative(target, o = {}) {
  const spec = specs.specFor(target && target.id);
  const res = (r) => ({ ok: false, id: target && target.id, via: null, command: null, exitCode: null, before: 0, after: 0, freed: 0, message: null, output: '', ...r });
  if (!spec) return res({ code: 'invalid', message: 'Spaci has no cleanup command for this.' });
  const ctx = baseCtx(o);
  const mode = o.mode === 'auto' ? 'auto' : 'manual';
  const args = specs.argsFor(spec, mode);
  if (mode === 'auto' && !args && spec.via !== 'folder') return res({ code: 'not-auto', message: 'Auto-clean leaves this to you.' });
  const progress = (p) => { if (o.onProgress) { try { o.onProgress({ target: target.id, ...p }); } catch { /* best effort */ } } };
  const m = o.measure || ((dirs) => measure(dirs, o));
  const snapshot = o.snapshot || (() => processList({ platform: ctx.platform, exec: o.exec }));

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
    via = 'folder';
    note = 'Yarn 2 and later clean only inside a project, so Spaci emptied the global cache folder.';
  }
  if (via !== 'folder' && !bin) {
    if (spec.fallback !== 'folder') return res({ code: 'missing', message: `${spec.tool} was not found, so nothing was cleaned.` });
    via = 'folder';
    note = `${spec.tool} was not found, so Spaci emptied the folder instead.`;
  }
  const located = via !== 'folder' ? await locate(spec, bin, { ...o, env }) : null;

  // 3. Busy: another process holds the cache lock open.
  if (spec.lockFiles) {
    const dirs = located ? [located] : existing(target.paths);
    const files = dirs.flatMap((d) => spec.lockFiles.map((f) => path.join(d, f)));
    const holders = await (o.lockHolders || lockHolders)(files, o);
    if (holders.length) return res({ code: 'busy', message: busyMessage(spec, 'lock') });
  }
  // Gradle without its CLI: daemons cannot be stopped, so any running one is busy.
  if (spec.daemonRe && (via === 'folder' || !bin) && daemonPids(spec, procs, ctx.selfPid).length) {
    return res({ code: 'busy', message: `${spec.tool} is busy (a Gradle daemon is running). Try again when it stops.` });
  }

  const dirs = measureDirs(spec, target, located, via === 'folder' ? null : bin, ctx.platform);
  const before = await m(dirs);
  const command = via === 'folder' ? null : [base(bin).replace(/\.(exe|cmd|bat)$/i, ''), ...args].join(' ');
  let exitCode = null;
  let output = '';

  // 4. The tool's own command.
  if (via === 'native' || via === 'stop-then-folder') {
    progress({ phase: 'native-start', command });
    const r = await (o.runCommand || runCommand)(bin, args, {
      ...o, env, cwd: ctx.home, timeoutMs: o.timeoutMs || spec.timeoutMs, lockOutput: spec.lockOutput,
      onLine: (line) => progress({ phase: 'native', command, line }),
    });
    exitCode = r.exitCode;
    output = r.output || '';
    const after = async () => m(dirs);
    const partly = async (fields) => { const a = await after(); return res({ via, command, exitCode, before, after: a, freed: Math.max(0, before - a), output, ...fields }); };
    if (r.missing) {
      if (spec.fallback !== 'folder') return res({ code: 'missing', command, message: `${spec.tool} could not be started.` });
      via = 'folder';
      note = `${spec.tool} could not be started, so Spaci emptied the folder instead.`;
    } else if (r.lockWait) {
      return partly({ code: 'busy', message: busyMessage(spec, 'process') });
    } else if (r.cancelled) {
      return partly({ code: 'cancelled', message: `Stopped: ${command} was cancelled.` });
    } else if (r.timedOut) {
      const mins = Math.max(1, Math.round((o.timeoutMs || spec.timeoutMs) / 60000));
      return partly({ code: 'timeout', message: `${command} did not finish in ${mins} ${mins === 1 ? 'minute' : 'minutes'}, so Spaci stopped it.` });
    } else if (exitCode !== 0) {
      const last = output.trim().split(/\r?\n/).filter(Boolean).pop() || '';
      return partly({ code: 'failed', message: `${command} exited with ${exitCode === null ? 'a signal' : 'status ' + exitCode}${last ? ': ' + last.slice(0, 300) : '.'}` });
    }
    if (via === 'stop-then-folder') {
      // Daemons of other Gradle versions survive gradle --stop.
      const again = await snapshot();
      if (!again || !again.ok) return partly({ code: 'busy', message: busyMessage(spec, 'unknown') });
      if (checkBusy(spec, again, ctx.selfPid).busy) return partly({ code: 'busy', message: busyMessage(spec, 'process') });
      if (daemonPids(spec, again, ctx.selfPid).length) return partly({ code: 'busy', message: busyMessage(spec, 'daemon') });
    }
  }

  // 5. The folder, when that is the plan or the fallback.
  let folderError = null;
  if (via === 'folder' || via === 'stop-then-folder') {
    const jobs = Array.isArray(o.folderJobs) ? o.folderJobs : [];
    if (!jobs.length || typeof o.deleteFolders !== 'function') {
      folderError = 'Spaci had no folder to empty.';
    } else {
      progress({ phase: 'folder-start' });
      if (o.signal && o.signal.aborted) folderError = 'Stopped before the folder was emptied.';
      else {
        const d = await o.deleteFolders(jobs, (p) => progress({ phase: 'folder', ...p }));
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
  extraBinDirs, searchDirs, resolveBin, commandOf, busyProcesses, checkBusy, busyMessage, daemonPids, lockHolders,
  outermost, parseDuTotal, measure, pnpmUnreferenced, parseBrewDryRun, childEnv, runCommand, pickLocated, locate,
  yarnVariant, measureDirs, preview, runNative,
};
