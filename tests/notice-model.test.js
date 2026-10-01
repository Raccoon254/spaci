'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../src/notice-model');

const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);

function notice(over = {}) {
  return {
    id: 'n-1', kind: 'announcement', severity: 'info',
    title: 'Hello', summary: 'A short summary.',
    body: [{ t: 'p', c: [{ t: 'text', v: 'Body' }] }],
    media: [], cta: null, version: null, audience: {},
    startsAt: '2026-09-01T00:00:00Z', endsAt: null, dismissible: true,
    publishedAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    ...over,
  };
}

test('image allowlist: hosts, path rules, dot segments, ports, credentials', () => {
  const ok = [
    'https://spaci.kentom.co.ke/media/a.png',
    'https://raw.githubusercontent.com/Raccoon254/spaci/v2.3.0/changelog/media/a.png',
    'https://github.com/Raccoon254/spaci/raw/main/a.png',
    'https://github.com/user-attachments/assets/abc',
  ];
  for (const u of ok) assert.equal(m.isAllowedImageUrl(u), true, u);
  const bad = [
    'http://spaci.kentom.co.ke/a.png',
    'https://raw.githubusercontent.com/evil/spaci/a.png',
    'https://raw.githubusercontent.com/Raccoon254/../evil/a.png',
    'https://raw.githubusercontent.com/Raccoon254/%2e%2e/evil/a.png',
    'https://github.com/evil/a.png',
    'https://spaci.kentom.co.ke.evil.com/a.png',
    'https://evil.com/https://spaci.kentom.co.ke/a.png',
    'https://user:pw@spaci.kentom.co.ke/a.png',
    'https://spaci.kentom.co.ke:8443/a.png',
    'data:image/png;base64,AAAA',
    'javascript:alert(1)',
    ' https://spaci.kentom.co.ke/a.png',
    'https://spaci.kentom.co.ke/a\n.png',
    42, null,
  ];
  for (const u of bad) assert.equal(m.isAllowedImageUrl(u), false, String(u));
});

test('hrefs: https and mailto only', () => {
  assert.equal(m.isSafeHref('https://example.com/x'), true);
  assert.equal(m.isSafeHref('mailto:hi@kentom.co.ke'), true);
  for (const h of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'file:///etc/passwd', '/relative',
    'http://example.com', 'https://u:p@example.com', 'vbscript:x', '\u0000javascript:alert(1)', 'java\tscript:alert(1)']) {
    assert.equal(m.isSafeHref(h), false, h);
  }
});

test('a hostile block payload is reduced to the safe subset', () => {
  const hostile = [
    { t: 'p', c: [{ t: 'link', href: 'javascript:alert(1)', c: [{ t: 'text', v: 'click' }] }] },
    { t: 'p', c: [{ t: 'link', href: 'https://ok.example', c: [{ t: 'text', v: 'fine' }] }] },
    { t: 'img', url: 'https://evil.com/x.png', alt: 'x' },
    { t: 'img', url: 'https://spaci.kentom.co.ke/ok.png', alt: 'ok', onload: 'x' },
    { t: 'script', text: 'alert(1)' },
    { t: 'html', v: '<img src=x onerror=alert(1)>' },
    { t: 'p', c: [{ t: 'text', v: 'x'.repeat(5001) }] },
    { t: 'p', c: [{ t: 'text', v: 'kept' }, { t: 'raw', v: '<b>' }] },
    { t: 'h', level: 1, c: [{ t: 'text', v: 'h1 is not allowed' }] },
    { t: 'h', level: 2, c: [{ t: 'text', v: 'Heading' }], style: 'x' },
    { t: 'ul', items: [[{ t: 'text', v: 'a' }], 'not-an-array', [{ t: 'em', c: [{ t: 'text', v: 'b' }] }]] },
    { t: 'code', text: 'npm i' },
    { t: 'hr', extra: true },
    null, 'str', 42,
  ];
  const out = m.sanitizeBlocks(hostile);
  assert.deepEqual(out, [
    { t: 'p', c: [{ t: 'text', v: 'click' }] },
    { t: 'p', c: [{ t: 'link', href: 'https://ok.example', c: [{ t: 'text', v: 'fine' }] }] },
    { t: 'img', url: 'https://spaci.kentom.co.ke/ok.png', alt: 'ok' },
    { t: 'p', c: [{ t: 'text', v: 'kept' }] },
    { t: 'h', level: 2, c: [{ t: 'text', v: 'Heading' }] },
    { t: 'ul', items: [[{ t: 'text', v: 'a' }], [{ t: 'em', c: [{ t: 'text', v: 'b' }] }]] },
    { t: 'code', text: 'npm i' },
    { t: 'hr' },
  ]);
  assert.ok(!JSON.stringify(out).includes('javascript'));
});

test('block limits: 200 blocks, nesting depth 4', () => {
  const many = Array.from({ length: 300 }, () => ({ t: 'hr' }));
  assert.equal(m.sanitizeBlocks(many).length, 200);
  let deep = { t: 'text', v: 'deep' };
  for (let i = 0; i < 10; i++) deep = { t: 'strong', c: [deep] };
  const out = m.sanitizeBlocks([{ t: 'p', c: [deep, { t: 'text', v: 'shallow' }] }]);
  const depth = (n) => (n.c ? 1 + Math.max(0, ...n.c.map(depth)) : 1);
  assert.ok(out[0].c.every((n) => depth(n) <= 4));
  assert.ok(JSON.stringify(out).includes('shallow'));
});

test('validateNotice accepts a well-formed notice and strips unknown fields', () => {
  const n = m.validateNotice({ ...notice(), extra: 'x', __proto__x: 1 });
  assert.ok(n);
  assert.equal(n.extra, undefined);
  assert.equal(n.cta, null);
});

test('malformed notices are rejected individually, the rest of the feed survives', () => {
  const bad = [
    notice({ id: '' }), notice({ id: 'a b' }), notice({ id: 'x'.repeat(129) }), notice({ id: 5 }),
    notice({ kind: 'ad' }), notice({ severity: 'urgent' }),
    notice({ title: 'x'.repeat(81) }), notice({ title: '   ' }), notice({ summary: 'x'.repeat(201) }),
    notice({ body: 'nope' }), notice({ media: {} }),
    notice({ cta: { label: 'Go', url: 'http://insecure.example' } }), notice({ cta: { label: '', url: 'https://x.example' } }),
    notice({ kind: 'release', version: null }), notice({ version: 'two' }),
    notice({ audience: { platforms: ['amiga'] } }), notice({ audience: { minVersion: 'x' } }), notice({ audience: 'all' }),
    notice({ startsAt: 'yesterday' }), notice({ endsAt: 12 }), notice({ dismissible: 'yes' }),
    notice({ publishedAt: undefined }), null, [], 'notice',
  ];
  const good = notice({ id: 'good' });
  const out = m.parseNoticesResponse({ notices: [...bad, good, notice({ id: 'good' })] });
  assert.deepEqual(out.map((n) => n.id), ['good'], 'only the valid one, deduplicated');
  for (const b of bad) assert.equal(m.validateNotice(b), null, JSON.stringify(b));
});

test('a malformed envelope throws (the fetch counts as failed), never crashes later', () => {
  for (const env of [null, [], 'x', {}, { notices: 'x' }]) assert.throws(() => m.parseNoticesResponse(env), /bad-feed/);
});

test('off-allowlist media and body images are dropped, others kept', () => {
  const n = m.validateNotice(notice({
    media: [{ url: 'https://evil.com/a.png', alt: 'a' }, { url: 'https://spaci.kentom.co.ke/b.png', alt: 'b', caption: 'c' }, { url: 'https://spaci.kentom.co.ke/c.png' }],
  }));
  assert.deepEqual(n.media, [{ url: 'https://spaci.kentom.co.ke/b.png', alt: 'b', caption: 'c' }]);
});

test('audience and active window are applied on the client', () => {
  const ctx = { now: NOW, version: '2.3.0', platform: 'mac' };
  const v = (o) => m.isActiveFor(m.validateNotice(notice(o)), ctx);
  assert.equal(v({}), true);
  assert.equal(v({ startsAt: '2026-10-01T00:00:00Z' }), false, 'not started');
  assert.equal(v({ endsAt: '2026-09-30T12:00:00Z' }), false, 'ends exactly now');
  assert.equal(v({ endsAt: '2026-09-30T12:00:01Z' }), true);
  assert.equal(v({ audience: { platforms: ['windows'] } }), false);
  assert.equal(v({ audience: { platforms: ['mac', 'linux'] } }), true);
  assert.equal(v({ audience: { maxVersion: '2.2.9' } }), false);
  assert.equal(v({ audience: { maxVersion: '2.3.0' } }), true, 'inclusive');
  assert.equal(v({ audience: { minVersion: '2.4.0' } }), false);
});

test('visibleNotices: dismissed dropped, sorted by severity then date, modes', () => {
  const list = m.parseNoticesResponse({ notices: [
    notice({ id: 'info-new', publishedAt: '2026-09-20T00:00:00Z' }),
    notice({ id: 'info-old', publishedAt: '2026-09-02T00:00:00Z' }),
    notice({ id: 'crit', severity: 'critical', dismissible: false }),
    notice({ id: 'upd', severity: 'update' }),
    notice({ id: 'gone', severity: 'important' }),
  ] });
  const ctx = { now: NOW, version: '2.3.0', platform: 'mac' };
  assert.deepEqual(m.visibleNotices(list, { ...ctx, dismissed: ['gone', 'crit'] }).map((n) => n.id), ['crit', 'upd', 'info-new', 'info-old']);
  assert.deepEqual(m.visibleNotices(list, { ...ctx, mode: 'critical' }).map((n) => n.id), ['crit']);
  assert.deepEqual(m.visibleNotices(list, { ...ctx, mode: 'off' }), []);
});

test('noticesMode honours the critical-notice rule', () => {
  assert.equal(m.noticesMode({}), 'all');
  assert.equal(m.noticesMode({ notices: false }), 'critical');
  assert.equal(m.noticesMode({ notices: false, autoCheckUpdates: false }), 'off');
  assert.equal(m.noticesMode({ notices: true, autoCheckUpdates: false }), 'all');
});

test('validateReleaseNotes checks the version and sanitises everything', () => {
  const r = m.validateReleaseNotes({
    version: '2.3.0', date: '2026-10-01', highlight: 'Now in 12 languages',
    body: [{ t: 'p', c: [{ t: 'text', v: 'x' }] }, { t: 'iframe' }],
    media: [{ url: 'https://evil.com/a.png', alt: 'a' }],
    links: [{ label: 'Docs', url: 'https://spaci.kentom.co.ke/docs' }, { label: 'Bad', url: 'javascript:x' }],
  }, '2.3.0');
  assert.deepEqual(r, {
    version: '2.3.0', date: '2026-10-01', highlight: 'Now in 12 languages',
    body: [{ t: 'p', c: [{ t: 'text', v: 'x' }] }], media: [],
    links: [{ label: 'Docs', url: 'https://spaci.kentom.co.ke/docs' }],
  });
  assert.equal(m.validateReleaseNotes({ version: '2.2.0', body: [] }, '2.3.0'), null, 'wrong version');
  assert.equal(m.validateReleaseNotes({ version: '2.3.0', highlight: 'x'.repeat(161) }, '2.3.0'), null);
  assert.equal(m.validateReleaseNotes('nope', '2.3.0'), null);
  assert.equal(m.validateReleaseNotes({ version: '2.3.0', date: '<img onerror=x>' }, '2.3.0').date, null, 'a date that is not a date is dropped');
});
