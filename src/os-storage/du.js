'use strict';
// Streaming `du` for macOS and Linux.
//
// `du -xk -d 1 <root>` prints each first-level child as soon as it is done and
// the root last. Reading the stream means a root that runs out of time still
// reports the children it finished (confidence 'partial') instead of 0, which
// used to push tens of GB into the System remainder. -x keeps it on one
// filesystem (no mounted disk images, no /Volumes), -k gives allocated 1 KB
// blocks (sparse files count what they really occupy).
//
// du counts hard links once per invocation, but it counts APFS clones in full:
// they are separate inodes that share extents. Clone-heavy folders are sized
// with clonesize.js instead.

const { spawn } = require('child_process');

// "123\t/path" (both BSD and GNU du).
function parseDuLine(line) {
  const m = /^(\d+)\s+(.+)$/.exec(String(line || '').trim());
  if (!m) return null;
  return { bytes: Number(m[1]) * 1024, path: m[2] };
}

// BSD: "du: /a/b: Permission denied" / "Operation not permitted"
// GNU: "du: cannot read directory '/a/b': Permission denied"
//      "du: cannot access '/a/b': Permission denied"
function parseDuErrorLine(line) {
  const s = String(line || '').trim();
  if (!/Permission denied|Operation not permitted/.test(s)) return null;
  const gnu = /^du: cannot (?:read directory|access|open directory) ['‘]?(.+?)['’]?: (?:Permission denied|Operation not permitted)/.exec(s);
  if (gnu) return gnu[1];
  const bsd = /^du: (.+): (?:Permission denied|Operation not permitted)$/.exec(s);
  return bsd ? bsd[1] : null;
}

/** Parse a whole `du -d 1` run (used by tests and by duTree on exit). */
function parseDuOutput(stdout, stderr, root) {
  const children = [];
  let total = null;
  for (const line of String(stdout || '').split('\n')) {
    const r = parseDuLine(line);
    if (!r) continue;
    if (r.path === root || r.path === root.replace(/\/+$/, '')) total = r.bytes;
    else children.push(r);
  }
  const denied = [];
  for (const line of String(stderr || '').split('\n')) {
    const p = parseDuErrorLine(line);
    if (p) denied.push(p);
  }
  return { total, children, denied };
}

/**
 * Measure `root` with one du process.
 * @returns {Promise<{ path, bytes, confidence: 'exact'|'partial'|'denied', children: {path,bytes}[], denied: number, deniedPaths: string[] }>}
 */
function duArgs(root, { depth = 1, exclude = [], platform = process.platform } = {}) {
  const args = ['-xk', '-d', String(depth)];
  // BSD du: -I mask ignores entries with that name; GNU du: --exclude=PATTERN.
  for (const e of exclude || []) args.push(...(platform === 'darwin' ? ['-I', e] : ['--exclude=' + e]));
  args.push(root);
  return args;
}

function duTree(root, { timeoutMs = 300000, depth = 1, exclude = [], platform = process.platform, signal, onChild, spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let buf = '';
    let done = false;
    let killed = false;
    const children = [];
    let child;
    try {
      child = spawnFn('du', duArgs(root, { depth, exclude, platform }), { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ path: root, bytes: 0, confidence: 'denied', children: [], denied: 0, deniedPaths: [] });
      return;
    }
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (buf) out += buf;
      const parsed = parseDuOutput(out, err, root);
      const deniedPaths = parsed.denied;
      let bytes;
      let confidence;
      if (parsed.total != null && !killed) {
        bytes = parsed.total;
        // du still prints a total when some folders were unreadable: a lower bound.
        confidence = deniedPaths.length ? 'denied' : 'exact';
      } else {
        bytes = children.reduce((a, c) => a + c.bytes, 0);
        confidence = killed ? 'partial' : (deniedPaths.length ? 'denied' : 'partial');
      }
      resolve({
        path: root,
        bytes,
        confidence,
        children: parsed.children.sort((a, b) => b.bytes - a.bytes),
        denied: deniedPaths.length,
        deniedPaths: deniedPaths.slice(0, 50),
      });
    };
    const onAbort = () => { killed = true; try { child.kill('SIGKILL'); } catch (_) {} };
    const timer = setTimeout(onAbort, timeoutMs);
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort); }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        out += line + '\n';
        const r = parseDuLine(line);
        if (r && r.path !== root) {
          children.push(r);
          if (onChild) { try { onChild(r); } catch (_) {} }
        }
      }
    });
    child.stderr.on('data', (d) => { if (err.length < 256 * 1024) err += d; });
    child.on('error', finish);
    child.on('close', finish);
  });
}

module.exports = { duTree, duArgs, parseDuLine, parseDuErrorLine, parseDuOutput };
