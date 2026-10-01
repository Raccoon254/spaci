// End-to-end check of a packaged Spaci build through its real main process,
// driven over the Chrome DevTools Protocol. Runs on macOS, Windows and Linux in
// CI (.github/workflows/e2e.yml). Uses an isolated user data dir, and the only
// files it deletes are ones it created itself.
//
//   node scripts/e2e/cdp-e2e.mjs <path to the Spaci executable> [--docker]
//
// --docker: Docker is running and has more than 1 GB of images no container
// uses (the workflow pulls some); checks the unused-images recommendation frees
// real space.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BIN = process.argv[2];
const WITH_DOCKER = process.argv.includes('--docker');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-e2e-profile-'));
const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

const app = spawn(BIN, [`--user-data-dir=${DATA}`, `--remote-debugging-port=${PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, SPACI_TELEMETRY: '0', SPACI_NO_MOVE_PROMPT: '1' },
});
let log = '';
app.stdout.on('data', (d) => { log += d; });
app.stderr.on('data', (d) => { log += d; });
let exited = null;
app.on('exit', (code, sig) => { exited = { code, sig }; });

async function target() {
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
      if (page) return page;
    } catch { /* not up yet */ }
    if (exited) break;
    await sleep(500);
  }
  throw new Error('renderer never appeared; exited=' + JSON.stringify(exited) + '\n' + log.slice(-3000));
}

let ws; let seq = 0; const pending = new Map();
async function connect(url) {
  ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
}
function send(method, params) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((r) => pending.set(id, r));
}
async function evalIn(expr) {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
  return r.result.result.value;
}
const dockerImageCount = () => {
  try { return execFileSync('docker', ['images', '-q'], { encoding: 'utf8' }).split('\n').filter(Boolean).length; }
  catch { return -1; }
};

try {
  const page = await target();
  await connect(page.webSocketDebuggerUrl);
  await sleep(2000);

  const v = await evalIn('return await window.api.appVersion()');
  check('reports its version', typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v), v);

  const sys = await evalIn('return await window.api.scanSystem()');
  const targets = sys?.targets || [];
  // A fresh CI machine has only a couple of caches; the point is that it scans.
  check('system scan runs', sys?.ok === true && Array.isArray(targets), `${targets.length} targets on ${process.platform}`);

  const outsidePath = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/hosts';
  const outside = await evalIn(`return await window.api.clean([{ path: ${JSON.stringify(outsidePath)}, mode: 'path' }], { scope: 'e2e' })`);
  check('refuses a path no scan produced', outside?.ok && (outside.refused || []).length === 1 && outside.totalFreed === 0 && fs.existsSync(outsidePath));

  const ext = await evalIn(`return await window.api.openExternal('javascript:alert(1)')`);
  const op = await evalIn(`return await window.api.openPath(${JSON.stringify(outsidePath)})`);
  const lfRoot = await evalIn(`return await window.api.scanLargeFiles(${JSON.stringify(path.parse(os.homedir()).root)}, 1)`);
  check('IPC hardening', ext === false && op === 'Not allowed' && lfRoot?.ok === false, JSON.stringify({ ext, op, lf: lfRoot?.ok }));

  // Large file: refused without a confirm, then moved to the OS Trash/Recycle Bin.
  const tdir = path.join(os.homedir(), 'spaci-e2e-' + process.pid);
  fs.mkdirSync(tdir, { recursive: true });
  const big = path.join(tdir, 'e2e-big.bin');
  fs.writeFileSync(big, Buffer.alloc(11 * 1024 * 1024, 7));
  try {
    const lf = await evalIn(`return await window.api.scanLargeFiles(${JSON.stringify(tdir)}, 10 * 1024 * 1024)`);
    const found = lf?.ok && (lf.files || []).some((f) => f.path === big);
    const no = await evalIn(`return await window.api.clean([{ path: ${JSON.stringify(big)} }], { scope: 'largefiles' })`);
    check('large file needs confirmation', found && (no.refused || []).some((r) => r.reason === 'needs-confirmation') && fs.existsSync(big), JSON.stringify({ found, refused: no.refused }));
    const yes = await evalIn(`return await window.api.clean([{ path: ${JSON.stringify(big)} }], { scope: 'largefiles', confirmed: true })`);
    check('confirmed large file goes to the Trash, not counted as freed',
      !fs.existsSync(big) && (yes.trashed || []).includes(big) && yes.totalFreed === 0 && yes.trashedBytes > 0,
      JSON.stringify({ trashed: yes.trashed, freed: yes.totalFreed, trashedBytes: yes.trashedBytes, errors: yes.errors }));
    const hist = JSON.parse(fs.readFileSync(path.join(DATA, 'history.json'), 'utf8'));
    check('history records the trashed file', hist[0]?.v === 2 && hist[0]?.items?.[0]?.outcome === 'trashed');
  } finally { fs.rmSync(tdir, { recursive: true, force: true }); }

  // Git worktrees: one record per repository, removal only after a confirm,
  // re-verified by git right before it runs, the branch kept; prune clears a
  // worktree whose folder is gone. Everything lives in a folder made here.
  const wroot = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), 'spaci-e2e-wt-')));
  try {
    const genv = { ...process.env, GIT_AUTHOR_NAME: 'Spaci E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'Spaci E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com' };
    const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...a], { env: genv, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    const repo = path.join(wroot, 'shop');
    fs.mkdirSync(path.join(repo, 'web'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'api'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'web', 'package.json'), '{"name":"web"}');
    fs.writeFileSync(path.join(repo, 'api', 'package.json'), '{"name":"api"}');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
    git(repo, 'init', '-q'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init');
    const wt = (n) => path.join(wroot, 'shop-worktrees', n);
    for (const n of ['done', 'wip', 'gone']) git(repo, 'worktree', 'add', '-q', '-b', n, wt(n));
    fs.mkdirSync(path.join(wt('done'), 'web', 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(wt('done'), 'web', 'node_modules', 'dep', 'index.js'), 'x'.repeat(64 * 1024));
    fs.writeFileSync(path.join(wt('wip'), 'notes.txt'), 'not committed');
    fs.rmSync(wt('gone'), { recursive: true, force: true });

    const scan = await evalIn(`return await window.api.scanProjects(${JSON.stringify(wroot)})`);
    const recs = (scan?.projects || []).filter((p) => p.repo);
    const rec = recs.find((p) => p.repo.worktrees.length);
    const by = (b) => rec?.repo.worktrees.find((w) => w.branch === b);
    check('worktrees fold into one repository record with its packages',
      scan?.ok !== false && recs.length === 1 && rec.repo.worktrees.length === 3 && rec.repo.packages.length === 2
        && !(scan.projects || []).some((p) => p.path.includes('shop-worktrees')) && path.basename(rec.path) === 'shop',
      JSON.stringify({ records: (scan?.projects || []).map((p) => p.path.replace(wroot, '')), worktrees: rec?.repo.worktrees.length, packages: rec?.repo.packages.map((k) => k.rel) }));
    check('worktree properties and eligibility',
      by('done')?.eligibility.ok === true && by('done')?.merged === true && by('done')?.size > 0
        && by('wip')?.eligibility.ok === false && by('wip')?.untracked === 1 && by('gone')?.exists === false && rec.repo.removable.count === 1,
      JSON.stringify(rec?.repo.worktrees.map((w) => ({ b: w.branch, ok: w.eligibility.ok, reasons: w.eligibility.reasons }))));
    // Paths compared loosely: git prints forward slashes and may differ in case on Windows.
    const same = (a, b) => String(a || '').replace(/\\/g, '/').toLowerCase() === String(b || '').replace(/\\/g, '/').toLowerCase();
    const nm = path.join(by('done')?.path || wt('done'), 'web', 'node_modules');
    const tiers = await evalIn(`return await window.api.cleanTiers({ projects: (await window.api.cacheGet()).projects, sysTargets: [] })`);
    check('build output inside a worktree is tier A (Clean all covers it), the worktree itself never is',
      (tiers?.planA?.jobs || []).some((j) => same(j.path, nm)) && !(tiers?.planA?.jobs || []).some((j) => same(j.path, by('done')?.path)),
      JSON.stringify((tiers?.planA?.jobs || []).map((j) => j.path)));

    const no = await evalIn(`return await window.api.removeWorktrees([{ path: ${JSON.stringify(by('done')?.path)} }], {})`);
    check('removing a worktree needs a confirm', (no?.refused || [])[0]?.reason === 'needs-confirmation' && fs.existsSync(wt('done')), JSON.stringify(no?.refused));
    const yes = await evalIn(`return await window.api.removeWorktrees(${JSON.stringify([{ path: by('done')?.path }, { path: by('wip')?.path }])}, { confirmed: true })`);
    const branches = git(repo, 'branch', '--format=%(refname:short)').split(/\r?\n/).filter(Boolean);
    check('confirmed: the clean merged worktree goes, the dirty one stays, the branch is kept',
      (yes?.removed || []).length === 1 && !fs.existsSync(wt('done')) && fs.existsSync(path.join(wt('wip'), 'notes.txt'))
        && (yes?.refused || []).some((r) => /untracked/.test(r.reason)) && branches.includes('done'),
      JSON.stringify({ removed: yes?.removed, refused: yes?.refused, failed: yes?.failed, branches }));
    const hist = await evalIn('return await window.api.historyGet()');
    const he = (hist || []).find((h) => h.scope === 'worktrees');
    check('history logs the removal with a git worktree add hint', !!he && he.items.some((i) => i.outcome === 'removed' && /^git worktree add /.test(i.restoreHint || '')));
    const pr = await evalIn(`return await window.api.pruneWorktrees(${JSON.stringify(rec?.path)})`);
    const listed = git(repo, 'worktree', 'list', '--porcelain');
    check('prune clears the missing worktree only', pr?.ok === true && pr.pruned === 1 && !/prunable/.test(listed) && fs.existsSync(wt('wip')), JSON.stringify(pr));
  } catch (e) {
    check('worktree scenario', false, e.message);
  } finally { fs.rmSync(wroot, { recursive: true, force: true }); }

  // The disk card must name the disk the way this OS does.
  const text = await evalIn('return document.body.innerText');
  check('disk label matches the OS', process.platform === 'darwin' || !/Macintosh HD/.test(text));

  // Storage: the breakdown returns, its categories add up to used (within 2%)
  // or the gap is named, and the System drill-down lists items with tiers.
  const bd = await evalIn('return await window.api.storageMeasure()');
  const cats = bd?.categories || [];
  const sum = cats.reduce((a, c) => a + (c.bytes || 0), 0);
  const sysCat = cats.find((c) => c.key === 'system');
  check('storage breakdown returns', bd?.meta?.version === 2 && bd.used > 0 && cats.length > 0,
    JSON.stringify({ used: bd?.used, categories: cats.map((c) => c.key), seconds: Math.round((bd?.meta?.durationMs || 0) / 1000) }));
  const gap = Math.abs(sum - (bd?.used || 0));
  const within = bd?.used > 0 && gap <= bd.used * 0.02;
  const remainder = sysCat?.remainder || { bytes: 0, parts: [] };
  const named = (remainder.bytes <= (bd?.used || 0) * 0.02 || (remainder.parts || []).length > 0) && (!bd?.reconcile || (bd.reconcile.upperBound || []).length > 0);
  check('storage adds up to used within 2%, or names the remainder', (within || !!bd?.reconcile) && named,
    JSON.stringify({ used: bd?.used, sum, explained: bd?.explained, unexplained: bd?.unexplained, parts: (remainder.parts || []).map((p) => p.key), reconcile: bd?.reconcile }));
  const sysItems = [...(sysCat?.os || []), ...(sysCat?.areas || []), ...(remainder.parts || []), ...(sysCat?.info || [])];
  check('System drill lists items, each with a tier, tier D with its OS command',
    sysItems.length > 0 && sysItems.every((i) => ['A', 'B', 'C', 'D'].includes(i.tier)) && sysItems.filter((i) => i.tier === 'D').every((i) => i.command || i.commandNote),
    sysItems.map((i) => `${i.key}:${i.tier}`).join(' '));
  const drill = await evalIn(`const S = window.SP.state; S.breakdown = await window.api.diskBreakdown();
    S.activeCat = (S.breakdown.categories || []).find((c) => c.key === 'system'); window.SP.go('storagecat');
    await new Promise((r) => setTimeout(r, 800)); return document.body.innerText`);
  check('System drill-down renders its sections', /Not visible to Spaci/.test(drill) && /System folders|Managed by/.test(drill), drill.slice(0, 160).replace(/\s+/g, ' '));

  if (WITH_DOCKER) {
    const before = dockerImageCount();
    const st = await evalIn('return await window.api.dockerStatus(true)');
    const state = st?.state || st?.status?.state;
    check('docker is detected and running', state === 'running', JSON.stringify(state));
    const recs = await evalIn(`return await window.api.recommendations({ projects: [], sysTargets: [] })`);
    // Removing every unused image is a deliberate action on System > Docker,
    // not a recommendation; if a card ever offers it, it must not be Safe.
    const rec = (recs || []).find((r) => r.id === 'docker:unused-images');
    check('unused images are never recommended as Safe', !rec || rec.safe === false, JSON.stringify(rec && { title: rec.title, safe: rec.safe }));
    const refused = await evalIn(`return await window.api.dockerPrune('unused-images')`);
    check('unused-images prune needs a confirm', refused?.ok === false && refused.error === 'needs-confirmation' && dockerImageCount() === before);
    const res = await evalIn(`return await window.api.dockerPrune('unused-images', { confirmed: true })`);
    const after = dockerImageCount();
    check('confirmed prune frees real space and removes the images', res?.ok === true && res.freed > 0 && after < before, JSON.stringify({ freed: res?.freed, before, after }));
    const recs2 = await evalIn(`return await window.api.recommendations({ projects: [], sysTargets: [] })`);
    check('the recommendation is gone after cleaning', !(recs2 || []).some((r) => r.id === 'docker:unused-images'));
  }

  await evalIn('window.api.quitApp(); return true').catch(() => {});
  for (let i = 0; i < 20 && exited === null; i++) await sleep(250);
  check('Quit exits the app', exited !== null, JSON.stringify(exited));
} catch (e) {
  check('harness', false, e.message);
} finally {
  if (exited === null) app.kill('SIGKILL');
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed on ${process.platform}`);
  const crash = /Uncaught|UnhandledPromiseRejection|TypeError|ReferenceError/.exec(log);
  console.log(crash ? `main-process log shows: ${crash[0]}\n${log.slice(Math.max(0, crash.index - 300), crash.index + 800)}` : 'no uncaught errors in the main-process log');
  process.exit(failed ? 1 : 0);
}
