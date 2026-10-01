'use strict';
/**
 * Other local AI model stores: LM Studio, GPT4All, Jan, llama.cpp's download
 * cache, OpenAI Whisper, ComfyUI and AUTOMATIC1111 model folders, and Docker
 * Model Runner. Sources: docs/devtools-sources.md.
 *
 * Each store is a folder of model files or model folders, sized with an lstat
 * walk. Docker Model Runner keeps its models inside Docker, so it is listed
 * and removed through `docker model`, never by path.
 */

const path = require('path');
const os = require('os');
const { run, httpJson, listDir, lstatSafe, readText, readJson, dirSize, pool, absEnv, allocated } = require('./util');
const { runningState, matching } = require('./processes');
const { makeGroup, makeItem } = require('./model');

const MODEL_EXT = /\.(gguf|ggml|bin|safetensors|ckpt|pt|pth|onnx|mlmodel|npz)$/i;

function api(ctx) { return ctx.platform === 'win32' ? path.win32 : path.posix; }
function homeOf(ctx) { return ctx.platform === 'win32' ? (ctx.env.USERPROFILE || ctx.home) : ctx.home; }

// ---- LM Studio -------------------------------------------------------------

const LMS_PROC_RE = /LM Studio(\.app|\.exe)?|lm-studio|LM_Studio|[\\/]\.lmstudio[\\/]bin[\\/]lms|llmster/i;

/** LM Studio's home: ~/.lmstudio-home-pointer names it, else ~/.lmstudio. */
async function lmStudioHome(ctx) {
  const p = api(ctx);
  const pointer = await readText(p.join(homeOf(ctx), '.lmstudio-home-pointer'), 4096);
  const named = pointer && pointer.trim();
  if (named && /^([A-Za-z]:[\\/]|[\\/])/.test(named)) return named;
  return p.join(homeOf(ctx), '.lmstudio');
}

async function lmStudioModelDirs(ctx) {
  const p = api(ctx);
  const home = await lmStudioHome(ctx);
  const out = [];
  const settings = await readJson(p.join(home, 'settings.json'));
  const custom = settings && typeof settings.downloadsFolder === 'string' ? settings.downloadsFolder : null;
  if (custom && /^([A-Za-z]:[\\/]|[\\/])/.test(custom)) out.push(custom);
  out.push(p.join(home, 'models'));
  out.push(p.join(homeOf(ctx), '.cache', 'lm-studio', 'models')); // before 0.3
  return Array.from(new Set(out));
}

/** Loaded models as publisher/repo keys, or null when unknown. */
async function lmStudioLoaded(ctx, home) {
  const p = api(ctx);
  const lmsBin = p.join(home, 'bin', ctx.platform === 'win32' ? 'lms.exe' : 'lms');
  const viaCli = await run(lmsBin, ['ps', '--json'], { exec: ctx.exec, timeout: 8000 });
  let list = null;
  if (viaCli.ok) { try { list = JSON.parse(viaCli.stdout); } catch { list = null; } }
  if (!Array.isArray(list)) {
    const get = ctx.httpJson || httpJson;
    const rest = await get('GET', 'http://127.0.0.1:1234/api/v0/models', null, { timeout: 1500 });
    if (rest.ok && rest.json && Array.isArray(rest.json.data)) list = rest.json.data.filter((m) => m && m.state === 'loaded');
  }
  if (!Array.isArray(list)) {
    // REST v1: models with a non-empty loaded_instances.
    const get = ctx.httpJson || httpJson;
    const v1 = await get('GET', 'http://127.0.0.1:1234/api/v1/models', null, { timeout: 1500 });
    if (v1.ok && v1.json && Array.isArray(v1.json.models)) list = v1.json.models.filter((m) => m && Array.isArray(m.loaded_instances) && m.loaded_instances.length).map((m) => ({ path: m.key }));
  }
  if (!Array.isArray(list)) return null;
  return list.map((m) => String((m && (m.path || m.modelKey || m.identifier || m.id)) || '').replace(/\\/g, '/').toLowerCase()).filter(Boolean);
}

async function lmStudio(ctx) {
  const p = api(ctx);
  const dirs = [];
  for (const d of await lmStudioModelDirs(ctx)) { const st = await lstatSafe(d); if (st && st.isDirectory()) dirs.push(d); }
  if (!dirs.length) return [];
  const home = await lmStudioHome(ctx);
  const running = runningState(ctx.procs, LMS_PROC_RE);
  const loaded = running === 'no' ? [] : await lmStudioLoaded(ctx, home);
  const items = [];
  for (const root of dirs) {
    for (const pub of await listDir(root)) {
      if (!pub.isDirectory() || pub.name.startsWith('.')) continue;
      const repos = await listDir(p.join(root, pub.name));
      await pool(repos.filter((r) => r.isDirectory()), 4, async (repo) => {
        const dir = p.join(root, pub.name, repo.name);
        const files = (await listDir(dir)).filter((f) => f.isFile() && MODEL_EXT.test(f.name)).map((f) => f.name);
        const size = await dirSize(dir);
        if (!size.bytes) return;
        const key = (pub.name + '/' + repo.name).toLowerCase();
        const isLoaded = Array.isArray(loaded) && loaded.some((l) => l.startsWith(key + '/') || l === key || l.includes('/' + key + '/'));
        const quant = (files.join(' ').match(/(Q\d_[A-Z0-9_]+|Q\d+|F16|BF16|F32|IQ\d_[A-Z0-9_]+)/i) || [])[1] || null;
        let blocked = null;
        const badges = [];
        if (isLoaded) { blocked = 'Loaded in LM Studio right now. Eject it first, then delete.'; badges.push({ text: 'Loaded', kind: 'running' }); }
        else if (loaded === null && running !== 'no') { blocked = running === 'yes' ? 'LM Studio is running and Spaci could not see which models are loaded. Quit LM Studio, then delete.' : 'Spaci could not check whether LM Studio is running.'; badges.push({ text: 'Not checked', kind: 'unknown' }); }
        items.push(makeItem({
          id: 'lmstudio:' + dir,
          group: 'lmstudio',
          kind: 'model',
          label: pub.name + '/' + repo.name,
          name: repo.name,
          detail: [files.length + (files.length === 1 ? ' file' : ' files'), quant].filter(Boolean).join(' · '),
          quant,
          size: size.bytes,
          state: isLoaded ? 'running' : 'idle',
          blocked,
          badges,
          restoreHint: 'lms get ' + pub.name + '/' + repo.name,
          paths: [dir],
          removal: { type: 'paths', root, paths: [dir] },
        }));
      });
    }
  }
  return [makeGroup({
    id: 'lmstudio', section: 'ai', category: 'models', title: 'LM Studio', icon: 'ai-cube', roots: dirs,
    server: { state: running === 'yes' ? 'running' : running === 'no' ? 'stopped' : 'unknown', label: running === 'yes' ? 'App running' : running === 'no' ? 'Not running' : 'Not checked' },
    items: items.sort((a, b) => b.size - a.size),
    note: 'LM Studio has no delete command; Spaci removes the model folder, which is what deleting it in the app does.',
  })];
}

// ---- folder stores -----------------------------------------------------------

/**
 * A store that is a folder of model files (or one folder per model).
 * spec: { id, title, brand?, icon, roots: [dirs], level: 'file' | 'dir',
 *   procRe?, restore(name), note, depth?: subfolders to descend first }
 */
async function folderStore(ctx, spec) {
  const p = api(ctx);
  const roots = [];
  for (const d of spec.roots.filter(Boolean)) { const st = await lstatSafe(d); if (st && st.isDirectory() && !roots.includes(d)) roots.push(d); }
  if (!roots.length) return [];
  const running = spec.procRe ? runningState(ctx.procs, spec.procRe) : 'no';
  const items = [];
  const visit = async (root, dir, depth) => {
    for (const e of await listDir(dir)) {
      if (e.name.startsWith('.')) continue;
      const full = p.join(dir, e.name);
      if (depth > 0 && e.isDirectory()) { await visit(root, full, depth - 1); continue; }
      let bytes = 0;
      if (spec.level === 'file') {
        if (!e.isFile() || !MODEL_EXT.test(e.name)) continue;
        bytes = allocated(await lstatSafe(full));
      } else {
        if (!e.isDirectory()) continue;
        bytes = (await dirSize(full)).bytes;
      }
      if (bytes < (spec.minBytes || 1024 * 1024)) continue;
      const st = await lstatSafe(full);
      const blocked = running === 'yes' ? spec.title + ' is running. Quit it, then delete.' : running === 'unknown' ? 'Spaci could not check whether ' + spec.title + ' is running.' : null;
      items.push(makeItem({
        id: spec.id + ':' + full,
        group: spec.id,
        kind: 'model',
        label: spec.labelOf ? spec.labelOf(root, full) : e.name,
        name: e.name,
        detail: spec.detailOf ? spec.detailOf(root, full) : p.relative(root, p.dirname(full)) || '',
        size: bytes,
        modifiedAt: st ? st.mtimeMs : null,
        blocked,
        badges: running === 'yes' ? [{ text: 'App running', kind: 'running' }] : [],
        restoreHint: spec.restore(e.name),
        paths: [full],
        removal: { type: 'paths', root, paths: [full] },
      }));
    }
  };
  for (const r of roots) await visit(r, r, spec.depthOf ? spec.depthOf(r) : spec.depth || 0);
  if (!items.length) return [];
  return [makeGroup({
    id: spec.id, section: 'ai', category: 'models', title: spec.title, brand: spec.brand, icon: spec.icon || 'ai-cube', roots,
    server: spec.procRe ? { state: running === 'yes' ? 'running' : running === 'no' ? 'stopped' : 'unknown', label: running === 'yes' ? 'App running' : running === 'no' ? 'Not running' : 'Not checked' } : null,
    items: items.sort((a, b) => b.size - a.size),
    note: spec.note || null,
  })];
}

function gpt4all(ctx) {
  const p = api(ctx);
  const { env } = ctx;
  const root = ctx.platform === 'darwin' ? p.join(ctx.home, 'Library', 'Application Support', 'nomic.ai', 'GPT4All')
    : ctx.platform === 'win32' ? (env.LOCALAPPDATA ? p.join(env.LOCALAPPDATA, 'nomic.ai', 'GPT4All') : null)
      : p.join(absEnv(env, 'XDG_DATA_HOME') || p.join(ctx.home, '.local', 'share'), 'nomic.ai', 'GPT4All');
  return folderStore(ctx, {
    id: 'gpt4all', title: 'GPT4All', roots: [root], level: 'file', procRe: /GPT4All/i,
    restore: (n) => 'Download ' + n + ' again from GPT4All\'s model list.',
  });
}

function jan(ctx) {
  const p = api(ctx);
  const { env } = ctx;
  const data = ctx.platform === 'darwin' ? p.join(ctx.home, 'Library', 'Application Support', 'Jan', 'data')
    : ctx.platform === 'win32' ? (env.APPDATA ? p.join(env.APPDATA, 'Jan', 'data') : null)
      : p.join(absEnv(env, 'XDG_DATA_HOME') || p.join(ctx.home, '.local', 'share'), 'Jan', 'data');
  const legacy = p.join(homeOf(ctx), 'jan');
  // llamacpp/models/<org>/<repo>/{model.yml, model.gguf}; mlx/models/<id>;
  // releases before 0.6 kept models/<id> under ~/jan.
  const roots = [data && p.join(data, 'llamacpp', 'models'), data && p.join(data, 'mlx', 'models'), data && p.join(data, 'models'), p.join(legacy, 'models')];
  return folderStore(ctx, {
    id: 'jan', title: 'Jan', roots, level: 'dir', depthOf: (root) => (/llamacpp[\\/]models$/.test(root) ? 1 : 0),
    procRe: /(^|[\\/])Jan(\.app|\.exe)?([\\/ ]|$)/,
    labelOf: (root, full) => p.relative(root, full).split(/[\\/]/).join('/'),
    restore: (n) => 'Download ' + n + ' again from Jan\'s Hub.',
  });
}

function llamaCpp(ctx) {
  const p = api(ctx);
  const { env } = ctx;
  const custom = absEnv(env, 'LLAMA_CACHE');
  const def = ctx.platform === 'darwin' ? p.join(ctx.home, 'Library', 'Caches', 'llama.cpp')
    : ctx.platform === 'win32' ? (env.LOCALAPPDATA ? p.join(env.LOCALAPPDATA, 'llama.cpp') : null)
      : p.join(absEnv(env, 'XDG_CACHE_HOME') || p.join(ctx.home, '.cache'), 'llama.cpp');
  return folderStore(ctx, {
    id: 'llamacpp', title: 'llama.cpp downloads', roots: [custom || def], level: 'file',
    procRe: /(^|[\\/])(llama-server|llama-cli|llama-run|llamafile)(\.exe)?(\s|$)/,
    restore: (n) => 'Fetched again the next time llama.cpp loads it with -hf.',
    note: 'Models older llama.cpp builds fetched with -hf (LLAMA_CACHE). Newer builds share the Hugging Face cache, listed there.',
  });
}

function whisper(ctx) {
  const p = api(ctx);
  const base = absEnv(ctx.env, 'XDG_CACHE_HOME') || p.join(homeOf(ctx), '.cache');
  return folderStore(ctx, {
    id: 'whisper', title: 'Whisper models', roots: [p.join(base, 'whisper')], level: 'file',
    restore: (n) => 'openai-whisper downloads ' + n + ' again the next time you load that model.',
    note: 'Speech models openai-whisper caches in ~/.cache/whisper.',
  });
}

/** ComfyUI and AUTOMATIC1111 installs at their usual places or among scanned projects. */
function sdRoots(ctx, re, defaults) {
  const p = api(ctx);
  const out = defaults.map((d) => p.join(homeOf(ctx), ...d));
  for (const proj of ctx.projects || []) if (typeof proj === 'string' && re.test(p.basename(proj))) out.push(p.join(proj, 'models'));
  return out;
}

function comfyUi(ctx) {
  return folderStore(ctx, {
    id: 'comfyui', title: 'ComfyUI models', roots: sdRoots(ctx, /^comfyui$/i, [['ComfyUI', 'models'], ['Documents', 'ComfyUI', 'models']]),
    level: 'file', depth: 2, minBytes: 20 * 1024 * 1024, procRe: /ComfyUI|comfyui[\\/]main\.py/i,
    labelOf: (root, full) => path.basename(full),
    restore: (n) => 'Download ' + n + ' again from where you got it (Hugging Face, Civitai).',
    note: 'Checkpoints, LoRAs and other weights in ComfyUI\'s models folder.',
  });
}

function automatic1111(ctx) {
  return folderStore(ctx, {
    id: 'a1111', title: 'Stable Diffusion web UI models', roots: sdRoots(ctx, /^stable-diffusion-webui/i, [['stable-diffusion-webui', 'models']]),
    level: 'file', depth: 2, minBytes: 20 * 1024 * 1024, procRe: /stable-diffusion-webui|launch\.py|webui\.py/i,
    restore: (n) => 'Download ' + n + ' again from where you got it (Hugging Face, Civitai).',
    note: 'Checkpoints, LoRAs and VAEs in AUTOMATIC1111\'s models folder.',
  });
}

// ---- Docker Model Runner -----------------------------------------------------

/** `docker model ls --json` rows to { name, id, size, params, quant }. */
function parseDockerModels(stdout) {
  let list;
  try { list = JSON.parse(String(stdout || '').trim() || '[]'); } catch { return null; }
  if (list && !Array.isArray(list) && Array.isArray(list.models)) list = list.models;
  if (!Array.isArray(list)) return null;
  return list.map((m) => {
    const cfg = (m && m.config) || {};
    const tags = Array.isArray(m && m.tags) ? m.tags : [];
    const size = typeof cfg.size === 'string' ? parseSize(cfg.size) : Number(m && m.size) || 0;
    return { name: tags[0] || (m && (m.name || m.id)) || '', id: (m && m.id) || '', tags, size, params: cfg.parameters || null, quant: cfg.quantization || null, format: cfg.format || null };
  }).filter((m) => m.name);
}

function parseSize(s) {
  const m = /^([\d.]+)\s*([KMGT]i?B|B)?$/i.exec(String(s || '').trim());
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = (m[2] || 'B').toUpperCase();
  const pow = { B: 0, KB: 1, KIB: 1, MB: 2, MIB: 2, GB: 3, GIB: 3, TB: 4, TIB: 4 }[unit] || 0;
  return Math.round(n * 1024 ** pow);
}

async function dockerModelRunner(ctx) {
  const ls = await run('docker', ['model', 'ls', '--json'], { exec: ctx.exec, timeout: 10000 });
  if (ls.missing) return [];
  const models = ls.ok ? parseDockerModels(ls.stdout) : null;
  if (!models) return []; // not installed or not running: nothing Spaci can manage
  const ps = await run('docker', ['model', 'ps'], { exec: ctx.exec, timeout: 8000 });
  const loadedText = ps.ok ? ps.stdout : null;
  const items = models.map((m) => {
    const isLoaded = loadedText != null && loadedText.split(/\r?\n/).slice(1).some((l) => l.split(/\s+/)[0] === m.name);
    let blocked = null;
    if (isLoaded) blocked = 'Running in Docker Model Runner. Unload it first (docker model unload ' + m.name + ').';
    else if (loadedText == null) blocked = 'Spaci could not check which models Docker Model Runner has loaded.';
    return makeItem({
      id: 'dmr:' + m.name,
      group: 'docker-models',
      kind: 'model',
      label: m.name,
      name: m.name,
      detail: [m.params, m.quant, m.format].filter(Boolean).join(' · '),
      params: m.params, quant: m.quant,
      size: m.size,
      state: isLoaded ? 'running' : 'idle',
      blocked,
      badges: isLoaded ? [{ text: 'Loaded', kind: 'running' }] : [],
      restoreHint: 'docker model pull ' + m.name,
      removal: { type: 'command', cmd: 'docker', args: ['model', 'rm', m.name] },
    });
  });
  if (!items.length) return [];
  return [makeGroup({
    id: 'docker-models', section: 'ai', category: 'models', title: 'Docker Model Runner', brand: 'docker', icon: 'box', roots: [],
    server: { state: 'running', label: 'Running' }, items: items.sort((a, b) => b.size - a.size),
    note: 'Removed with docker model rm. Docker frees the space inside its own disk image.',
  })];
}

module.exports = {
  lmStudio, lmStudioHome, lmStudioModelDirs, gpt4all, jan, llamaCpp, whisper, comfyUi, automatic1111, dockerModelRunner,
  parseDockerModels, parseSize, folderStore, LMS_PROC_RE, MODEL_EXT, os,
};
