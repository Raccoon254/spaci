'use strict';
// Canonical tech ids shared by the detection engine, the icon vendor folder
// (src/renderer/icons/tech/<flavor>/<id>.svg) and the tests.
const LANGUAGES = ['typescript', 'javascript', 'python', 'rust', 'go', 'dart', 'kotlin', 'java', 'swift', 'objective-c', 'c', 'cpp', 'csharp', 'fsharp', 'php', 'ruby', 'elixir', 'erlang', 'haskell', 'scala', 'clojure', 'lua', 'perl', 'r', 'julia', 'zig', 'nim', 'ocaml', 'shell', 'powershell', 'sql', 'html', 'css', 'scss', 'sass', 'less', 'svelte', 'vue', 'astro', 'solidity', 'gdscript', 'groovy', 'matlab'];
const FRAMEWORKS = ['react', 'nextjs', 'remix', 'gatsby', 'sveltekit', 'svelte-lib', 'nuxt', 'vue-lib', 'angular', 'solid', 'qwik', 'astro-fw', 'electron', 'tauri', 'react-native', 'expo', 'flutter', 'express', 'nestjs', 'fastify', 'koa', 'hono', 'django', 'fastapi', 'flask', 'rails', 'laravel', 'symfony', 'spring', 'spring-boot', 'dotnet', 'aspnet', 'phoenix', 'gin', 'fiber', 'actix', 'axum', 'rocket'];
const TOOLS = ['node', 'deno', 'bun', 'vite', 'webpack', 'rollup', 'esbuild', 'turbo', 'nx', 'tailwind', 'bootstrap', 'prisma', 'drizzle', 'typeorm', 'sequelize', 'mongoose', 'graphql', 'trpc', 'jest', 'vitest', 'playwright', 'cypress', 'pytest', 'storybook', 'eslint', 'prettier', 'docker', 'docker-compose', 'kubernetes', 'terraform', 'ansible', 'android', 'ios', 'xcode', 'gradle', 'maven', 'cargo', 'poetry', 'pipenv', 'npm', 'yarn', 'pnpm', 'firebase', 'supabase', 'postgres', 'mysql', 'sqlite', 'mongodb', 'redis'];
const FALLBACK = ['file', 'folder'];
const ALL = [...LANGUAGES, ...FRAMEWORKS, ...TOOLS, ...FALLBACK];

// Returns the id when it is a plain [a-z0-9-] token, else null (so '../main'
// or 'mocha/../../x' are rejected outright, never partially cleaned).
function sanitizeTechId(id) {
  return typeof id === 'string' && /^[a-z0-9-]{1,64}$/.test(id) ? id : null;
}
// Exactly 'mocha' or 'latte'; anything else falls back to mocha.
function sanitizeFlavor(flavor) {
  return flavor === 'latte' ? 'latte' : 'mocha';
}

module.exports = { LANGUAGES, FRAMEWORKS, TOOLS, FALLBACK, ALL, sanitizeTechId, sanitizeFlavor };
