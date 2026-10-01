'use strict';
/**
 * One snapshot of running processes, shared by every detector in a single
 * inventory pass (one process call in total, never one per tool).
 *
 *   macOS, Linux: ps -axo pid=,args=
 *   Windows:      Get-CimInstance Win32_Process (name, path, command line)
 *
 * Resolves to { ok, list: [{ pid, args }] } and never rejects. ok:false means
 * Spaci could not see running processes, which callers treat as "maybe
 * running" (fail closed).
 */

const { run } = require('./util');

const WIN_QUERY = "Get-CimInstance Win32_Process | ForEach-Object { 'SPACI_PROC:' + $_.ProcessId + '|' + $_.ExecutablePath + '|' + $_.CommandLine }";

function parsePs(stdout) {
  const list = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m) list.push({ pid: Number(m[1]), args: m[2] });
  }
  return list;
}

function parseWin(stdout) {
  const list = [];
  for (const raw of String(stdout || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('SPACI_PROC:')) continue;
    const [pid, exe, ...rest] = line.slice('SPACI_PROC:'.length).split('|');
    const cmd = rest.join('|');
    list.push({ pid: Number(pid) || 0, args: (cmd || exe || '').trim(), exe: exe || '' });
  }
  return list;
}

async function processList(options = {}) {
  const platform = options.platform || process.platform;
  if (platform === 'win32') {
    const r = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', WIN_QUERY], { exec: options.exec, timeout: options.timeout || 15000 });
    const list = r.ok ? parseWin(r.stdout) : [];
    return { ok: r.ok && list.length > 0, list };
  }
  const r = await run('ps', ['-axo', 'pid=,args='], { exec: options.exec, timeout: options.timeout || 5000 });
  const list = r.ok ? parsePs(r.stdout) : [];
  return { ok: r.ok && list.length > 0, list };
}

/** Processes whose command line matches re. */
function matching(procs, re) {
  if (!procs || !Array.isArray(procs.list)) return [];
  return procs.list.filter((p) => re.test(p.args || ''));
}

/** 'yes' | 'no' | 'unknown' for "is any process matching re running". */
function runningState(procs, re) {
  if (!procs || !procs.ok) return 'unknown';
  return matching(procs, re).length ? 'yes' : 'no';
}

module.exports = { processList, parsePs, parseWin, matching, runningState };
