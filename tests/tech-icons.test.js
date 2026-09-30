'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ALL, LANGUAGES, FRAMEWORKS, TOOLS, FALLBACK, sanitizeTechId, sanitizeFlavor } = require('../src/tech-ids');

const ROOT = path.join(__dirname, '..', 'src', 'renderer', 'icons', 'tech');
const FLAVORS = ['mocha', 'latte'];

test('id lists are unique and non-empty', () => {
  for (const l of [LANGUAGES, FRAMEWORKS, TOOLS, FALLBACK]) assert.ok(l.length > 0);
  assert.equal(new Set(ALL).size, ALL.length);
  assert.ok(ALL.includes('file') && ALL.includes('folder'));
});

for (const flavor of FLAVORS) {
  test(`every id has a ${flavor} svg`, () => {
    for (const id of ALL) assert.ok(fs.existsSync(path.join(ROOT, flavor, id + '.svg')), `${flavor}/${id}.svg missing`);
  });

  test(`${flavor} svgs are safe and well formed`, () => {
    for (const id of ALL) {
      const svg = fs.readFileSync(path.join(ROOT, flavor, id + '.svg'), 'utf8');
      const tag = `${flavor}/${id}`;
      assert.match(svg, /^\s*(<\?xml[^>]*\?>\s*)?<svg[\s>]/, `${tag} not an svg root`);
      assert.match(svg, /<\/svg>\s*$/, `${tag} not closed`);
      assert.match(svg, /viewBox\s*=/, `${tag} has no viewBox`);
      assert.doesNotMatch(svg, /<script/i, `${tag} has script`);
      assert.doesNotMatch(svg, /<foreignObject/i, `${tag} has foreignObject`);
      assert.doesNotMatch(svg, /\son[a-z]+\s*=/i, `${tag} has event handler`);
      assert.doesNotMatch(svg, /javascript:/i, `${tag} has javascript: url`);
      assert.doesNotMatch(svg, /@import/i, `${tag} has @import`);
      assert.doesNotMatch(svg, /(?:xlink:)?href\s*=\s*["']\s*(?:https?:|\/\/|data:)/i, `${tag} has external href`);
      assert.doesNotMatch(svg, /url\(\s*["']?\s*(?:https?:|\/\/)/i, `${tag} has external url()`);
      const opens = (svg.match(/<(?![/?!])[a-zA-Z][^>]*[^/]>/g) || []).length;
      const closes = (svg.match(/<\/[a-zA-Z]+>/g) || []).length;
      assert.equal(opens, closes, `${tag} unbalanced tags`);
    }
  });
}

test('sanitizeTechId accepts plain ids and rejects traversal', () => {
  assert.equal(sanitizeTechId('nextjs'), 'nextjs');
  assert.equal(sanitizeTechId('docker-compose'), 'docker-compose');
  for (const bad of ['../main', 'mocha/../../x', '..', 'a/b', 'a\\b', 'a.svg', '', 'UP', null, undefined, 42, {}]) {
    assert.equal(sanitizeTechId(bad), null, String(bad));
  }
});

test('sanitizeFlavor allows only mocha and latte, default mocha', () => {
  assert.equal(sanitizeFlavor('latte'), 'latte');
  assert.equal(sanitizeFlavor('mocha'), 'mocha');
  for (const bad of ['frappe', 'macchiato', '../mocha', 'LATTE', '', null, undefined]) {
    assert.equal(sanitizeFlavor(bad), 'mocha', String(bad));
  }
});
