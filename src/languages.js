'use strict';
/**
 * Spaci: language and framework detection for a project folder.
 *
 * Languages are byte weighted like GitHub Linguist: committed blobs and their
 * sizes come from one `git ls-tree -r -l -z HEAD`, or from a bounded lstat walk
 * when the folder is not a repo. File contents are never read for the stats.
 * Frameworks come from manifests only (package.json, Cargo.toml, go.mod, ...),
 * each read with a size cap and parsed defensively.
 *
 * Pure and injectable: no Electron. `exec`, `fs`, `now` can be swapped in tests.
 */
const path = require('path');
const nodeFs = require('fs');
const { execFile } = require('child_process');
const TECH = require('./tech-ids');

const CANONICAL = new Set(TECH.ALL);

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

/** Canonical language id to display name and GitHub Linguist color. */
const LANG_INFO = {
  typescript: ['TypeScript', '#3178c6'],
  javascript: ['JavaScript', '#f1e05a'],
  python: ['Python', '#3572A5'],
  rust: ['Rust', '#dea584'],
  go: ['Go', '#00ADD8'],
  dart: ['Dart', '#00B4AB'],
  kotlin: ['Kotlin', '#A97BFF'],
  java: ['Java', '#b07219'],
  swift: ['Swift', '#F05138'],
  'objective-c': ['Objective-C', '#438eff'],
  c: ['C', '#555555'],
  cpp: ['C++', '#f34b7d'],
  csharp: ['C#', '#178600'],
  fsharp: ['F#', '#b845fc'],
  php: ['PHP', '#4F5D95'],
  ruby: ['Ruby', '#701516'],
  elixir: ['Elixir', '#6e4a7e'],
  erlang: ['Erlang', '#B83998'],
  haskell: ['Haskell', '#5e5086'],
  scala: ['Scala', '#c22d40'],
  clojure: ['Clojure', '#db5855'],
  lua: ['Lua', '#000080'],
  perl: ['Perl', '#0298c3'],
  r: ['R', '#198CE7'],
  julia: ['Julia', '#a270ba'],
  zig: ['Zig', '#ec915c'],
  nim: ['Nim', '#ffc200'],
  ocaml: ['OCaml', '#ef7a08'],
  shell: ['Shell', '#89e051'],
  powershell: ['PowerShell', '#012456'],
  sql: ['SQL', '#e38c00'],
  html: ['HTML', '#e34c26'],
  css: ['CSS', '#663399'],
  scss: ['SCSS', '#c6538c'],
  sass: ['Sass', '#a53b70'],
  less: ['Less', '#1d365d'],
  svelte: ['Svelte', '#ff3e00'],
  vue: ['Vue', '#41b883'],
  astro: ['Astro', '#ff5a03'],
  solidity: ['Solidity', '#AA6746'],
  gdscript: ['GDScript', '#355570'],
  groovy: ['Groovy', '#4298b8'],
  matlab: ['MATLAB', '#e16737'],
};
const OTHER_COLOR = '#8b8b8b';

/** Lowercased extension (without dot) to language id. `h` and `m` are resolved later. */
const EXT_LANG = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', pyi: 'python', pyw: 'python',
  rs: 'rust', go: 'go', dart: 'dart',
  kt: 'kotlin', kts: 'kotlin',
  java: 'java', swift: 'swift',
  mm: 'objective-c',
  c: 'c',
  cc: 'cpp', cpp: 'cpp', cxx: 'cpp', 'c++': 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', ipp: 'cpp', ino: 'cpp',
  cs: 'csharp', csx: 'csharp',
  fs: 'fsharp', fsi: 'fsharp', fsx: 'fsharp',
  php: 'php', phtml: 'php',
  rb: 'ruby', rake: 'ruby', gemspec: 'ruby', ru: 'ruby',
  ex: 'elixir', exs: 'elixir', heex: 'elixir',
  erl: 'erlang', hrl: 'erlang',
  hs: 'haskell', lhs: 'haskell',
  scala: 'scala', sc: 'scala',
  clj: 'clojure', cljs: 'clojure', cljc: 'clojure',
  lua: 'lua',
  pl: 'perl', pm: 'perl',
  r: 'r',
  jl: 'julia', zig: 'zig', nim: 'nim',
  ml: 'ocaml', mli: 'ocaml',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', ksh: 'shell',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  sql: 'sql',
  html: 'html', htm: 'html', xhtml: 'html',
  css: 'css', scss: 'scss', sass: 'sass', less: 'less',
  svelte: 'svelte', vue: 'vue', astro: 'astro',
  sol: 'solidity', gd: 'gdscript',
  groovy: 'groovy', gradle: 'groovy', gvy: 'groovy',
  h: 'h?', m: 'm?',
};

/** Special filenames without a telling extension. */
const NAME_LANG = {
  Rakefile: 'ruby', Gemfile: 'ruby', Podfile: 'ruby', Fastfile: 'ruby', Appfile: 'ruby',
  Brewfile: 'ruby', Vagrantfile: 'ruby', Guardfile: 'ruby', Capfile: 'ruby', Dangerfile: 'ruby',
  Jenkinsfile: 'groovy',
  '.bashrc': 'shell', '.bash_profile': 'shell', '.zshrc': 'shell', '.zprofile': 'shell', '.profile': 'shell',
};

/** Vendored, generated or tool folders: nothing under them counts. */
const VENDORED_DIRS = new Set([
  'node_modules', 'vendor', 'bower_components', 'jspm_packages', 'dist', 'build', 'out',
  '.next', '.nuxt', '.output', '.svelte-kit', 'target', 'Pods', 'Carthage', 'DerivedData',
  '.dart_tool', '__pycache__', 'coverage', '.git', '.hg', '.svn', '.venv', 'venv',
  'site-packages', '.gradle', '.yarn', '.pnpm-store', '.expo', '.turbo', '.parcel-cache',
  '.angular', '.terraform', '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.cache',
  '.idea', '.vscode', '.docusaurus', 'storybook-static', '.vercel', '.netlify', '.serverless',
]);

/** Generated or minified files, and vendored wrapper scripts. */
const GENERATED_RE = new RegExp([
  '\\.min\\.(?:js|mjs|css)$', '[.-]bundle\\.js$', '\\.pb\\.go$', '^zz_generated.*\\.go$',
  '_pb2(?:_grpc)?\\.pyi?$', '\\.(?:g|freezed|gr|pb|pbenum|pbjson|pbserver|mocks|config)\\.dart$',
  '\\.designer\\.cs$', '\\.g\\.(?:i\\.)?cs$', '\\.generated\\.[a-z]+$', '^generated_plugin_registrant\\.',
  '^GeneratedPluginRegistrant\\.', '^\\.pnp\\.(?:c?js|loader\\.mjs)$',
  '^(?:gradlew|gradlew\\.bat|mvnw|mvnw\\.cmd)$',
].join('|'), 'i');

/** Raw language guess from a path, or null. Returns 'h?' / 'm?' for the ambiguous ones. */
function rawLanguage(rel) {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  if (NAME_LANG[base]) return NAME_LANG[base];
  const dot = base.lastIndexOf('.');
  if (dot <= 0 && !base.startsWith('.')) return null;
  if (dot < 0) return null;
  return EXT_LANG[base.slice(dot + 1).toLowerCase()] || null;
}

/** True when any folder on the path is vendored or generated. */
function inVendoredDir(rel) {
  let start = 0;
  for (;;) {
    const slash = rel.indexOf('/', start);
    if (slash < 0) return false;
    if (VENDORED_DIRS.has(rel.slice(start, slash))) return true;
    start = slash + 1;
  }
}

function isExcluded(rel) {
  if (inVendoredDir(rel)) return true;
  return GENERATED_RE.test(rel.slice(rel.lastIndexOf('/') + 1));
}

/**
 * Turn [{ rel, size, lang }] into the contract's language list. Resolves `.h`
 * and `.m` from the rest of the tree: `.m` is Objective-C next to headers, xibs
 * or an Xcode project, MATLAB otherwise; `.h` goes to Objective-C or C++ when
 * those sources exist (whichever is larger), else C.
 */
function summarizeLanguages(records, hints) {
  const bytes = new Map();
  const add = (id, n) => bytes.set(id, (bytes.get(id) || 0) + n);
  const hBytes = [];
  const mBytes = [];
  for (const r of records) {
    if (r.lang === 'h?') hBytes.push(r.size);
    else if (r.lang === 'm?') mBytes.push(r.size);
    else add(r.lang, r.size);
  }
  const mIsObjc = hBytes.length > 0 || hints.xcode || hints.xib || bytes.has('objective-c');
  for (const n of mBytes) add(mIsObjc ? 'objective-c' : 'matlab', n);
  if (hBytes.length) {
    const objc = bytes.get('objective-c') || 0;
    const cpp = bytes.get('cpp') || 0;
    const target = objc > 0 && objc >= cpp ? 'objective-c' : cpp > 0 ? 'cpp' : 'c';
    for (const n of hBytes) add(target, n);
  }

  const total = [...bytes.values()].reduce((s, n) => s + n, 0);
  const pct = (n) => (total ? Math.round((n * 1000) / total) / 10 : 0);
  const sorted = [...bytes].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const out = sorted.slice(0, 8).map(([id, n]) => ({
    id, name: LANG_INFO[id][0], bytes: n, percent: pct(n), color: LANG_INFO[id][1],
  }));
  const rest = sorted.slice(8).reduce((s, [, n]) => s + n, 0);
  if (rest > 0) out.push({ id: 'other', name: 'Other', bytes: rest, percent: pct(rest), color: OTHER_COLOR });
  return { languages: out, totalBytes: total };
}

// ---------------------------------------------------------------------------
// Enumeration: git first, bounded walk as the fallback
// ---------------------------------------------------------------------------

/** Git must answer about this folder, not a repo named by the environment. */
function gitEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}

/** Default exec: never throws, keeps whatever stdout arrived even on error. */
function defaultExec(file, args, { signal, timeout, maxBuffer } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { signal, timeout, maxBuffer, env: gitEnv(), encoding: 'utf8' },
        (err, stdout) => resolve({ err, stdout: String(stdout || '') }));
    } catch (err) {
      resolve({ err, stdout: '' });
    }
  });
}

/**
 * Committed blobs under `dir` with sizes, from one git call. Resolves null when
 * git cannot answer (not a repo, no commits, git missing) so the caller walks.
 */
async function enumerateGit(dir, ctx) {
  const remaining = ctx.deadline - ctx.now();
  if (remaining <= 0) return null;
  const res = await ctx.exec('git', ['--literal-pathspecs', '-C', dir, 'ls-tree', '-r', '-l', '-z', 'HEAD'],
    { signal: ctx.signal, timeout: Math.max(50, remaining), maxBuffer: 48 * 1024 * 1024 });
  const out = res && typeof res.stdout === 'string' ? res.stdout : '';
  if (!out) return null;
  let truncated = Boolean(res.err);
  const files = [];
  let start = 0;
  while (start < out.length) {
    let end = out.indexOf('\0', start);
    // A record cut off by a killed or overflowing git is dropped, not guessed.
    if (end < 0) { truncated = true; break; }
    const rec = out.slice(start, end);
    start = end + 1;
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const meta = rec.slice(0, tab).split(/\s+/);
    // Only regular and executable blobs: skip symlinks (120000) and submodules.
    if (meta[1] !== 'blob' || meta[0] === '120000') continue;
    if (files.length >= ctx.maxFiles) { truncated = true; break; }
    const size = Number(meta[3]);
    files.push({ rel: rec.slice(tab + 1), size: Number.isFinite(size) ? size : 0 });
  }
  if (!files.length) return null;
  return { files, truncated, source: 'git' };
}

/**
 * Bounded breadth-first walk with lstat: never follows symlinks, skips vendored
 * folders, and only stats files that map to a language.
 */
async function enumerateWalk(dir, ctx) {
  const files = [];
  let truncated = false;
  let count = 0;
  const queue = [''];
  const stop = () => {
    if (ctx.signal?.aborted || ctx.now() >= ctx.deadline) { truncated = true; return true; }
    return false;
  };
  while (queue.length) {
    if (stop()) break;
    const batch = queue.splice(0, 16);
    const listed = await Promise.all(batch.map((rel) =>
      Promise.resolve()
        .then(() => ctx.fs.readdir(path.join(dir, rel), { withFileTypes: true }))
        .then((ents) => ({ rel, ents }), () => ({ rel, ents: [] }))));
    const toStat = [];
    for (const { rel, ents } of listed) {
      for (const e of ents) {
        if (e.isSymbolicLink()) continue;
        const child = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!VENDORED_DIRS.has(e.name)) queue.push(child);
        } else if (e.isFile()) {
          if (count >= ctx.maxFiles) { truncated = true; break; }
          count++;
          if (rawLanguage(child) && !GENERATED_RE.test(e.name)) toStat.push(child);
          else files.push({ rel: child, size: 0 });
        }
      }
      if (truncated) break;
    }
    const sizes = await Promise.all(toStat.map((rel) =>
      Promise.resolve()
        .then(() => ctx.fs.lstat(path.join(dir, rel)))
        .then((st) => (st.isFile() ? st.size : 0), () => 0)));
    toStat.forEach((rel, i) => files.push({ rel, size: sizes[i] }));
    if (truncated) break;
  }
  return { files, truncated, source: 'walk' };
}

// ---------------------------------------------------------------------------
// Frameworks
// ---------------------------------------------------------------------------

const TECH_INFO = {
  react: ['React', 'library'], nextjs: ['Next.js', 'framework'], remix: ['Remix', 'framework'],
  gatsby: ['Gatsby', 'framework'], sveltekit: ['SvelteKit', 'framework'], 'svelte-lib': ['Svelte', 'library'],
  nuxt: ['Nuxt', 'framework'], 'vue-lib': ['Vue', 'library'], angular: ['Angular', 'framework'],
  solid: ['Solid', 'library'], qwik: ['Qwik', 'framework'], 'astro-fw': ['Astro', 'framework'],
  electron: ['Electron', 'framework'], tauri: ['Tauri', 'framework'], 'react-native': ['React Native', 'mobile'],
  expo: ['Expo', 'mobile'], flutter: ['Flutter', 'framework'], express: ['Express', 'framework'],
  nestjs: ['NestJS', 'framework'], fastify: ['Fastify', 'framework'], koa: ['Koa', 'framework'],
  hono: ['Hono', 'framework'], django: ['Django', 'framework'], fastapi: ['FastAPI', 'framework'],
  flask: ['Flask', 'framework'], rails: ['Rails', 'framework'], laravel: ['Laravel', 'framework'],
  symfony: ['Symfony', 'framework'], spring: ['Spring', 'framework'], 'spring-boot': ['Spring Boot', 'framework'],
  dotnet: ['.NET', 'runtime'], aspnet: ['ASP.NET Core', 'framework'], phoenix: ['Phoenix', 'framework'],
  gin: ['Gin', 'framework'], fiber: ['Fiber', 'framework'], actix: ['Actix Web', 'framework'],
  axum: ['Axum', 'framework'], rocket: ['Rocket', 'framework'],
  node: ['Node.js', 'runtime'], deno: ['Deno', 'runtime'], bun: ['Bun', 'runtime'],
  vite: ['Vite', 'tool'], webpack: ['webpack', 'tool'], rollup: ['Rollup', 'tool'], esbuild: ['esbuild', 'tool'],
  turbo: ['Turborepo', 'tool'], nx: ['Nx', 'tool'], tailwind: ['Tailwind CSS', 'styling'],
  bootstrap: ['Bootstrap', 'styling'], prisma: ['Prisma', 'library'], drizzle: ['Drizzle', 'library'],
  typeorm: ['TypeORM', 'library'], sequelize: ['Sequelize', 'library'], mongoose: ['Mongoose', 'library'],
  graphql: ['GraphQL', 'library'], trpc: ['tRPC', 'library'], jest: ['Jest', 'testing'],
  vitest: ['Vitest', 'testing'], playwright: ['Playwright', 'testing'], cypress: ['Cypress', 'testing'],
  pytest: ['pytest', 'testing'], storybook: ['Storybook', 'tool'], eslint: ['ESLint', 'tool'],
  prettier: ['Prettier', 'tool'], docker: ['Docker', 'infra'], 'docker-compose': ['Docker Compose', 'infra'],
  kubernetes: ['Kubernetes', 'infra'], terraform: ['Terraform', 'infra'], ansible: ['Ansible', 'infra'],
  android: ['Android', 'mobile'], ios: ['iOS', 'mobile'], xcode: ['Xcode', 'tool'], gradle: ['Gradle', 'tool'],
  maven: ['Maven', 'tool'], cargo: ['Cargo', 'tool'], poetry: ['Poetry', 'tool'], pipenv: ['Pipenv', 'tool'],
  npm: ['npm', 'tool'], yarn: ['Yarn', 'tool'], pnpm: ['pnpm', 'tool'], firebase: ['Firebase', 'library'],
  supabase: ['Supabase', 'library'], postgres: ['PostgreSQL', 'database'], mysql: ['MySQL', 'database'],
  sqlite: ['SQLite', 'database'], mongodb: ['MongoDB', 'database'], redis: ['Redis', 'database'],
};

/** Most characteristic first. Anything not listed never becomes primary. */
const PRIMARY_RANK = [
  'electron', 'tauri', 'expo', 'react-native', 'flutter',
  'nextjs', 'remix', 'gatsby', 'sveltekit', 'nuxt', 'astro-fw', 'qwik', 'angular',
  'rails', 'laravel', 'symfony', 'django', 'fastapi', 'flask', 'spring-boot', 'spring', 'aspnet',
  'phoenix', 'nestjs', 'actix', 'axum', 'rocket', 'gin', 'fiber', 'android', 'ios',
  'react', 'vue-lib', 'svelte-lib', 'solid', 'express', 'fastify', 'koa', 'hono',
];
const RANK = new Map(PRIMARY_RANK.map((id, i) => [id, i]));
const CATEGORY_ORDER = ['framework', 'mobile', 'library', 'runtime', 'database', 'styling', 'testing', 'tool', 'infra'];

const NPM_DEPS = {
  react: 'react', next: 'nextjs', '@remix-run/react': 'remix', '@remix-run/node': 'remix', '@remix-run/dev': 'remix',
  gatsby: 'gatsby', '@sveltejs/kit': 'sveltekit', svelte: 'svelte-lib', nuxt: 'nuxt', nuxt3: 'nuxt',
  vue: 'vue-lib', '@angular/core': 'angular', 'solid-js': 'solid', '@builder.io/qwik': 'qwik', astro: 'astro-fw',
  electron: 'electron', '@tauri-apps/api': 'tauri', '@tauri-apps/cli': 'tauri', 'react-native': 'react-native',
  expo: 'expo', express: 'express', '@nestjs/core': 'nestjs', fastify: 'fastify', koa: 'koa', hono: 'hono',
  vite: 'vite', webpack: 'webpack', rollup: 'rollup', esbuild: 'esbuild', turbo: 'turbo', nx: 'nx',
  '@nrwl/workspace': 'nx', '@nx/workspace': 'nx', tailwindcss: 'tailwind', bootstrap: 'bootstrap',
  prisma: 'prisma', '@prisma/client': 'prisma', 'drizzle-orm': 'drizzle', typeorm: 'typeorm',
  sequelize: 'sequelize', mongoose: 'mongoose', graphql: 'graphql', '@trpc/server': 'trpc', jest: 'jest',
  vitest: 'vitest', '@playwright/test': 'playwright', playwright: 'playwright', cypress: 'cypress',
  storybook: 'storybook', eslint: 'eslint', prettier: 'prettier', '@supabase/supabase-js': 'supabase',
  firebase: 'firebase', 'firebase-admin': 'firebase', pg: 'postgres', postgres: 'postgres', mysql: 'mysql',
  mysql2: 'mysql', sqlite3: 'sqlite', 'better-sqlite3': 'sqlite', mongodb: 'mongodb', redis: 'redis',
  ioredis: 'redis', '@types/bun': 'bun',
};

const MANIFEST_NAMES = new Set([
  'package.json', 'deno.json', 'deno.jsonc', 'pyproject.toml', 'Pipfile', 'setup.py', 'setup.cfg', 'manage.py',
  'Cargo.toml', 'go.mod', 'pubspec.yaml', 'composer.json', 'Gemfile', 'build.gradle', 'build.gradle.kts',
  'settings.gradle', 'settings.gradle.kts', 'libs.versions.toml', 'pom.xml', 'Package.swift', 'Podfile',
  'mix.exs', 'pnpm-workspace.yaml', 'project.pbxproj',
]);
const REQUIREMENTS_RE = /^requirements[\w.-]*\.txt$/i;
const DOTNET_RE = /\.(?:cs|fs|vb)proj$/i;
const COMPOSE_RE = /^(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/i;
const DOCKERFILE_RE = /^(?:Dockerfile(?:\.[\w.-]+)?|[\w.-]+\.dockerfile)$/i;
const LOCKFILES = {
  'package-lock.json': 'npm', 'npm-shrinkwrap.json': 'npm', 'yarn.lock': 'yarn', 'pnpm-lock.yaml': 'pnpm',
  'bun.lockb': 'bun', 'bun.lock': 'bun', 'poetry.lock': 'poetry', 'Pipfile.lock': 'pipenv',
};
// Sub-manifests in these folders are examples or test data, not the project.
const NOISE_DIRS = /(?:^|\/)(?:fixtures?|__fixtures__|examples?|samples?|tests?|testdata|__tests__|templates?|docs?)(?:\/|$)/i;
const K8S_DIR_RE = /(?:^|\/)(?:k8s|kube|kubernetes|manifests|deploy|deployments?|helm|charts|kustomize|overlays)(?:\/|$)/i;
const MANIFEST_CAP = 1024 * 1024;
const MAX_MANIFESTS = 60;

const depthOf = (rel) => (rel.match(/\//g) || []).length;
const dirOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const baseOf = (rel) => rel.slice(rel.lastIndexOf('/') + 1);

/** Simple workspace glob ("packages/*", "apps/**") to a folder matcher. */
function globToRe(glob) {
  const g = String(glob).replace(/^\.\//, '').replace(/\/+$/, '');
  if (!g || g.startsWith('!')) return null;
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === '*' && g[i + 1] === '*') { re += '.*'; i++; } else if (ch === '*') re += '[^/]*';
    else re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function parseJson(text) {
  try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : null; } catch { return null; }
}

const str = (v) => (typeof v === 'string' ? v : '');

/** Detection collector: first evidence wins, root manifests are read first. */
function makeCollector() {
  const found = new Map();
  return {
    found,
    add(id, evidence, scope) {
      if (!CANONICAL.has(id) || !TECH_INFO[id]) return;
      const prev = found.get(id);
      const order = { root: 0, workspace: 1, nested: 2 };
      if (prev && order[prev.scope] <= order[scope]) return;
      found.set(id, { id, evidence, scope });
    },
  };
}

function fromPackageJson(text, rel, scope, add) {
  const pkg = parseJson(text);
  if (!pkg) return null;
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg[field];
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue;
    for (const [name, range] of Object.entries(deps)) {
      const id = NPM_DEPS[name] || (name.startsWith('@storybook/') ? 'storybook' : null);
      const kind = field === 'dependencies' ? 'dependency' : field.replace(/Dependencies$/, ' dependency');
      if (id) add(id, `${rel} ${kind} ${name}${str(range) ? ` ${str(range)}` : ''}`, scope);
    }
  }
  const engines = pkg.engines && typeof pkg.engines === 'object' ? pkg.engines : {};
  if (str(engines.bun)) add('bun', `${rel} engines bun ${engines.bun}`, scope);
  if (str(engines.node)) add('node', `${rel} engines node ${engines.node}`, scope);
  const pm = str(pkg.packageManager).match(/^(npm|yarn|pnpm|bun)@/);
  if (pm) add(pm[1], `${rel} packageManager ${pkg.packageManager}`, scope);
  return pkg;
}

/** Python requirement strings: "Django>=4.2", `django = "^4.2"`, 'flask', ... */
const PY_TARGETS = { django: 'django', fastapi: 'fastapi', flask: 'flask', pytest: 'pytest' };
function fromPython(text, rel, scope, add) {
  const names = Object.keys(PY_TARGETS).join('|');
  const patterns = [
    // requirements.txt lines
    new RegExp(`^\\s*(${names})(?:\\[[^\\]]*\\])?\\s*((?:[<>=!~]=?|===)[^;#\\s]*)?\\s*(?:[;#].*)?$`, 'gim'),
    // quoted PEP 508 strings in pyproject, setup.py, setup.cfg
    new RegExp(`["'](${names})(?:\\[[^\\]]*\\])?\\s*((?:[<>=!~]=?)[^"';]*)?\\s*(?:;[^"']*)?["']`, 'gi'),
    // TOML keys: poetry and Pipfile
    new RegExp(`^\\s*(${names})\\s*=\\s*(?:"([^"]*)"|\\{[^}]*version\\s*=\\s*"([^"]*)")?`, 'gim'),
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text))) {
      const name = m[1].toLowerCase();
      const ver = (m[2] || m[3] || '').trim();
      add(PY_TARGETS[name], `${rel} dependency ${name}${ver && ver !== '*' ? ` ${ver}` : ''}`, scope);
    }
  }
  if (/^\[tool\.poetry[\].]/m.test(text)) add('poetry', `${rel} [tool.poetry]`, scope);
}

function fromCargo(text, rel, scope, add) {
  add('cargo', rel, scope);
  const map = { 'actix-web': 'actix', axum: 'axum', rocket: 'rocket', tauri: 'tauri' };
  const re = /^\s*(actix-web|axum|rocket|tauri)\s*=\s*(?:"([^"]*)"|\{[^}\n]*?version\s*=\s*"([^"]*)"|\{[^}\n]*workspace\s*=\s*true)?/gm;
  let m;
  while ((m = re.exec(text))) add(map[m[1]], `${rel} dependency ${m[1]}${m[2] || m[3] ? ` ${m[2] || m[3]}` : ''}`, scope);
  const table = /^\[(?:[\w.-]*\.)?dependencies\.(actix-web|axum|rocket|tauri)\]/gm;
  while ((m = table.exec(text))) add(map[m[1]], `${rel} dependency ${m[1]}`, scope);
}

function fromGoMod(text, rel, scope, add) {
  const re = /^\s*(?:require\s+)?(github\.com\/gin-gonic\/gin|github\.com\/gofiber\/fiber(?:\/v\d+)?)\s+(v[\w.+-]+)/gm;
  let m;
  while ((m = re.exec(text))) add(m[1].includes('gin-gonic') ? 'gin' : 'fiber', `${rel} require ${m[1]} ${m[2]}`, scope);
}

function fromPubspec(text, rel, scope, add) {
  if (/^\s+sdk:\s*["']?flutter["']?\s*$/m.test(text)) add('flutter', `${rel} dependency flutter (sdk)`, scope);
}

function fromComposer(text, rel, scope, add) {
  const pkg = parseJson(text);
  if (!pkg) return;
  const map = {
    'laravel/framework': 'laravel', 'symfony/framework-bundle': 'symfony', 'symfony/symfony': 'symfony',
    'symfony/http-kernel': 'symfony',
  };
  for (const field of ['require', 'require-dev']) {
    const deps = pkg[field];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, range] of Object.entries(deps)) {
      if (map[name]) add(map[name], `${rel} require ${name}${str(range) ? ` ${str(range)}` : ''}`, scope);
    }
  }
}

function fromGemfile(text, rel, scope, add) {
  const m = text.match(/^\s*gem\s+["'](rails|railties)["'](?:\s*,\s*["']([^"']+)["'])?/m);
  if (m) add('rails', `${rel} gem ${m[1]}${m[2] ? ` ${m[2]}` : ''}`, scope);
}

function fromGradle(text, rel, scope, add) {
  if (!/libs\.versions\.toml$/.test(rel)) add('gradle', rel, scope);
  if (/com\.android\.(?:application|library)/.test(text)) add('android', `${rel} plugin com.android.application`, scope);
  const boot = text.match(/org\.springframework\.boot["']?\)?\s*(?:version\s*["']([^"']+)["'])?/);
  if (boot) add('spring-boot', `${rel} plugin org.springframework.boot${boot[1] ? ` ${boot[1]}` : ''}`, scope);
  else if (/org\.springframework[:.]/.test(text)) add('spring', `${rel} dependency org.springframework`, scope);
}

function fromPom(text, rel, scope, add) {
  add('maven', rel, scope);
  const boot = text.match(/<artifactId>(spring-boot[\w-]*)<\/artifactId>(?:\s*<version>([^<]+)<\/version>)?/);
  if (boot) add('spring-boot', `${rel} artifact ${boot[1]}${boot[2] ? ` ${boot[2]}` : ''}`, scope);
  else if (/<groupId>org\.springframework<\/groupId>/.test(text)) add('spring', `${rel} groupId org.springframework`, scope);
}

function fromDotnet(text, rel, scope, add) {
  add('dotnet', rel, scope);
  if (/Sdk\s*=\s*"Microsoft\.NET\.Sdk\.Web"|Microsoft\.AspNetCore/.test(text)) add('aspnet', `${rel} Microsoft.NET.Sdk.Web`, scope);
}

function fromCompose(text, rel, scope, add) {
  add('docker-compose', rel, scope);
  const re = /^\s*image:\s*["']?([^\s"'#]+)/gm;
  let m;
  while ((m = re.exec(text))) {
    const image = m[1];
    const name = image.split('/').pop().split(/[:@]/)[0].toLowerCase();
    const id = /^(?:postgres|postgresql|postgis|pgvector|timescaledb)$/.test(name) ? 'postgres'
      : /^(?:mysql|mariadb)$/.test(name) ? 'mysql'
        : /^mongo(?:db)?$/.test(name) ? 'mongodb'
          : /^(?:redis|redis-stack|redis-stack-server|valkey)$/.test(name) ? 'redis' : null;
    if (id) add(id, `${rel} service image ${image}`, scope);
  }
}

/** Parse one manifest by filename. Never throws. */
function parseManifest(rel, text, scope, add, state) {
  const base = baseOf(rel);
  try {
    if (base === 'package.json') {
      const pkg = fromPackageJson(text, rel, scope, add);
      if (pkg && !rel.includes('/')) state.rootPkg = pkg;
      if (pkg) state.sawPackageJson = true;
    } else if (base === 'deno.json' || base === 'deno.jsonc') add('deno', rel, scope);
    else if (base === 'pnpm-workspace.yaml') state.pnpmWorkspace = text;
    else if (base === 'manage.py') {
      if (/DJANGO_SETTINGS_MODULE|django\.core\.management/.test(text)) add('django', `${rel} django management entry point`, scope);
    } else if (base === 'Pipfile') { add('pipenv', rel, scope); fromPython(text, rel, scope, add); }
    else if (base === 'pyproject.toml' || base === 'setup.py' || base === 'setup.cfg' || REQUIREMENTS_RE.test(base)) fromPython(text, rel, scope, add);
    else if (base === 'Cargo.toml') fromCargo(text, rel, scope, add);
    else if (base === 'go.mod') fromGoMod(text, rel, scope, add);
    else if (base === 'pubspec.yaml') fromPubspec(text, rel, scope, add);
    else if (base === 'composer.json') fromComposer(text, rel, scope, add);
    else if (base === 'Gemfile') fromGemfile(text, rel, scope, add);
    else if (/^(?:build|settings)\.gradle(?:\.kts)?$|^libs\.versions\.toml$/.test(base)) fromGradle(text, rel, scope, add);
    else if (base === 'pom.xml') fromPom(text, rel, scope, add);
    else if (DOTNET_RE.test(base)) fromDotnet(text, rel, scope, add);
    else if (base === 'Package.swift') { if (/\.iOS\s*\(/.test(text)) add('ios', `${rel} platform .iOS`, scope); }
    else if (base === 'Podfile') { if (/^\s*platform\s+:ios/m.test(text)) add('ios', `${rel} platform :ios`, scope); }
    else if (base === 'project.pbxproj') {
      add('xcode', dirOf(rel) || rel, scope);
      if (/SDKROOT = iphoneos|IPHONEOS_DEPLOYMENT_TARGET/.test(text)) add('ios', `${dirOf(rel) || rel} SDKROOT iphoneos`, scope);
    } else if (base === 'mix.exs') {
      const m = text.match(/\{:phoenix,\s*"([^"]+)"/);
      if (m) add('phoenix', `${rel} dependency phoenix ${m[1]}`, scope);
    } else if (COMPOSE_RE.test(base)) fromCompose(text, rel, scope, add);
    else if (/\.ya?ml$/i.test(base)) {
      if (/^apiVersion:\s*\S+/m.test(text) && /^kind:\s*\S+/m.test(text)) add('kubernetes', `${rel} apiVersion + kind`, scope);
    }
  } catch { /* a bad manifest never breaks detection */ }
}

function isManifestName(base) {
  return MANIFEST_NAMES.has(base) || REQUIREMENTS_RE.test(base) || DOTNET_RE.test(base) || COMPOSE_RE.test(base);
}

/** Read a small regular file, or null. */
async function readCapped(fs, file, cap = MANIFEST_CAP) {
  try {
    const st = await fs.lstat(file);
    if (!st.isFile() || st.size > cap) return null;
    const buf = await fs.readFile(file);
    return { text: String(buf), mtimeMs: st.mtimeMs || 0 };
  } catch { return null; }
}

function workspaceMatchers(state) {
  const globs = [];
  const ws = state.rootPkg && state.rootPkg.workspaces;
  if (Array.isArray(ws)) globs.push(...ws);
  else if (ws && Array.isArray(ws.packages)) globs.push(...ws.packages);
  if (state.pnpmWorkspace) {
    let inPackages = false;
    for (const line of state.pnpmWorkspace.split('\n')) {
      if (/^packages:\s*$/.test(line)) { inPackages = true; continue; }
      if (inPackages) {
        const m = line.match(/^\s*-\s*["']?([^"'#]+?)["']?\s*$/);
        if (m) globs.push(m[1]);
        else if (/^\S/.test(line)) inPackages = false;
      }
    }
  }
  return globs.filter((g) => typeof g === 'string').map(globToRe).filter(Boolean);
}

/**
 * Frameworks from manifests. `files` are rel paths (from git or the walk),
 * `names` the root entries (folders included). Returns { list, primaryFw, manifests }.
 */
async function detectFrameworks(dir, files, ctx) {
  const col = makeCollector();
  const add = (id, ev, scope) => col.add(id, ev, scope);
  const state = {};
  const manifests = [];
  let truncated = false;

  // Read a group in parallel, then parse in list order so evidence is stable.
  const readAndParseAll = async (list) => {
    const texts = await Promise.all(list.map(([rel]) => {
      if (ctx.signal?.aborted || ctx.now() >= ctx.deadline) { truncated = true; return null; }
      return readCapped(ctx.fs, path.join(dir, rel));
    }));
    list.forEach(([rel, scope], i) => {
      const r = texts[i];
      if (!r) return;
      manifests.push([rel, r.mtimeMs]);
      parseManifest(rel, r.text, scope, add, state);
    });
  };

  // Presence-only evidence, from the file list.
  const rootLock = [];
  let tfSeen = false;
  let dockerSeen = false;
  let xibSeen = false;
  let xcodeSeen = false;
  const nested = [];
  const k8sCandidates = [];
  for (const rel of files) {
    if (inVendoredDir(rel)) continue;
    const base = baseOf(rel);
    const depth = depthOf(rel);
    if (depth === 0 && LOCKFILES[base]) rootLock.push(base);
    if (!tfSeen && /\.tf$/i.test(base)) { tfSeen = true; add('terraform', rel, depth ? 'nested' : 'root'); }
    if (!dockerSeen && depth <= 3 && DOCKERFILE_RE.test(base) && !NOISE_DIRS.test(rel)) {
      dockerSeen = true; add('docker', rel, depth ? 'nested' : 'root');
    }
    if (base === 'ansible.cfg') add('ansible', rel, depth ? 'nested' : 'root');
    if (/\.(?:xib|storyboard)$/i.test(base)) xibSeen = true;
    if (!xcodeSeen && base === 'project.pbxproj' && /\.xcodeproj$/.test(dirOf(rel))) {
      xcodeSeen = true; add('xcode', dirOf(rel), depth > 1 ? 'nested' : 'root');
    }
    if (depth === 0) continue;
    if (base === 'project.pbxproj' && depth <= 3) nested.push(rel);
    else if (isManifestName(base) && depth <= 2 && !NOISE_DIRS.test(rel)) nested.push(rel);
    else if (/\.ya?ml$/i.test(base) && K8S_DIR_RE.test(rel) && k8sCandidates.length < 8) k8sCandidates.push(rel);
  }
  for (const lock of rootLock) add(LOCKFILES[lock], `${lock} present`, 'root');

  // 1. Root manifests.
  // Dependency manifests first, entry-point hints (manage.py) last.
  const rootManifests = files.filter((rel) => !rel.includes('/') && isManifestName(rel))
    .sort((a, b) => (a === 'manage.py') - (b === 'manage.py') || a.localeCompare(b));
  await readAndParseAll(rootManifests.map((rel) => [rel, 'root']));
  if (state.sawPackageJson && !col.found.has('node') && !col.found.has('bun') && !col.found.has('deno')) {
    add('node', 'package.json', 'root');
  }

  // 2. Workspace packages, then other shallow manifests, up to a limit.
  const matchers = workspaceMatchers(state);
  const isWorkspace = (rel) => matchers.some((re) => re.test(dirOf(rel)));
  const wsManifests = [];
  const otherManifests = [];
  if (matchers.length) {
    for (const rel of files) {
      if (baseOf(rel) !== 'package.json' || !rel.includes('/') || inVendoredDir(rel)) continue;
      if (isWorkspace(rel)) wsManifests.push(rel);
    }
  }
  const wsSet = new Set(wsManifests);
  for (const rel of nested) if (!wsSet.has(rel)) otherManifests.push(rel);
  const budgetList = [
    ...wsManifests.slice(0, MAX_MANIFESTS).map((rel) => [rel, 'workspace']),
    ...otherManifests.map((rel) => [rel, isWorkspace(rel) ? 'workspace' : 'nested']),
    ...k8sCandidates.map((rel) => [rel, 'nested']),
  ].slice(0, MAX_MANIFESTS);
  for (let i = 0; i < budgetList.length; i += 8) {
    await readAndParseAll(budgetList.slice(i, i + 8));
    if (truncated) break;
  }
  return { found: col.found, manifests, truncated, hints: { xcode: xcodeSeen, xib: xibSeen } };
}

/** Frameworks eligible for primary: root or workspace evidence, or nested ones when the root has no manifest. */
function pickPrimaryFramework(found, rootHasManifest) {
  let best = null;
  for (const f of found.values()) {
    if (!RANK.has(f.id)) continue;
    if (f.scope === 'nested' && rootHasManifest) continue;
    const score = (f.scope === 'root' ? 0 : 1000) + RANK.get(f.id);
    if (!best || score < best.score) best = { id: f.id, score };
  }
  return best ? best.id : null;
}

function frameworkList(found) {
  return [...found.values()]
    .map((f) => ({ id: f.id, name: TECH_INFO[f.id][0], category: TECH_INFO[f.id][1], evidence: f.evidence, _scope: f.scope }))
    .sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category)
      || (RANK.has(a.id) ? RANK.get(a.id) : 999) - (RANK.has(b.id) ? RANK.get(b.id) : 999)
      || a.name.localeCompare(b.name))
    .map(({ _scope, ...f }) => f);
}

const ROOT_LANG_MANIFEST = /^(?:package\.json|Cargo\.toml|go\.mod|pubspec\.yaml|composer\.json|Gemfile|pyproject\.toml|Pipfile|setup\.py|requirements\.txt|build\.gradle(?:\.kts)?|pom\.xml|Package\.swift|mix\.exs|[^/]+\.(?:cs|fs)proj)$/;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function makeCtx(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const budgetMs = Number.isFinite(opts.budgetMs) ? opts.budgetMs : 3000;
  return {
    signal: opts.signal,
    exec: opts.exec || defaultExec,
    fs: opts.fs || nodeFs.promises,
    now,
    deadline: now() + budgetMs,
    maxFiles: Number.isFinite(opts.maxFiles) ? opts.maxFiles : 50000,
  };
}

/**
 * Full analysis plus the manifests that were read (path, mtime), which the
 * caller can use as a cache key.
 */
async function analyzeProjectDetailed(dir, opts = {}) {
  const ctx = makeCtx(opts);
  let listing = null;
  if (!ctx.signal?.aborted) {
    try { listing = await enumerateGit(dir, ctx); } catch { listing = null; }
  }
  if (!listing) listing = await enumerateWalk(dir, ctx);

  const allFiles = listing.files.map((f) => f.rel);
  const fw = await detectFrameworks(dir, allFiles, ctx);

  const records = [];
  for (const f of listing.files) {
    if (isExcluded(f.rel)) continue;
    const lang = rawLanguage(f.rel);
    if (lang) records.push({ rel: f.rel, size: f.size, lang });
  }
  const { languages, totalBytes } = summarizeLanguages(records, fw.hints);

  const rootHasManifest = allFiles.some((rel) => !rel.includes('/') && ROOT_LANG_MANIFEST.test(rel));
  const primaryFw = pickPrimaryFramework(fw.found, rootHasManifest);
  const topLang = languages.find((l) => l.id !== 'other');
  const primary = primaryFw ? { id: primaryFw, name: TECH_INFO[primaryFw][0] }
    : topLang ? { id: topLang.id, name: topLang.name } : null;

  const result = {
    languages,
    frameworks: frameworkList(fw.found),
    primary,
    analysis: {
      analyzedAt: ctx.now(),
      fileCount: records.length,
      totalBytes,
      truncated: Boolean(listing.truncated || fw.truncated || ctx.signal?.aborted),
      source: listing.source,
    },
  };
  return { result, manifests: fw.manifests };
}

/** analyzeProject(dir, { signal, exec, fs, now, budgetMs, maxFiles }) -> { languages, frameworks, primary, analysis } */
async function analyzeProject(dir, opts = {}) {
  return (await analyzeProjectDetailed(dir, opts)).result;
}

// Root marker to the language a project most likely is, when no framework shows.
const QUICK_LANG = [
  ['tsconfig.json', 'typescript'], ['Cargo.toml', 'rust'], ['go.mod', 'go'], ['pubspec.yaml', 'dart'],
  ['composer.json', 'php'], ['Gemfile', 'ruby'], ['mix.exs', 'elixir'], ['Package.swift', 'swift'],
  ['build.gradle.kts', 'kotlin'], ['pom.xml', 'java'], ['build.gradle', 'java'], ['pyproject.toml', 'python'],
  ['requirements.txt', 'python'], ['Pipfile', 'python'], ['setup.py', 'python'], ['package.json', 'javascript'],
];

/**
 * Lightweight primary for the project list: root manifests only, no file
 * enumeration. `names` is the root listing the scanner already read.
 */
async function quickPrimary(dir, names, opts = {}) {
  try {
    const ctx = makeCtx({ budgetMs: 1000, ...opts });
    const col = makeCollector();
    const state = {};
    const add = (id, ev, scope) => col.add(id, ev, scope);
    const toRead = names.filter((n) => isManifestName(n) && n !== 'pnpm-workspace.yaml' && !COMPOSE_RE.test(n));
    const texts = await Promise.all(toRead.map((n) => readCapped(ctx.fs, path.join(dir, n))));
    toRead.forEach((n, i) => { if (texts[i]) parseManifest(n, texts[i].text, 'root', add, state); });
    const fwId = pickPrimaryFramework(col.found, true);
    if (fwId) return { id: fwId, name: TECH_INFO[fwId][0] };
    const set = new Set(names);
    const hit = QUICK_LANG.find(([marker]) => set.has(marker));
    if (hit) return { id: hit[1], name: LANG_INFO[hit[1]][0] };
    if (names.some((n) => DOTNET_RE.test(n))) return { id: 'csharp', name: 'C#' };
    return null;
  } catch { return null; }
}

module.exports = {
  analyzeProject, analyzeProjectDetailed, quickPrimary,
  // exported for tests
  rawLanguage, isExcluded, summarizeLanguages, LANG_INFO, TECH_INFO,
};
