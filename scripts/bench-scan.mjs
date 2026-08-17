#!/usr/bin/env node
// Time a real project scan, the way the app runs it.
//
//   node scripts/bench-scan.mjs ~/projects
//   node scripts/bench-scan.mjs ~/projects --compare path/to/old-scanner.js
//
// The scan is IO bound, so run it twice if you care about warm-cache numbers:
// the first pass on a cold page cache is dominated by the filesystem.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const scanner = require(path.join(here, '..', 'src', 'scanner.js'));

const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith('--')) || path.join(os.homedir(), 'projects');
const compareAt = args.includes('--compare') ? args[args.indexOf('--compare') + 1] : null;

const GB = (b) => +(b / 1024 ** 3).toFixed(2);

async function run(impl, label) {
  const started = Date.now();
  const { projects, scanned } = await impl.scanProjects(root, null, new AbortController().signal);
  const ms = Date.now() - started;
  const real = projects.filter((p) => !p.dockerOnly);
  return {
    label,
    ms,
    dirsScanned: scanned,
    projects: real.length,
    dockerOnlyFolders: projects.length - real.length,
    usingDocker: projects.filter((p) => p.docker).length,
    artifacts: projects.reduce((s, p) => s + p.items.length, 0),
    reclaimableGB: GB(projects.reduce((s, p) => s + p.cleanableSize, 0)),
    projectPaths: new Set(real.map((p) => p.path)),
  };
}

const now = await run(scanner, 'current');
const report = (r) => console.log(
  `${r.label.padEnd(8)} ${String(r.ms).padStart(7)} ms   ${String(r.projects).padStart(4)} projects   `
  + `${String(r.artifacts).padStart(4)} artifacts   ${String(r.reclaimableGB).padStart(6)} GB reclaimable`
);

console.log(`root: ${root}`);
report(now);

if (compareAt) {
  const before = await run(require(path.resolve(compareAt)), 'baseline');
  report(before);
  const missed = [...before.projectPaths].filter((p) => !now.projectPaths.has(p));
  console.log(`\nspeedup: ${(before.ms / now.ms).toFixed(1)}x`);
  console.log(`projects the current scanner misses vs the baseline: ${missed.length}`);
  for (const p of missed.slice(0, 10)) console.log('  -', p);
}

// Docker is measured separately: it is one daemon call, not part of the walk.
const dockerStart = Date.now();
const { inventory } = await scanner.attachDockerUsage([]);
if (inventory && inventory.ok) {
  console.log(
    `\ndocker: ${Date.now() - dockerStart} ms   ${GB(inventory.totals.size)} GB stored, `
    + `${GB(inventory.totals.reclaimable)} GB reclaimable`
  );
} else {
  console.log(`\ndocker: unavailable (${inventory ? inventory.reason : 'unknown'})`);
}
console.log(`projects declaring Docker: ${now.usingDocker}, compose-only folders: ${now.dockerOnlyFolders}`);
