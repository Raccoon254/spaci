'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { BRAND_IDS, hasDark, BRAND_FOR_TOOL, BRAND_FOR_BROWSER, sanitizeBrandId, sanitizeTheme } = require('../src/brand-ids');
const { buildBrowserTargets } = require('../src/browsers');

const ROOT = path.join(__dirname, '..', 'src', 'renderer', 'icons', 'brand');
const files = [];
for (const id of BRAND_IDS) {
  files.push(id);
  if (hasDark.has(id)) files.push(id + '-dark');
}

test('id list is unique and every id has its file(s)', () => {
  assert.equal(new Set(BRAND_IDS).size, BRAND_IDS.length);
  for (const f of files) assert.ok(fs.existsSync(path.join(ROOT, f + '.svg')), `${f}.svg missing`);
  for (const d of hasDark) assert.ok(BRAND_IDS.includes(d), `${d} in hasDark but not listed`);
});

test('no stray svg files in the brand folder', () => {
  const on = fs.readdirSync(ROOT).filter((f) => f.endsWith('.svg')).map((f) => f.slice(0, -4)).sort();
  assert.deepEqual(on, [...files].sort());
});

test('brand svgs are safe and well formed', () => {
  for (const f of files) {
    const svg = fs.readFileSync(path.join(ROOT, f + '.svg'), 'utf8');
    assert.match(svg, /^\s*(<\?xml[^>]*\?>\s*)?<svg[\s>]/, `${f} not an svg root`);
    assert.match(svg, /<\/svg>\s*$/, `${f} not closed`);
    assert.match(svg, /viewBox\s*=/, `${f} has no viewBox`);
    assert.doesNotMatch(svg, /<script/i, `${f} has script`);
    assert.doesNotMatch(svg, /<foreignObject/i, `${f} has foreignObject`);
    assert.doesNotMatch(svg, /\son[a-z]+\s*=/i, `${f} has event handler`);
    assert.doesNotMatch(svg, /javascript:/i, `${f} has javascript: url`);
    assert.doesNotMatch(svg, /data:/i, `${f} has data: url`);
    assert.doesNotMatch(svg, /@import/i, `${f} has @import`);
    assert.doesNotMatch(svg, /href\s*=\s*["']\s*(?!#)/i, `${f} has external href`);
    assert.doesNotMatch(svg, /url\(\s*["']?\s*(?:https?:|\/\/)/i, `${f} has external url()`);
    // every url(#id) must resolve to an id in the same file
    for (const m of svg.matchAll(/url\(\s*["']?#([^)"'\s]+)/g)) {
      assert.ok(new RegExp(`id\\s*=\\s*["']${m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`).test(svg), `${f} dangling url(#${m[1]})`);
    }
  }
});

test('sanitizeBrandId accepts only vendored ids', () => {
  for (const id of BRAND_IDS) assert.equal(sanitizeBrandId(id), id);
  for (const bad of ['../main', '..', 'claude/../x', 'claude.svg', 'Claude', ' claude', 'continue', 'nope', '', null, undefined, 5, {}, ['claude'], 'claude-dark', '__proto__', 'constructor'])
    assert.equal(sanitizeBrandId(bad), null, String(bad));
});

test('sanitizeTheme defaults to light', () => {
  assert.equal(sanitizeTheme('dark'), 'dark');
  assert.equal(sanitizeTheme('light'), 'light');
  for (const bad of ['DARK', '../dark', '', null, undefined, 1, {}]) assert.equal(sanitizeTheme(bad), 'light');
});

test('tool mapping covers the AI tool ids and only points at vendored ids', () => {
  for (const k of ['claude', 'codex', 'opencode', 'cursor', 'windsurf', 'gemini', 'grok', 'zed', 'copilot', 'continue', 't3'])
    assert.ok(k in BRAND_FOR_TOOL, `${k} unmapped`);
  for (const [k, v] of Object.entries(BRAND_FOR_TOOL)) assert.ok(v === null || BRAND_IDS.includes(v), `${k} -> ${v}`);
  assert.equal(BRAND_FOR_TOOL.continue, null);
});

test('browser mapping covers every browser target id and only points at vendored ids', () => {
  for (const [k, v] of Object.entries(BRAND_FOR_BROWSER)) assert.ok(v === null || BRAND_IDS.includes(v), `${k} -> ${v}`);
  for (const platform of ['darwin', 'linux', 'win32']) {
    let targets;
    try { targets = buildBrowserTargets({ platform, home: '/h', env: { LOCALAPPDATA: 'C:\\L', APPDATA: 'C:\\A' } }); } catch { targets = buildBrowserTargets(); }
    for (const t of targets) assert.ok(t.id in BRAND_FOR_BROWSER, `${t.id} unmapped`);
  }
});
