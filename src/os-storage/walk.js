'use strict';
// Bounded Node folder walk, for Windows (no du) and as a fallback elsewhere.
// Same result shape as du.js duTree: bytes so far are kept when time runs out
// (confidence 'partial'), permission errors are counted (a lower bound,
// 'denied'), symlinks and junctions are never followed (Node reports a
// junction as a symbolic link), and a hard-linked file counts once.
//
// Sizes are allocated blocks where the OS reports them (st_blocks), else the
// logical size: Node on Windows has no allocated size, so sparse and
// compressed files can read larger than they are.

const fs = require('fs');
const path = require('path');

async function walkTree(root, { timeoutMs = 90000, signal, fsp = fs.promises, now = Date.now } = {}) {
  const deadline = now() + timeoutMs;
  const api = /^[a-zA-Z]:[\\/]/.test(root) || root.includes('\\') ? path.win32 : path.posix;
  let rootSt;
  try { rootSt = await fsp.lstat(root); } catch (e) {
    const denied = e && (e.code === 'EPERM' || e.code === 'EACCES');
    return denied ? { path: root, bytes: 0, confidence: 'denied', children: [], denied: 1, deniedPaths: [root] } : null;
  }
  if (rootSt.isSymbolicLink()) return null;
  if (rootSt.isFile()) return { path: root, bytes: sizeOf(rootSt), confidence: 'exact', children: [], denied: 0, deniedPaths: [] };
  const seen = new Set();
  const top = new Map(); // first-level child -> bytes
  const deniedPaths = [];
  let total = 0;
  let timedOut = false;
  const stack = [[root, null]];
  while (stack.length) {
    if (now() > deadline || (signal && signal.aborted)) { timedOut = true; break; }
    const [dir, first] = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) {
      if (e && (e.code === 'EPERM' || e.code === 'EACCES')) deniedPaths.push(dir);
      continue;
    }
    for (const ent of entries) {
      const full = api.join(dir, ent.name);
      const bucket = first || full;
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) { stack.push([full, bucket]); if (!first) top.set(full, top.get(full) || 0); continue; }
      if (!ent.isFile()) continue;
      let st;
      try { st = await fsp.lstat(full); } catch (e) {
        if (e && (e.code === 'EPERM' || e.code === 'EACCES')) deniedPaths.push(full);
        continue;
      }
      if (st.nlink > 1 && st.ino) { const k = st.dev + ':' + st.ino; if (seen.has(k)) continue; seen.add(k); }
      const b = sizeOf(st);
      total += b;
      top.set(bucket, (top.get(bucket) || 0) + b);
    }
  }
  return {
    path: root,
    bytes: total,
    confidence: timedOut ? 'partial' : (deniedPaths.length ? 'denied' : 'exact'),
    children: Array.from(top, ([p, bytes]) => ({ path: p, bytes })).sort((a, b) => b.bytes - a.bytes),
    denied: deniedPaths.length,
    deniedPaths: deniedPaths.slice(0, 50),
  };
}

function sizeOf(st) {
  return typeof st.blocks === 'number' && st.blocks > 0 ? st.blocks * 512 : Number(st.size) || 0;
}

module.exports = { walkTree };
