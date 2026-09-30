'use strict';
/**
 * Spaci: Docker awareness.
 *
 * Docker is invisible to a filesystem scan. On macOS and Windows every image,
 * container, volume and build-cache layer lives inside one opaque VM disk file,
 * so a machine can be tens of gigabytes into Docker while `du` over the home
 * folder reports nothing. This module asks the Docker CLI instead.
 *
 * Three things are exposed:
 *   1. status()      is Docker installed, is the daemon up (cheap, cached).
 *   2. inventory()   one `docker system df -v` call, parsed into sizes.
 *   3. detect()      does a scanned project use Docker (no IO, reads the
 *                    directory listing the scanner already has).
 *
 * Nothing here throws. A missing binary, a stopped daemon or a hung command
 * degrades to "not available" so a Docker-less machine scans exactly as before.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// `docker system df -v` walks every layer, so give it room; the daemon probe is
// a metadata read and must stay snappy.
const PROBE_TIMEOUT_MS = 6000;
const INVENTORY_TIMEOUT_MS = 25000;
const PRUNE_TIMEOUT_MS = 120000;

// How long a status/inventory result stays fresh. Docker sizes move slowly and
// the UI polls on every screen paint, so a short cache avoids a CLI storm.
const CACHE_MS = 60000;
// A probe that timed out is not an answer: a big build can make a healthy engine
// slow for a moment. Remember it only briefly so the UI recovers fast.
const TIMEOUT_CACHE_MS = 5000;

// ---------------------------------------------------------------------------
// Finding the binary
// ---------------------------------------------------------------------------

/**
 * Electron apps launched from Finder inherit launchd's minimal PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin), which contains no Docker. Looking up the
 * usual install locations ourselves is the difference between "Docker not
 * installed" and real numbers for every GUI launch.
 */
function candidateBinaries(platform = process.platform, home = os.homedir()) {
  if (platform === 'win32') {
    const files = process.env.ProgramFiles || 'C:\\Program Files';
    return [
      path.win32.join(files, 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'),
      path.win32.join(home, 'AppData', 'Local', 'Docker', 'cli-plugins', 'docker.exe'),
    ];
  }
  return [
    '/usr/local/bin/docker',
    '/opt/homebrew/bin/docker',
    '/usr/bin/docker',
    path.posix.join(home, '.docker', 'bin', 'docker'),
    path.posix.join(home, '.rd', 'bin', 'docker'), // Rancher Desktop
    '/Applications/Docker.app/Contents/Resources/bin/docker',
  ];
}

/** docker on the inherited PATH, if there is one. */
function binaryOnPath(platform = process.platform, env = process.env) {
  const exe = platform === 'win32' ? 'docker.exe' : 'docker';
  const sep = platform === 'win32' ? ';' : ':';
  for (const dir of String(env.PATH || '').split(sep)) {
    if (!dir) continue;
    const candidate = path.join(dir, exe);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* next */ }
  }
  return null;
}

let binaryCache;
/**
 * Absolute path to the docker CLI. The user's PATH wins so we run the same
 * binary their terminal does; the hardcoded locations are the fallback that
 * makes a Finder-launched build work at all.
 */
function dockerBinary(options = {}) {
  if (options.binary) return options.binary;
  if (binaryCache !== undefined) return binaryCache;
  const found = binaryOnPath();
  if (found) { binaryCache = found; return binaryCache; }
  for (const candidate of candidateBinaries()) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      binaryCache = candidate;
      return binaryCache;
    } catch { /* try the next one */ }
  }
  binaryCache = 'docker';
  return binaryCache;
}

// ---------------------------------------------------------------------------
// Running commands
// ---------------------------------------------------------------------------

/**
 * Run a docker subcommand. Never rejects: the result carries ok/stdout/error so
 * callers can treat "Docker missing" and "Docker angry" the same way.
 * `options.exec` swaps the runner out in tests.
 */
function runDocker(args, options = {}) {
  const exec = options.exec || execFile;
  const timeout = options.timeout || PROBE_TIMEOUT_MS;
  return new Promise((resolve) => {
    let child;
    try {
      child = exec(
        dockerBinary(options),
        args,
        { timeout, maxBuffer: 32 * 1024 * 1024, signal: options.signal, env: process.env },
        (err, stdout, stderr) => {
          const out = String(stdout || '');
          if (err) {
            return resolve({
              ok: false,
              stdout: out,
              error: cliError(err, stderr),
            });
          }
          resolve({ ok: true, stdout: out, error: null });
        }
      );
    } catch (err) {
      return resolve({ ok: false, stdout: '', error: err.message });
    }
    // execFile with a bad binary path emits 'error' asynchronously on some
    // platforms rather than calling back; guard so we always settle.
    child?.on?.('error', () => { /* the callback above still fires */ });
  });
}

function cliError(err, stderr) {
  const text = String(stderr || err.message || '').trim();
  if (err.code === 'ENOENT') return 'docker CLI not found';
  if (err.killed) return 'docker timed out';
  return text.split('\n')[0] || 'docker failed';
}

// ---------------------------------------------------------------------------
// Size parsing
// ---------------------------------------------------------------------------

// Docker formats sizes with go-units: decimal (kB/MB/GB) for humans, and the
// binary spelling (KiB/MiB) in a few places. Handle both.
const UNITS = {
  b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, pb: 1e15,
  kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, pib: 1024 ** 5,
};

/** '12.48GB' -> 12480000000. Unparseable or 'N/A' -> 0. */
function parseSize(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text || text === 'N/A') return 0;
  const m = text.match(/^([\d.]+)\s*([a-zA-Z]*)$/);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  const unit = UNITS[m[2].toLowerCase()] ?? (m[2] ? 0 : 1);
  return Math.round(n * unit);
}

/** '12.48GB (75%)' -> { bytes, percent }. */
function parseReclaimable(value) {
  const text = String(value == null ? '' : value).trim();
  const m = text.match(/\((\d+)%\)/);
  return {
    bytes: parseSize(text.replace(/\s*\(.*\)\s*$/, '')),
    percent: m ? Number(m[1]) : null,
  };
}

/** Docker prints labels as "k=v,k2=v2". Returns a plain object. */
function parseLabels(value) {
  const out = {};
  for (const pair of String(value || '').split(',')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

let statusCache = null;
let statusTtl = CACHE_MS;

// The engine probe must fail fast: on a wedged Docker Desktop `docker version`
// can hang for minutes, and the UI polls this.
const ENGINE_PROBE_MS = 4000;

/**
 * Is a Docker Desktop backend process alive? Separates "Desktop is starting or
 * wedged" from "Desktop is not running at all". Best-effort: any failure to ask
 * counts as "no", which degrades to the `stopped` state.
 */
function backendRunning(options = {}, platform = process.platform) {
  if (typeof options.backendRunning === 'function') {
    return Promise.resolve(options.backendRunning()).then(Boolean, () => false);
  }
  return new Promise((resolve) => {
    const exec = options.processExec || execFile;
    // macOS pgrep -x matches the full process name. Linux procps truncates
    // the name it matches to 15 characters ("com.docker.back"), so -x can never
    // match there; match the executable path in the command line instead,
    // anchored so a `tail -f .../com.docker.backend.log` does not count.
    const [cmd, args] = platform === 'win32'
      ? ['tasklist', ['/FI', 'IMAGENAME eq com.docker.backend.exe', '/NH']]
      : platform === 'linux'
        ? ['pgrep', ['-f', '(^|/)com\\.docker\\.backend( |$)']]
        : ['pgrep', ['-x', 'com.docker.backend']];
    try {
      exec(cmd, args, { timeout: 3000 }, (err, stdout) => {
        if (platform === 'win32') return resolve(/com\.docker\.backend/i.test(String(stdout || '')));
        resolve(!err && String(stdout || '').trim().length > 0);
      });
    } catch { resolve(false); }
  });
}

/** Only a local socket or pipe means the engine runs on this machine. */
function isLocalEndpoint(host) {
  return /^(unix|npipe):\/\//i.test(String(host || '').trim());
}

/**
 * The endpoint the CLI will talk to: DOCKER_HOST wins (the CLI honours it over
 * the context), else the current context's host. null when it cannot be read.
 */
async function currentEndpoint(options = {}) {
  const env = options.env || process.env;
  if (env.DOCKER_HOST && String(env.DOCKER_HOST).trim()) return String(env.DOCKER_HOST).trim();
  const res = await runDocker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], {
    ...options,
    timeout: ENGINE_PROBE_MS,
  });
  const host = res.ok ? res.stdout.trim() : '';
  return host || null;
}

/** Linux without the docker group: the socket exists but may not be opened. */
function isPermissionError(message) {
  return /permission denied/i.test(String(message || '')) && /docker\.sock/i.test(String(message || ''));
}

/**
 * Is Docker usable right now? `docker version` answers both questions in one
 * call: the client block proves it is installed, the server block proves the
 * daemon is up. It costs ~0.2s, unlike `docker info` which can take seconds.
 *
 * `state` is the field to branch on:
 *   not-installed  no docker CLI
 *   stopped        CLI present, no Desktop backend process
 *   engine-down    Desktop backend running but the engine does not answer
 *   running        engine answered
 *   no-permission  engine socket exists but this user may not open it (Linux)
 * `installed` and `running` stay for existing callers. `remote` is true when
 * the current context points at another host (ssh://, tcp://); the answer then
 * describes that host, not this machine.
 */
async function status(options = {}) {
  if (!options.force && statusCache && Date.now() - statusCache.checkedAt < statusTtl) {
    return statusCache;
  }
  const res = await runDocker(['version', '--format', '{{json .}}'], {
    ...options,
    timeout: options.timeout || ENGINE_PROBE_MS,
  });

  let parsed = null;
  try { parsed = JSON.parse(res.stdout); } catch { parsed = null; }

  const client = parsed && parsed.Client;
  const server = parsed && parsed.Server;
  const running = Boolean(server && server.Version);
  // Only a missing binary means "not installed". A timeout or a refusing daemon
  // proves a CLI exists.
  const installed = res.error !== 'docker CLI not found';

  let state = 'running';
  if (!running) {
    if (!installed) state = 'not-installed';
    else if (isPermissionError(res.error)) state = 'no-permission';
    else state = (await backendRunning(options)) ? 'engine-down' : 'stopped';
  }

  const endpoint = running ? await currentEndpoint(options) : null;

  const value = {
    state,
    installed,
    running,
    clientVersion: client ? client.Version : null,
    serverVersion: server ? server.Version : null,
    platform: server && server.Platform ? server.Platform.Name : null,
    error: res.ok ? null : res.error,
    endpoint,
    remote: Boolean(endpoint) && !isLocalEndpoint(endpoint),
    checkedAt: Date.now(),
  };
  statusCache = value;
  statusTtl = res.error === 'docker timed out' ? TIMEOUT_CACHE_MS : CACHE_MS;
  return value;
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

const EMPTY_CATEGORY = { count: 0, active: 0, size: 0, reclaimable: 0, percent: null };

/**
 * Parse `docker system df -v --format json`, which returns one object with
 * Images / Containers / Volumes / BuildCache arrays. Everything is a formatted
 * string ("608MB"), so each entry gets a numeric `bytes` alongside.
 */
function parseInventory(stdout) {
  let raw;
  try { raw = JSON.parse(stdout); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;

  const images = (raw.Images || []).map((i) => ({
    id: i.ID,
    repository: i.Repository,
    tag: i.Tag,
    bytes: parseSize(i.Size),
    uniqueBytes: parseSize(i.UniqueSize),
    sharedBytes: parseSize(i.SharedSize),
    containers: Number(i.Containers) || 0,
    createdSince: i.CreatedSince || '',
    // An image no container references is what `docker image prune -a` removes.
    dangling: i.Repository === '<none>' || i.Tag === '<none>',
  }));

  const containers = (raw.Containers || []).map((c) => {
    const labels = parseLabels(c.Labels);
    return {
      id: c.ID,
      name: c.Names,
      image: c.Image,
      state: c.State,
      status: c.Status,
      // Writable-layer size, e.g. "45.1kB (virtual 608MB)".
      bytes: parseSize(String(c.Size || '').split('(')[0]),
      project: labels['com.docker.compose.project'] || null,
      // Compose stamps the directory the project was started from, which is the
      // join key back to a scanned project on disk.
      workingDir: labels['com.docker.compose.project.working_dir'] || null,
      service: labels['com.docker.compose.service'] || null,
      running: /^running|^up/i.test(String(c.State || c.Status || '')),
    };
  });

  const volumes = (raw.Volumes || []).map((v) => {
    const labels = parseLabels(v.Labels);
    return {
      name: v.Name,
      bytes: parseSize(v.Size),
      links: Number(v.Links) || 0,
      project: labels['com.docker.compose.project'] || null,
      anonymous: 'com.docker.volume.anonymous' in labels,
    };
  });

  const buildCache = (raw.BuildCache || []).map((b) => ({
    id: b.ID,
    type: b.CacheType,
    bytes: parseSize(b.Size),
    inUse: b.InUse === true || b.InUse === 'true',
    shared: b.Shared === true || b.Shared === 'true',
    lastUsedSince: b.LastUsedSince || '',
  }));

  return { images, containers, volumes, buildCache };
}

/** Roll `docker system df` (the summary form) up into per-category totals. */
function parseSummary(stdout) {
  const categories = {
    images: { ...EMPTY_CATEGORY },
    containers: { ...EMPTY_CATEGORY },
    volumes: { ...EMPTY_CATEGORY },
    buildCache: { ...EMPTY_CATEGORY },
  };
  const KEYS = {
    'Images': 'images',
    'Containers': 'containers',
    'Local Volumes': 'volumes',
    'Build Cache': 'buildCache',
  };
  for (const line of String(stdout || '').split('\n')) {
    const text = line.trim();
    if (!text) continue;
    let row;
    try { row = JSON.parse(text); } catch { continue; }
    const key = KEYS[row.Type];
    if (!key) continue;
    const reclaimable = parseReclaimable(row.Reclaimable);
    categories[key] = {
      count: Number(row.TotalCount) || 0,
      active: Number(row.Active) || 0,
      size: parseSize(row.Size),
      reclaimable: reclaimable.bytes,
      percent: reclaimable.percent,
    };
  }
  return categories;
}

function totalsOf(categories) {
  const list = Object.values(categories);
  return {
    size: list.reduce((s, c) => s + c.size, 0),
    reclaimable: list.reduce((s, c) => s + c.reclaimable, 0),
  };
}

/**
 * Derive the same per-category totals from a verbose inventory, so one
 * `docker system df -v` call answers both "how big" and "which project".
 * Reclaimable means: images no container uses, stopped containers, volumes
 * nothing links to, and build cache not currently in use.
 */
function summarise(inv) {
  const images = {
    count: inv.images.length,
    active: inv.images.filter((i) => i.containers > 0).length,
    size: inv.images.reduce((s, i) => s + i.bytes, 0),
    // Unique size avoids counting a shared base layer once per image.
    reclaimable: inv.images.filter((i) => i.containers === 0)
      .reduce((s, i) => s + (i.uniqueBytes || i.bytes), 0),
    percent: null,
  };
  const containers = {
    count: inv.containers.length,
    active: inv.containers.filter((c) => c.running).length,
    size: inv.containers.reduce((s, c) => s + c.bytes, 0),
    reclaimable: inv.containers.filter((c) => !c.running).reduce((s, c) => s + c.bytes, 0),
    percent: null,
  };
  const volumes = {
    count: inv.volumes.length,
    active: inv.volumes.filter((v) => v.links > 0).length,
    size: inv.volumes.reduce((s, v) => s + v.bytes, 0),
    reclaimable: inv.volumes.filter((v) => v.links === 0).reduce((s, v) => s + v.bytes, 0),
    percent: null,
  };
  const buildCache = {
    count: inv.buildCache.length,
    active: inv.buildCache.filter((b) => b.inUse).length,
    size: inv.buildCache.reduce((s, b) => s + b.bytes, 0),
    reclaimable: inv.buildCache.filter((b) => !b.inUse).reduce((s, b) => s + b.bytes, 0),
    percent: null,
  };
  return { images, containers, volumes, buildCache };
}

let inventoryCache = null;

/**
 * Full Docker picture in one CLI call. Returns { ok:false } (never throws) when
 * Docker is missing or the daemon is down.
 */
async function inventory(options = {}) {
  if (!options.force && inventoryCache && Date.now() - inventoryCache.at < CACHE_MS) {
    return inventoryCache.value;
  }
  const st = options.status || (await status(options));
  if (!st.running) {
    const value = { ok: false, reason: !st.installed ? 'not-installed' : st.state === 'no-permission' ? 'no-permission' : 'daemon-not-running', state: st.state, status: st };
    inventoryCache = { at: Date.now(), value };
    return value;
  }

  // Two calls, run together. The summary is what Docker itself reports and is
  // the only one that de-duplicates layers shared between images, so it owns the
  // headline numbers; the verbose form supplies the per-item detail and the
  // compose labels that tie storage back to a project on disk.
  const timeout = options.timeout || INVENTORY_TIMEOUT_MS;
  const [res, brief0] = await Promise.all([
    runDocker(['system', 'df', '-v', '--format', 'json'], { ...options, timeout }),
    runDocker(['system', 'df', '--format', 'json'], { ...options, timeout }),
  ]);
  const parsed = res.ok ? parseInventory(res.stdout) : null;
  if (!parsed) {
    // The verbose form walks every layer and can time out on a very full
    // daemon. The summary form only reads totals, so fall back to it: the UI
    // still gets real numbers, just without per-project attribution.
    const brief = brief0;
    if (brief.ok) {
      const categories = parseSummary(brief.stdout);
      const value = {
        ok: true, partial: true, status: st, categories, totals: totalsOf(categories),
        images: [], containers: [], volumes: [], buildCache: [], at: Date.now(),
      };
      inventoryCache = { at: Date.now(), value };
      return value;
    }
    const value = { ok: false, reason: 'unreadable', error: res.error || brief.error, status: st };
    inventoryCache = { at: Date.now(), value };
    return value;
  }

  // Summing per-image sizes double counts shared base layers, so prefer
  // Docker's own de-duplicated totals and only derive them ourselves when the
  // summary call failed.
  const categories = brief0.ok ? parseSummary(brief0.stdout) : summarise(parsed);
  const value = {
    ok: true,
    approximate: !brief0.ok,
    status: st,
    categories,
    totals: totalsOf(categories),
    ...parsed,
    at: Date.now(),
  };
  inventoryCache = { at: Date.now(), value };
  return value;
}

// ---------------------------------------------------------------------------
// The Docker Desktop VM disk
// ---------------------------------------------------------------------------

/**
 * On macOS and Windows the whole engine lives in one sparse disk image. It is
 * worth surfacing because it never shrinks on its own: pruning frees space
 * inside the VM, but the host file keeps its high-water mark until Docker
 * Desktop compacts it.
 */
function desktopDiskPaths(platform = process.platform, home = os.homedir()) {
  if (platform === 'darwin') {
    const base = path.join(home, 'Library', 'Containers', 'com.docker.docker', 'Data');
    return [
      path.join(base, 'vms', '0', 'data', 'Docker.raw'),
      path.join(base, 'vms', '0', 'Docker.raw'),
      path.join(base, 'vms', '0', 'data', 'Docker.qcow2'),
    ];
  }
  if (platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local');
    return [
      path.win32.join(local, 'Docker', 'wsl', 'data', 'ext4.vhdx'),
      path.win32.join(local, 'Docker', 'wsl', 'disk', 'docker_data.vhdx'),
    ];
  }
  return [];
}

/**
 * The VM disk image, or null when there is not one (Linux). `bytes` and
 * `allocatedBytes` are what it occupies on the host; `apparentBytes` is the
 * size the file claims, which the UI should only use to explain the gap.
 */
async function desktopDisk(platform = process.platform, home = os.homedir()) {
  for (const p of desktopDiskPaths(platform, home)) {
    try {
      const st = await fs.promises.stat(p);
      if (st.isFile()) {
        // Never `size`: a sparse 460 GB image can occupy 54 GB. Only fall back
        // to size where the platform reports no block count at all.
        const allocated = typeof st.blocks === 'number' ? st.blocks * 512 : st.size;
        return {
          path: p,
          // Apparent size is the disk the VM believes it has; blocks*512 is what
          // the sparse file actually occupies on the host, which is the honest
          // number to show.
          bytes: allocated,
          allocatedBytes: allocated,
          apparentBytes: st.size,
          sparse: allocated < st.size,
        };
      }
    } catch { /* next candidate */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-project detection (no IO: the scanner already read this listing)
// ---------------------------------------------------------------------------

const COMPOSE_FILES = new Set([
  'docker-compose.yml', 'docker-compose.yaml',
  'compose.yml', 'compose.yaml',
  'docker-compose.override.yml', 'docker-compose.override.yaml',
  'docker-compose.dev.yml', 'docker-compose.prod.yml',
]);

function isDockerfile(name) {
  return name === 'Dockerfile' || /^Dockerfile\.[\w.-]+$/.test(name) || /\.[Dd]ockerfile$/.test(name);
}

/**
 * Classify a project's Docker usage from its top-level directory listing.
 * Returns null when there is no Docker in play, so `project.docker` stays absent
 * for the overwhelming majority of folders.
 */
function detect(entries) {
  const names = Array.isArray(entries) ? entries : [];
  const dockerfiles = names.filter(isDockerfile);
  const composeFiles = names.filter((n) => COMPOSE_FILES.has(n));
  const hasIgnore = names.includes('.dockerignore');
  const hasDevcontainer = names.includes('.devcontainer');
  const hasDockerDir = names.includes('docker');

  if (!dockerfiles.length && !composeFiles.length && !hasIgnore && !hasDevcontainer) return null;

  return {
    dockerfiles,
    composeFiles,
    hasDockerignore: hasIgnore,
    hasDevcontainer,
    hasDockerDir,
    // Compose projects own images AND volumes AND networks, so they are the ones
    // worth attributing engine storage to.
    compose: composeFiles.length > 0,
  };
}

/** Service names from a compose file, best-effort and dependency-free. */
async function composeServices(file) {
  let text;
  try { text = await fs.promises.readFile(file, 'utf8'); }
  catch { return []; }
  if (text.length > 512 * 1024) return [];

  const services = [];
  let inServices = false;
  let indent = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\t/g, '  ');
    if (/^\s*#/.test(line) || !line.trim()) continue;
    if (/^services:\s*$/.test(line)) { inServices = true; continue; }
    if (!inServices) continue;
    // A non-indented key ends the services block.
    if (/^\S/.test(line)) break;
    const m = line.match(/^(\s+)([A-Za-z0-9._-]+):\s*(#.*)?$/);
    if (!m) continue;
    if (indent === null) indent = m[1].length;
    if (m[1].length === indent) services.push(m[2]);
  }
  return services;
}

/**
 * Attribute engine storage to scanned projects. Compose labels every container
 * with the directory it was started from, so the match is exact rather than a
 * guess from folder names. Falls back to the compose project name (which
 * defaults to the folder name) for containers started elsewhere.
 */
function usageByProject(inv) {
  const byDir = new Map();
  if (!inv || !inv.ok) return byDir;

  const add = (key, patch) => {
    if (!key) return;
    const cur = byDir.get(key) || {
      project: null, containers: [], images: [], volumes: [],
      containerBytes: 0, imageBytes: 0, volumeBytes: 0, running: 0,
    };
    patch(cur);
    byDir.set(key, cur);
  };

  const imageByRef = new Map();
  for (const img of inv.images) {
    if (img.repository && img.repository !== '<none>') {
      imageByRef.set(`${img.repository}:${img.tag}`, img);
      imageByRef.set(img.repository, img);
    }
  }

  const projectDirs = new Map(); // compose project name -> working dir
  for (const c of inv.containers) {
    if (c.project && c.workingDir) projectDirs.set(c.project, c.workingDir);
  }

  for (const c of inv.containers) {
    const key = c.workingDir || (c.project && projectDirs.get(c.project)) || null;
    add(key, (cur) => {
      cur.project = cur.project || c.project;
      cur.containers.push(c);
      cur.containerBytes += c.bytes;
      if (c.running) cur.running += 1;
      const img = imageByRef.get(c.image);
      if (img && !cur.images.includes(img)) {
        cur.images.push(img);
        cur.imageBytes += img.bytes;
      }
    });
  }

  for (const v of inv.volumes) {
    if (!v.project) continue;
    const key = projectDirs.get(v.project);
    add(key, (cur) => {
      cur.project = cur.project || v.project;
      cur.volumes.push(v);
      cur.volumeBytes += v.bytes;
    });
  }

  for (const [, usage] of byDir) {
    usage.totalBytes = usage.containerBytes + usage.imageBytes + usage.volumeBytes;
  }
  return byDir;
}

// ---------------------------------------------------------------------------
// Reclaiming
// ---------------------------------------------------------------------------

/**
 * Only regenerable things are offered. Volumes are deliberately absent: they
 * hold databases and uploads, and `docker volume prune` is unrecoverable.
 * Anything destructive stays behind a `safe: false` flag the UI must confirm.
 */
const PRUNE_KINDS = {
  'build-cache': {
    id: 'build-cache',
    name: 'Build cache',
    args: ['builder', 'prune', '-f'],
    safe: true,
    description: 'Layer cache from past `docker build` runs. Rebuilds on demand.',
  },
  'dangling-images': {
    id: 'dangling-images',
    name: 'Dangling images',
    args: ['image', 'prune', '-f'],
    safe: true,
    description: 'Untagged image layers left behind by rebuilds. Nothing references them.',
  },
  'stopped-containers': {
    id: 'stopped-containers',
    name: 'Stopped containers',
    args: ['container', 'prune', '-f'],
    safe: false,
    description: 'Removes stopped containers. Their volumes and images are kept.',
  },
};

// Below these, a suggestion is noise rather than a win.
const SUGGEST_MIN_BUILD_CACHE = 500 * 1024 * 1024;
const SUGGEST_MIN_IMAGES = 1024 ** 3;
const SUGGEST_HIGH = 5 * 1024 ** 3;

/**
 * What is worth offering to reclaim, given an inventory. Policy lives here next
 * to PRUNE_KINDS so the two can never drift; the caller owns the wording.
 */
function reclaimSuggestions(info) {
  if (!info) return [];
  // Prune refuses on a remote context, so do not offer it.
  if (info.status && info.status.remote) return [];
  const out = [];
  const platform = info.platform || process.platform;
  const disk = info.desktopDisk || info.disk || null;

  if (!info.ok || !info.categories) {
    // Engine unreachable: pruning is impossible, but the disk image is still
    // the biggest thing Docker owns and the user deserves the real number.
    if (disk && disk.path) {
      const state = (info.status && info.status.state) || info.state || null;
      out.push({
        kind: 'desktop-disk',
        savings: 0,
        bytes: disk.allocatedBytes != null ? disk.allocatedBytes : disk.bytes,
        apparentBytes: disk.apparentBytes,
        state,
        severity: 'info',
        message: state === 'engine-down'
          ? 'Docker is open but its engine is not answering. Its disk image is still using space.'
          : 'Docker is not running. Its disk image is still using space.',
        guidance: (state === 'engine-down'
          ? 'Restart Docker Desktop and let it finish starting to clean it from inside. '
          : 'Start Docker Desktop and let it finish starting to clean it from inside. ') + diskNote(platform),
        sizeNote: disk.apparentBytes > (disk.allocatedBytes != null ? disk.allocatedBytes : disk.bytes)
          ? 'The file claims a larger size, but only the space it really uses counts.'
          : null,
      });
    }
    return out;
  }

  const { buildCache, images } = info.categories;

  if (buildCache && buildCache.reclaimable >= SUGGEST_MIN_BUILD_CACHE) {
    out.push({
      kind: 'build-cache',
      savings: buildCache.reclaimable,
      total: buildCache.count,
      unused: buildCache.count - buildCache.active,
      severity: buildCache.reclaimable > SUGGEST_HIGH ? 'high' : 'normal',
      note: disk ? diskNote(platform) : null,
    });
  }
  if (images && images.reclaimable >= SUGGEST_MIN_IMAGES) {
    out.push({
      kind: 'dangling-images',
      savings: images.reclaimable,
      total: images.count,
      unused: images.count - images.active,
      severity: images.reclaimable > SUGGEST_HIGH ? 'high' : 'normal',
      note: disk ? diskNote(platform) : null,
    });
  }
  // Volumes are never suggested, however large: they are the only Docker
  // storage that cannot be regenerated.
  return out;
}

/** '...Total reclaimed space: 5.765GB' -> bytes. */
function parseReclaimed(stdout) {
  const m = String(stdout || '').match(/Total reclaimed space:\s*([\d.]+\s*[a-zA-Z]*)/);
  return m ? parseSize(m[1]) : 0;
}

// Volumes are not in PRUNE_KINDS so nothing that lists the allowlist can offer
// them. They are reachable only through prune('volumes', { confirmVolumes: true }).
// No `-a`: on current Docker that would also remove named volumes.
const VOLUME_PRUNE = {
  id: 'volumes',
  name: 'Unused volumes',
  args: ['volume', 'prune', '-f'],
  safe: false,
  description: 'Removes volumes no container uses. Databases and uploads live here and cannot be recovered.',
};

/** Why freed space may not show up on the host, worded for each platform. */
function diskNote(platform = process.platform) {
  if (platform === 'win32') {
    return 'Docker keeps its data in a WSL2 disk image (VHDX) that will not shrink by itself unless sparse VHDX is enabled in Docker Desktop. Freed space stays reserved on your drive until then.';
  }
  if (platform === 'linux') {
    return 'Docker on Linux stores its data directly on your disk, so freed space comes back right away.';
  }
  return 'The Docker disk image (Docker.raw) on your Mac will not shrink right away. Docker hands the space back over time, or when it restarts.';
}

const DISK_NOTE = diskNote();

/**
 * Run one prune. Unknown kinds are refused, never passed through. Volumes need
 * an explicit `options.confirmVolumes === true` on top of naming the kind.
 */
async function prune(kind, options = {}) {
  let spec = Object.prototype.hasOwnProperty.call(PRUNE_KINDS, kind) ? PRUNE_KINDS[kind] : null;
  if (kind === 'volumes') {
    if (options.confirmVolumes !== true) {
      return { ok: false, error: 'Removing volumes needs explicit confirmation', freed: 0 };
    }
    spec = VOLUME_PRUNE;
  }
  if (!spec) return { ok: false, error: `Unknown prune kind: ${kind}`, freed: 0 };

  const st = options.status || (await status(options));
  if (!st.running) {
    const error = st.state === 'engine-down' ? 'Docker is open but its engine is not answering. Restart Docker Desktop.'
      : st.state === 'no-permission' ? 'Docker refused access to its socket. Add your user to the docker group or use rootless Docker.'
      : st.installed ? 'Docker is not running' : 'Docker is not installed';
    return { ok: false, error, freed: 0 };
  }

  // Prune acts on the current context, so make sure that is this machine. Checked
  // fresh: the context can change inside the status cache window.
  const endpoint = await currentEndpoint(options);
  if (!endpoint) {
    return { ok: false, error: 'Could not tell which Docker host is selected, so nothing was removed', freed: 0 };
  }
  if (!isLocalEndpoint(endpoint)) {
    return { ok: false, error: `Docker is pointed at a remote host (${endpoint}). Switch to a local context to clean up`, freed: 0 };
  }

  const res = await runDocker(spec.args, { ...options, timeout: options.timeout || PRUNE_TIMEOUT_MS });
  // Sizes changed underneath us.
  inventoryCache = null;
  if (!res.ok) return { ok: false, error: res.error, freed: 0 };
  return { ok: true, kind, freed: parseReclaimed(res.stdout), output: res.stdout.trim(), note: diskNote(options.platform) };
}

/** Drop the status/inventory caches (used after a prune or an explicit rescan). */
function resetCache() {
  statusCache = null;
  statusTtl = CACHE_MS;
  inventoryCache = null;
  binaryCache = undefined;
}

module.exports = {
  PRUNE_KINDS, DISK_NOTE, diskNote,
  status, inventory, prune, desktopDisk, desktopDiskPaths,
  detect, composeServices, usageByProject, reclaimSuggestions,
  // exported for tests
  parseSize, parseReclaimable, parseLabels, parseInventory, parseSummary,
  parseReclaimed, summarise, totalsOf, candidateBinaries, isDockerfile, resetCache, backendRunning, isLocalEndpoint, currentEndpoint,
};
