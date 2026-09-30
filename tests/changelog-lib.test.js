'use strict';
// The release tooling's rich changelog fields: validation (release.mjs refuses
// to tag on any error), URL rewriting and the payloads for the site and the
// GitHub Release. release.mjs itself is run with --check in a scratch folder,
// which stops before any git command.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..', 'scripts');
const lib = () => import(path.join(SCRIPTS, 'changelog-lib.mjs'));

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

function repo(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-release-'));
  for (const [rel, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), data);
  }
  return root;
}

const NOTES = [
  '# Spaci speaks your language',
  '',
  'Pick one in **Settings**. ![The language picker](media/picker.png "Picker")',
  '',
  '[Docs](https://spaci.kentom.co.ke/docs) and [mail](mailto:hi@kentom.co.ke).',
  '',
  '```md',
  '![not an image](nowhere.png)',
  '```',
  'Inline `![code](nope.png)` stays.',
].join('\n');

const GOOD = {
  version: '2.3.0', date: '2026-10-01', summary: 'Languages.',
  highlight: 'Spaci now speaks 12 languages',
  notes: 'changelog/2.3.0.md',
  media: [{ src: 'changelog/media/hero.png', alt: 'The Projects screen in French', caption: 'French' }, { src: 'https://spaci.kentom.co.ke/media/x.webp', alt: 'x' }],
  links: [{ label: 'Blog post', url: 'https://spaci.kentom.co.ke/blog/2-3' }],
  notice: { severity: 'update', title: 'Spaci 2.3 is out', summary: 'Twelve languages.', cta: { label: 'Update', url: 'https://spaci.kentom.co.ke/download' }, endsInDays: 30 },
};
const goodRepo = () => repo({
  'changelog/2.3.0.md': NOTES,
  'changelog/media/hero.png': PNG,
  'changelog/media/picker.png': PNG,
});

test('a complete, valid entry passes and lists the files the release commit must include', async () => {
  const { validateEntry } = await lib();
  const root = goodRepo();
  try {
    const r = validateEntry(GOOD, { root });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.files.sort(), ['changelog/2.3.0.md', 'changelog/media/hero.png', 'changelog/media/picker.png']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('old entries without the new fields validate and add nothing to the payloads', async () => {
  const { validateEntry, releaseExtras, releaseBodyTop } = await lib();
  const changelog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'changelog.json'), 'utf8'));
  const RICH = ['highlight', 'notes', 'media', 'links', 'notice'];
  for (const e of changelog) {
    assert.deepEqual(validateEntry(e, { root: path.join(__dirname, '..') }).errors, [], e.version);
    // Entries that use the rich fields are covered by the tests above.
    if (RICH.some((k) => e[k] !== undefined)) continue;
    assert.deepEqual(releaseExtras(e), {});
    assert.deepEqual(releaseBodyTop(e), []);
  }
});

test('validation failures, each with a clear message', async () => {
  const { validateEntry } = await lib();
  const root = repo({
    'changelog/2.3.0.md': NOTES.replace('media/picker.png', 'media/missing.png')
      + '\n![](media/ok.png)\n[bad](http://insecure.example) [js](javascript:alert(1)) [rel](../README.md)\n![x](https://evil.com/a.png)\n<img src="x">',
    'changelog/media/ok.png': PNG,
    'changelog/media/fake.png': SVG,
    'changelog/media/logo.svg': SVG,
    'changelog/media/huge.png': Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]),
    'src/secret.png': PNG,
  });
  const cases = [
    [{ highlight: 'x'.repeat(161) }, /highlight: 161 characters; the limit is 160/],
    [{ highlight: 'two\nlines' }, /highlight: must be one line/],
    [{ notes: 'changelog/9.9.9.md' }, /notes: changelog\/9\.9\.9\.md does not exist/],
    [{ notes: 'README.md' }, /notes: must be a Markdown file under changelog\//],
    [{ notes: '../outside.md' }, /notes: must be a Markdown file under changelog\//],
    [{ media: [{ src: 'changelog/media/nope.png', alt: 'a' }] }, /media\[0\]: changelog\/media\/nope\.png does not exist/],
    [{ media: [{ src: 'changelog/media/ok.png' }] }, /media\[0\]: alt text is required/],
    [{ media: [{ src: 'changelog/media/fake.png', alt: 'a' }] }, /is not really a PNG, JPEG, WebP or GIF image/],
    [{ media: [{ src: 'changelog/media/logo.svg', alt: 'a' }] }, /SVG is not allowed/],
    [{ media: [{ src: 'changelog/media/huge.png', alt: 'a' }] }, /images must be under 3 MB/],
    [{ media: [{ src: 'src/secret.png', alt: 'a' }] }, /images must live under changelog\/media\//],
    [{ media: [{ src: 'changelog/media/../../src/secret.png', alt: 'a' }] }, /images must live under changelog\/media\//],
    [{ media: [{ src: 'https://evil.com/a.png', alt: 'a' }] }, /must be https on an allowed host/],
    [{ media: [{ src: 'http://spaci.kentom.co.ke/a.png', alt: 'a' }] }, /must be https on an allowed host/],
    [{ media: [{ src: 'changelog/media/ok.png', alt: 'a', title: 'x' }] }, /unknown field "title"/],
    [{ media: 'x' }, /media: must be an array/],
    [{ links: [{ label: 'x', url: 'http://example.com' }] }, /links\[0\]: url must be an https:\/\/ link/],
    [{ links: [{ label: '', url: 'https://example.com' }] }, /links\[0\]: label must be 1 to 80 characters/],
    [{ notice: { severity: 'urgent' } }, /notice\.severity: must be one of info, update, important, critical/],
    [{ notice: { severity: 'info', title: 'x'.repeat(81) } }, /notice\.title: must be 1 to 80 characters/],
    [{ notice: { severity: 'info', summary: 'x'.repeat(201) } }, /notice\.summary: must be at most 200/],
    [{ notice: { severity: 'info', cta: { label: 'Go', url: 'javascript:x' } } }, /notice\.cta\.url: must be an https:\/\/ link/],
    [{ notice: { severity: 'info', endsInDays: 0 } }, /notice\.endsInDays: must be a whole number/],
    [{ notice: { severity: 'info', audience: {} } }, /notice: unknown field "audience"/],
  ];
  try {
    for (const [fields, re] of cases) {
      const r = validateEntry({ version: '2.3.0', date: 'd', summary: 's', ...fields }, { root });
      assert.ok(r.errors.some((e) => re.test(e)), `${JSON.stringify(fields).slice(0, 80)} -> ${JSON.stringify(r.errors)}`);
    }
    const r = validateEntry({ version: '2.3.0', notes: 'changelog/2.3.0.md' }, { root });
    const all = r.errors.join('\n');
    assert.match(all, /image media\/missing\.png: changelog\/media\/missing\.png does not exist/);
    assert.match(all, /image media\/ok\.png needs alt text/);
    assert.match(all, /link http:\/\/insecure\.example must be https: or mailto:/);
    assert.match(all, /link javascript:alert\(1 must be https: or mailto:/);
    assert.match(all, /link \.\.\/README\.md must be https: or mailto:/);
    assert.match(all, /image https:\/\/evil\.com\/a\.png is not on the allowed hosts/);
    assert.ok(!/nowhere\.png|nope\.png/.test(all), 'code blocks and spans are not validated');
    assert.match(r.warnings.join('\n'), /raw HTML/);
    const crit = validateEntry({ version: '2.3.0', summary: 's', notice: { severity: 'critical' } }, { root });
    assert.deepEqual(crit.errors, []);
    assert.match(crit.warnings.join('\n'), /cannot dismiss/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('notes images are rewritten to raw.githubusercontent.com at the tag; code is left alone', async () => {
  const { rewriteNotesMarkdown, mediaUrl } = await lib();
  const md = rewriteNotesMarkdown(NOTES + '\n![a.png](a.png)\n![abs](/changelog/media/r.png)\n![ext](https://spaci.kentom.co.ke/x.png)\n[ref]: media/ref.png', { version: '2.3.0', notesPath: 'changelog/2.3.0.md' });
  const raw = 'https://raw.githubusercontent.com/Raccoon254/spaci/v2.3.0/';
  assert.match(md, new RegExp(`!\\[The language picker\\]\\(${raw.replace(/[.]/g, '\\.')}changelog/media/picker\\.png "Picker"\\)`));
  assert.ok(md.includes(`![a.png](${raw}changelog/a.png)`), 'alt text untouched, target rewritten');
  assert.ok(md.includes(`![abs](${raw}changelog/media/r.png)`));
  assert.ok(md.includes('![ext](https://spaci.kentom.co.ke/x.png)'));
  assert.ok(md.includes(`[ref]: ${raw}changelog/media/ref.png`));
  assert.ok(md.includes('![not an image](nowhere.png)'), 'fenced code untouched');
  assert.ok(md.includes('`![code](nope.png)`'), 'inline code untouched');
  assert.ok(md.includes('[Docs](https://spaci.kentom.co.ke/docs)'));
  assert.equal(mediaUrl('changelog/media/a b.png', '2.3.0'), `${raw}changelog/media/a%20b.png`);
});

test('releaseExtras and releaseBodyTop carry the rich fields', async () => {
  const { releaseExtras, releaseBodyTop } = await lib();
  const root = goodRepo();
  try {
    const x = releaseExtras(GOOD, { root });
    assert.equal(x.highlight, GOOD.highlight);
    assert.match(x.notes, /^# Spaci speaks your language/);
    assert.ok(x.notes.includes('https://raw.githubusercontent.com/Raccoon254/spaci/v2.3.0/changelog/media/picker.png'));
    assert.deepEqual(x.media[0], {
      src: 'https://raw.githubusercontent.com/Raccoon254/spaci/v2.3.0/changelog/media/hero.png',
      url: 'https://raw.githubusercontent.com/Raccoon254/spaci/v2.3.0/changelog/media/hero.png',
      alt: 'The Projects screen in French', caption: 'French',
    });
    assert.equal(x.media[1].src, 'https://spaci.kentom.co.ke/media/x.webp');
    assert.deepEqual(x.links, GOOD.links);
    assert.deepEqual(x.notice, GOOD.notice);
    const top = releaseBodyTop(GOOD, { root });
    assert.equal(top[0], '**Spaci now speaks 12 languages**');
    assert.match(top[2], /^# Spaci speaks your language/);
    assert.ok(top[2].includes('v2.3.0/changelog/media/picker.png'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function runRelease(root, entries) {
  fs.writeFileSync(path.join(root, 'changelog.json'), JSON.stringify(entries));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
  try {
    const out = execFileSync(process.execPath, [path.join(SCRIPTS, 'release.mjs'), '--check'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: String(e.stdout) + String(e.stderr) };
  }
}

test('release.mjs refuses to release on any error, with the problems listed', () => {
  const root = goodRepo();
  try {
    const ok = runRelease(root, [GOOD]);
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /The 2\.3\.0 changelog entry is valid/);
    const bad = runRelease(root, [{ ...GOOD, highlight: 'x'.repeat(200), links: [{ label: 'x', url: 'http://x' }] }]);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /has 2 problems; nothing was released/);
    assert.match(bad.out, /highlight: 200 characters/);
    assert.match(bad.out, /links\[0\]: url must be an https/);
    fs.rmSync(path.join(root, 'changelog/media/hero.png'));
    const missing = runRelease(root, [GOOD]);
    assert.equal(missing.code, 1);
    assert.match(missing.out, /hero\.png does not exist/);
    assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8').includes('2.3.0'), false, 'package.json untouched');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
