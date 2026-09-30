'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const notices = require('../src/notices');
const { fakeClock } = require('./fake-clock');

const SEC = 1000;
const HOUR = 3600 * SEC;

function notice(over = {}) {
  return {
    id: 'n-1', kind: 'announcement', severity: 'info',
    title: 'Hello', summary: 'A short summary.',
    body: [{ t: 'p', c: [{ t: 'text', v: 'Body' }] }, { t: 'img', url: 'https://spaci.kentom.co.ke/m/a.png', alt: 'shot' }],
    media: [{ url: 'https://spaci.kentom.co.ke/m/b.png', alt: 'b' }], cta: null, version: null, audience: {},
    startsAt: '2026-09-01T00:00:00Z', endsAt: null, dismissible: true,
    publishedAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    ...over,
  };
}

/** A fake fetch: a queue of responders; records every URL. */
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push(url);
    return handler(url, init, calls.length);
  };
  fn.calls = calls;
  return fn;
}
const json = (body, status = 200) => ({ status, text: async () => JSON.stringify(body) });

function harness({ prefs: initial = { onboarded: true }, fetchImpl, version = '2.3.0', stored = null, changelog = [] } = {}) {
  const clock = fakeClock();
  let prefs = { ...initial };
  const saved = [];
  const notified = [];
  const emitted = [];
  let storedData = stored;
  const svc = notices.createNoticesService({
    fetchImpl,
    version,
    platform: 'mac',
    getPrefs: () => prefs,
    patchPrefs: (p) => { prefs = { ...prefs, ...p }; saved.push(p); },
    store: { load: () => storedData, save: (d) => { storedData = JSON.parse(JSON.stringify(d)); } },
    media: { resolve: async (u) => (u.endsWith('a.png') ? 'data:image/png;base64,QQ==' : null) },
    notify: (n) => notified.push(n.id),
    emit: (p) => emitted.push(p),
    readChangelog: () => changelog,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: { info() {}, warn() {}, error() {} },
  });
  return { svc, clock, saved, notified, emitted, get prefs() { return prefs; }, set prefs(p) { prefs = p; }, get stored() { return storedData; } };
}

test('first fetch 30 s after launch with version and platform, then every 6 hours', async () => {
  const fetchImpl = fakeFetch(() => json({ notices: [notice()] }));
  const h = harness({ fetchImpl });
  h.svc.start();
  await h.clock.advance(29 * SEC);
  assert.equal(fetchImpl.calls.length, 0);
  await h.clock.advance(1 * SEC);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0], 'https://spaci.kentom.co.ke/api/notices?version=2.3.0&platform=mac');
  assert.deepEqual(h.emitted, [{ reason: 'fetched' }]);
  await h.clock.advance(6 * HOUR - 10 * SEC);
  assert.equal(fetchImpl.calls.length, 1);
  await h.clock.advance(20 * SEC);
  assert.equal(fetchImpl.calls.length, 2);
  h.svc.stop();
});

test('failures are silent and back off; a malformed feed counts as a failure and keeps the last good list', async () => {
  let mode = 'ok';
  const fetchImpl = fakeFetch(() => {
    if (mode === 'offline') throw new Error('ENOTFOUND');
    if (mode === 'garbage') return { status: 200, text: async () => '<html>' };
    if (mode === 'envelope') return json({ items: [] });
    return json({ notices: [notice()] });
  });
  const h = harness({ fetchImpl });
  h.svc.start();
  await h.clock.advance(30 * SEC);
  assert.equal((await h.svc.list()).length, 1);
  for (mode of ['offline', 'garbage', 'envelope']) {
    const r = await h.svc.refresh();
    assert.equal(r.status, 'failed', mode);
    assert.equal((await h.svc.list()).length, 1, 'last good list kept: ' + mode);
  }
  assert.ok(h.svc.scheduler.nextDue() > h.clock.now(), 'backing off');
  const st = h.svc.scheduler.nextDue() - h.clock.now();
  assert.ok(st >= 15 * 60 * SEC, 'backoff at least the retry base');
  h.svc.stop();
});

test('a request that hangs times out and counts as a failure', async () => {
  const fetchImpl = fakeFetch((_u, init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))));
  const h = harness({ fetchImpl });
  const p = h.svc.refresh();
  await h.clock.advance(16 * SEC);
  assert.equal((await p).status, 'failed');
});

test('the notices pref: off stops fetching, except critical notices while update checks are on', async () => {
  const feed = [notice({ id: 'info' }), notice({ id: 'crit', severity: 'critical', dismissible: false })];
  const fetchImpl = fakeFetch(() => json({ notices: feed }));
  const h = harness({ fetchImpl, prefs: { onboarded: true, notices: false } });
  h.svc.start();
  await h.clock.advance(30 * SEC);
  assert.equal(fetchImpl.calls.length, 1, 'still fetched for critical notices');
  assert.deepEqual((await h.svc.list()).map((n) => n.id), ['crit']);
  h.prefs = { ...h.prefs, autoCheckUpdates: false };
  assert.deepEqual(await h.svc.list(), []);
  await h.clock.advance(7 * HOUR);
  assert.equal(fetchImpl.calls.length, 1, 'no fetching at all');
  h.prefs = { ...h.prefs, notices: true };
  h.svc.reschedule();
  await h.clock.advance(10 * SEC);
  assert.equal(fetchImpl.calls.length, 2, 'resumes after the pref changes');
  h.svc.stop();
});

test('list: client-side audience and window, sorted, seen flag, images as data URLs only', async () => {
  const feed = [
    notice({ id: 'old-info', publishedAt: '2026-09-02T00:00:00Z' }),
    notice({ id: 'new-info', publishedAt: '2026-09-20T00:00:00Z' }),
    notice({ id: 'imp', severity: 'important' }),
    notice({ id: 'win-only', audience: { platforms: ['windows'] } }),
    notice({ id: 'for-old', audience: { maxVersion: '2.2.0' } }),
    notice({ id: 'future', startsAt: '2027-01-01T00:00:00Z' }),
    notice({ id: 'ended', endsAt: '2026-09-10T00:00:00Z' }),
    { id: 'broken' },
  ];
  const h = harness({ fetchImpl: fakeFetch(() => json({ notices: feed })) });
  await h.svc.refresh();
  const list = await h.svc.list();
  assert.deepEqual(list.map((n) => n.id), ['imp', 'new-info', 'old-info']);
  assert.equal(list[0].seen, false);
  assert.deepEqual(list[0].media, [], 'unfetchable media dropped');
  assert.deepEqual(list[0].body.filter((b) => b.t === 'img').map((b) => b.url), ['data:image/png;base64,QQ==']);
  assert.ok(!JSON.stringify(list).includes('https://spaci.kentom.co.ke/m/'), 'no remote image URL reaches the renderer');
});

test('dismiss: persisted, capped at 500, validated, refused for non-dismissible notices', async () => {
  const feed = [notice({ id: 'a' }), notice({ id: 'crit', severity: 'critical', dismissible: false })];
  const h = harness({ fetchImpl: fakeFetch(() => json({ notices: feed })), prefs: { onboarded: true, dismissedNotices: Array.from({ length: 500 }, (_, i) => 'old-' + i) } });
  await h.svc.refresh();
  assert.equal(h.svc.dismiss('a'), true);
  assert.equal(h.prefs.dismissedNotices.length, 500);
  assert.equal(h.prefs.dismissedNotices[499], 'a');
  assert.equal(h.prefs.dismissedNotices[0], 'old-1', 'oldest dropped');
  assert.deepEqual((await h.svc.list()).map((n) => n.id), ['crit']);
  assert.equal(h.svc.dismiss('crit'), false);
  for (const bad of [null, 42, '', 'x'.repeat(129), '../etc', { id: 'a' }, ['a'], 'unknown']) assert.equal(h.svc.dismiss(bad), false);
  assert.deepEqual(h.emitted.filter((e) => e.reason === 'dismissed'), [{ reason: 'dismissed', id: 'a' }]);
});

test('open marks a notice seen and returns it; bad ids return null', async () => {
  const h = harness({ fetchImpl: fakeFetch(() => json({ notices: [notice({ id: 'a' })] })) });
  await h.svc.refresh();
  const n = await h.svc.open('a');
  assert.equal(n.id, 'a');
  assert.equal(n.seen, true);
  assert.deepEqual(h.prefs.seenNoticeIds, ['a']);
  assert.equal((await h.svc.list())[0].seen, true);
  assert.equal(await h.svc.open('missing'), null);
  assert.equal(await h.svc.open({}), null);
  assert.equal(h.svc.has('a'), true);
  assert.equal(h.svc.has('<script>'), false);
});

test('system notifications: update or higher, once per id ever, a few per run at most', async () => {
  let feed = [
    notice({ id: 'info' }), notice({ id: 'upd', severity: 'update' }),
    notice({ id: 'crit', severity: 'critical', dismissible: false }), notice({ id: 'imp', severity: 'important' }),
    notice({ id: 'imp2', severity: 'important' }),
  ];
  const h = harness({ fetchImpl: fakeFetch(() => json({ notices: feed })), prefs: { onboarded: true, seenNoticeIds: ['imp2'] } });
  await h.svc.refresh();
  assert.deepEqual(h.notified, ['crit', 'imp', 'upd'], 'severity order, info and already-seen skipped');
  assert.deepEqual(h.prefs.notifiedNoticeIds, ['crit', 'imp', 'upd']);
  await h.svc.refresh();
  assert.deepEqual(h.notified, ['crit', 'imp', 'upd'], 'never twice');
  feed = [...feed, ...['a', 'b', 'c', 'd'].map((id) => notice({ id, severity: 'update' }))];
  await h.svc.refresh();
  assert.equal(h.notified.length, 3 + notices.MAX_NOTIFY_PER_RUN);
});

test('stored notices are revalidated on load (a tampered notices.json cannot inject content)', async () => {
  const h = harness({
    fetchImpl: fakeFetch(() => { throw new Error('offline'); }),
    stored: { notices: [notice({ id: 'ok' }), notice({ id: 'bad', cta: { label: 'x', url: 'javascript:alert(1)' } }), 'junk'] },
  });
  assert.deepEqual((await h.svc.list()).map((n) => n.id), ['ok']);
  const h2 = harness({ fetchImpl: fakeFetch(() => json({ notices: [] })), stored: 'not json object' });
  assert.deepEqual(await h2.svc.list(), []);
});

// ---------- What's new ----------

const NOTES = { version: '2.3.0', date: '2026-10-01', highlight: 'Spaci speaks your language', body: [{ t: 'p', c: [{ t: 'text', v: 'Hi' }] }], media: [], links: [{ label: 'Blog', url: 'https://spaci.kentom.co.ke/blog' }] };
const CHANGELOG = [{
  version: '2.3.0', date: '2026-10-01', summary: 'Languages.', highlight: 'Offline highlight',
  added: ['Twelve languages'], improved: [], fixed: ['A bug'],
  media: [{ src: 'changelog/media/a.png', alt: 'shot' }, { src: 'changelog/media/../../x.png', alt: 'evil' }],
  links: [{ label: 'Docs', url: 'https://spaci.kentom.co.ke/docs' }, { label: 'Bad', url: 'http://x' }],
}];

test('what\'s new after an upgrade: fetched from the site, shown until seen', async () => {
  const fetchImpl = fakeFetch((url) => (url.includes('/api/releases/') ? json(NOTES) : json({ notices: [] })));
  const h = harness({ fetchImpl, prefs: { onboarded: true, lastSeenVersion: '2.2.0' } });
  h.svc.start();
  assert.deepEqual(h.saved, [], 'an upgrade does not touch lastSeenVersion at launch');
  const w = await h.svc.whatsNew();
  assert.equal(fetchImpl.calls[0], 'https://spaci.kentom.co.ke/api/releases/2.3.0/notes');
  assert.deepEqual(w, { version: '2.3.0', highlight: 'Spaci speaks your language', body: NOTES.body, media: [], links: NOTES.links });
  assert.equal(h.svc.whatsNewSeen('2.2.0'), false, 'only the running version');
  assert.equal(h.svc.whatsNewSeen(123), false);
  assert.equal(h.svc.whatsNewSeen('2.3.0'), true);
  assert.equal(h.prefs.lastSeenVersion, '2.3.0');
  assert.equal(await h.svc.whatsNew(), null, 'once');
  h.svc.stop();
});

test('what\'s new also shows for an onboarded install that predates lastSeenVersion', async () => {
  const h = harness({ fetchImpl: fakeFetch(() => json(NOTES)), prefs: { onboarded: true } });
  h.svc.start();
  assert.equal((await h.svc.whatsNew()).version, '2.3.0');
  h.svc.stop();
});

test('never on a fresh install\'s first run', async () => {
  const fetchImpl = fakeFetch(() => json(NOTES));
  const h = harness({ fetchImpl, prefs: { onboarded: false } });
  h.svc.start();
  assert.equal(h.prefs.lastSeenVersion, '2.3.0', 'recorded at first launch');
  assert.equal(await h.svc.whatsNew(), null);
  h.prefs = { ...h.prefs, onboarded: true }; // finishes onboarding, same version
  assert.equal(await h.svc.whatsNew(), null);
  assert.equal(fetchImpl.calls.filter((u) => u.includes('/releases/')).length, 0);
  h.svc.stop();
});

test('a downgrade records the lower version and shows nothing', async () => {
  const h = harness({ fetchImpl: fakeFetch(() => json(NOTES)), prefs: { onboarded: true, lastSeenVersion: '2.4.0' } });
  h.svc.start();
  assert.equal(h.prefs.lastSeenVersion, '2.3.0');
  assert.equal(await h.svc.whatsNew(), null);
  h.svc.stop();
});

test('offline or not on the site yet: falls back to the bundled changelog entry', async () => {
  for (const fetchImpl of [fakeFetch(() => { throw new Error('ENOTFOUND'); }), fakeFetch(() => json({ error: 'nope' }, 404)), fakeFetch(() => json({ version: '9.9.9' }))]) {
    const h = harness({ fetchImpl, prefs: { onboarded: true, lastSeenVersion: '2.2.0' }, changelog: CHANGELOG });
    const w = await h.svc.whatsNew();
    assert.equal(w.version, '2.3.0');
    assert.equal(w.highlight, 'Offline highlight');
    assert.deepEqual(w.body, [
      { t: 'p', c: [{ t: 'text', v: 'Languages.' }] },
      { t: 'h', level: 3, c: [{ t: 'text', v: 'New' }] },
      { t: 'ul', items: [[{ t: 'text', v: 'Twelve languages' }]] },
      { t: 'h', level: 3, c: [{ t: 'text', v: 'Fixed' }] },
      { t: 'ul', items: [[{ t: 'text', v: 'A bug' }]] },
    ]);
    assert.deepEqual(w.media, [{ url: 'data:image/png;base64,QQ==', alt: 'shot' }], 'raw URL at the tag, then a data URL; traversal dropped');
    assert.deepEqual(w.links, [{ label: 'Docs', url: 'https://spaci.kentom.co.ke/docs' }]);
  }
  const none = harness({ fetchImpl: fakeFetch(() => { throw new Error('offline'); }), prefs: { onboarded: true, lastSeenVersion: '2.2.0' }, changelog: [] });
  assert.equal(await none.svc.whatsNew(), null);
});

test('rawMediaUrl maps repo-relative media to the tag, refusing anything outside changelog/media', () => {
  assert.equal(notices.rawMediaUrl('changelog/media/a b.png', '2.3.0'), 'https://raw.githubusercontent.com/Raccoon254/spaci/v2.3.0/changelog/media/a%20b.png');
  assert.equal(notices.rawMediaUrl('./changelog/media/a.png', '2.3.0'), 'https://raw.githubusercontent.com/Raccoon254/spaci/v2.3.0/changelog/media/a.png');
  assert.equal(notices.rawMediaUrl('src/main.js', '2.3.0'), null);
  assert.equal(notices.rawMediaUrl('changelog/media/../../package.json', '2.3.0'), null);
});

test('capList and cleanId', () => {
  assert.deepEqual(notices.capList(['a', 'b', 'a'], 'b', 2), ['a', 'b']);
  assert.deepEqual(notices.capList('junk', 'x'), ['x']);
  assert.equal(notices.cleanId('rel-2.3.0'), 'rel-2.3.0');
  assert.equal(notices.cleanId('a/b'), null);
});
