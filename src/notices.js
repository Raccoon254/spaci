'use strict';
// In-app notices and "What's new", main-process side.
//
//   - Notices: GET https://spaci.kentom.co.ke/api/notices?version&platform,
//     30 s after launch and then every 6 hours (a lane on src/scheduler.js).
//     Every field is validated (notice-model.js), audience and active window
//     are re-applied here, dismissed ids are dropped, and the list is sorted by
//     severity then date. Background failures are silent and back off.
//   - Pref `notices` false: no fetching, except critical notices while update
//     checks are on (noticesMode).
//   - Severity update or higher: one system notification per notice id, ever.
//   - What's new: after an upgrade (never on a fresh install's first run),
//     GET /api/releases/<version>/notes, falling back to the bundled
//     changelog.json entry when offline.
//
// Nothing here touches Electron: fetch, prefs, storage, notifications, the
// clock and timers are injected, so node --test drives all of it.

const { createScheduler, HOUR, MIN } = require('./scheduler');
const { parseVersion, compareVersions } = require('./update-policy');
const {
  LIMITS, SEVERITY_RANK, parseNoticesResponse, validateNotice, visibleNotices, noticesMode,
  validateReleaseNotes, sanitizeBlocks, sanitizeLinks, isAllowedImageUrl,
} = require('./notice-model');
const { hydrateMedia } = require('./notice-media');

const BASE_URL = 'https://spaci.kentom.co.ke';
const REPO_RAW = 'https://raw.githubusercontent.com/Raccoon254/spaci';
const FETCH_TIMEOUT_MS = 15 * 1000;
const MAX_RESPONSE_CHARS = 2 * 1024 * 1024;
const PREF_LIST_CAP = 500;
const MAX_NOTIFY_PER_RUN = 3;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** Ids from the renderer: bounded strings of a safe shape, or null. */
function cleanId(id) {
  return typeof id === 'string' && id.length >= 1 && id.length <= LIMITS.id && ID_RE.test(id) ? id : null;
}
function cleanVersion(v) {
  return typeof v === 'string' && v.length <= 64 && parseVersion(v) ? v : null;
}

/** '2.3.0-rc.1' -> '2.3.0'; a final version is returned as is. */
function baseVersion(v) {
  return typeof v === 'string' ? v.replace(/-.*$/, '') : v;
}

/** Append an id to a persisted list, unique, keeping the newest `cap`. */
function capList(list, id, cap = PREF_LIST_CAP) {
  const prev = Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x !== id) : [];
  prev.push(id);
  return prev.slice(-cap);
}

/** GET a JSON document with a timeout. Resolves {status, json}; rejects on network failure. */
async function getJson(url, { fetchImpl, timeoutMs = FETCH_TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (typeof fetchImpl !== 'function') throw new Error('no-fetch');
  const ac = new AbortController();
  const timer = setTimer(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: ac.signal, redirect: 'error' });
    if (!res || typeof res.status !== 'number') throw new Error('bad-response');
    if (res.status !== 200) return { status: res.status, json: null };
    const text = await res.text();
    if (typeof text !== 'string' || text.length > MAX_RESPONSE_CHARS) throw new Error('response-too-large');
    try { return { status: 200, json: JSON.parse(text) }; } catch (_) { throw new Error('bad-json'); }
  } finally {
    clearTimer(timer);
  }
}

/** Active notices for this app. Throws when the fetch or the feed envelope fails. */
async function fetchNotices({ fetchImpl, base = BASE_URL, version, platform, ...rest }) {
  const q = new URLSearchParams({ version: String(version), platform: String(platform) });
  const { status, json } = await getJson(`${base}/api/notices?${q}`, { fetchImpl, ...rest });
  if (status !== 200) throw new Error('http-' + status);
  return parseNoticesResponse(json);
}

/** Release notes from the site; null when the site has none (404, malformed). Throws when offline. */
async function fetchReleaseNotes({ fetchImpl, base = BASE_URL, version, ...rest }) {
  const { status, json } = await getJson(`${base}/api/releases/${encodeURIComponent(version)}/notes`, { fetchImpl, ...rest });
  if (status !== 200) return null;
  return validateReleaseNotes(json, version);
}

const text = (v) => ({ t: 'text', v: String(v).slice(0, LIMITS.text) });

/** A repo-relative changelog media path -> its immutable raw URL at the tag. */
function rawMediaUrl(src, version) {
  if (typeof src !== 'string') return null;
  if (/^https:\/\//i.test(src)) return src;
  const rel = src.replace(/^\.?\//, '');
  if (!rel.startsWith('changelog/media/') || rel.split('/').includes('..')) return null;
  return `${REPO_RAW}/v${version}/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * The offline fallback: a bundled changelog.json entry as What's new. The
 * desktop never parses Markdown, so `notes` is not used; the summary and the
 * added/improved/fixed lists become blocks.
 */
function whatsNewFromChangelog(entry, asVersion = null) {
  if (!entry || typeof entry !== 'object' || !cleanVersion(entry.version)) return null;
  // A release candidate shows its final version's entry, under its own version
  // (so whatsnew:seen matches) and with media from its own tag, which exists.
  const version = cleanVersion(asVersion) || entry.version;
  const body = [];
  if (typeof entry.summary === 'string' && entry.summary) body.push({ t: 'p', c: [text(entry.summary)] });
  for (const [title, key] of [['New', 'added'], ['Improved', 'improved'], ['Fixed', 'fixed']]) {
    const items = Array.isArray(entry[key]) ? entry[key].filter((s) => typeof s === 'string' && s) : [];
    if (!items.length) continue;
    body.push({ t: 'h', level: 3, c: [text(title)] });
    body.push({ t: 'ul', items: items.map((s) => [text(s)]) });
  }
  const media = [];
  for (const m of Array.isArray(entry.media) ? entry.media : []) {
    if (!m || typeof m !== 'object' || typeof m.alt !== 'string' || !m.alt) continue;
    const url = rawMediaUrl(m.src, version);
    if (!url || !isAllowedImageUrl(url)) continue;
    const item = { url, alt: m.alt.slice(0, LIMITS.alt) };
    if (typeof m.caption === 'string' && m.caption) item.caption = m.caption.slice(0, LIMITS.caption);
    media.push(item);
  }
  const highlight = typeof entry.highlight === 'string' && entry.highlight && entry.highlight.length <= LIMITS.highlight ? entry.highlight : null;
  const date = typeof entry.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.date) ? entry.date : null;
  return { version, date, highlight, body: sanitizeBlocks(body), media, links: sanitizeLinks(entry.links) };
}

/**
 * Should What's new show for this version? Only after an upgrade: a user who
 * has not finished onboarding is on a first run (onboarding covers it). A
 * missing lastSeenVersion on an onboarded install means an upgrade from a
 * version that predates this feature.
 */
function shouldShowWhatsNew(prefs, currentVersion) {
  if (!prefs || !prefs.onboarded || !parseVersion(currentVersion)) return false;
  const last = prefs.lastSeenVersion;
  if (!cleanVersion(last)) return true;
  return compareVersions(currentVersion, last) > 0;
}

/**
 * Launch-time pref fix-up: a first run (not onboarded yet) records the current
 * version as seen, so What's new never follows a fresh install. Also records a
 * downgrade, so upgrading back does not replay old notes. Returns a patch or null.
 */
function startupPrefsPatch(prefs, currentVersion) {
  if (!parseVersion(currentVersion)) return null;
  const last = prefs && prefs.lastSeenVersion;
  if (!prefs || !prefs.onboarded) return last === currentVersion ? null : { lastSeenVersion: currentVersion };
  if (cleanVersion(last) && compareVersions(currentVersion, last) < 0) return { lastSeenVersion: currentVersion };
  return null;
}

/**
 * @param {object} o
 * @param {Function} o.fetchImpl
 * @param {string} o.version  app version
 * @param {'mac'|'windows'|'linux'} o.platform
 * @param {() => object} o.getPrefs
 * @param {(patch:object) => void} o.patchPrefs  merges into the latest prefs, atomically
 * @param {{load:() => any, save:(data:object) => void}} o.store  last fetched notices
 * @param {{resolve:(url:string) => Promise<string|null>}} o.media
 * @param {(notice:object) => void} o.notify  system notification
 * @param {(payload:object) => void} o.emit  notices:updated to the renderer
 * @param {() => object[]} o.readChangelog  the bundled changelog.json
 */
function createNoticesService({
  fetchImpl, base = BASE_URL, version, platform, getPrefs, patchPrefs, store, media, notify = () => {},
  emit = () => {}, readChangelog = () => [], now = () => Date.now(), setTimer = setTimeout,
  clearTimer = clearTimeout, log = console, options = {},
}) {
  const net = { fetchImpl, base, setTimer, clearTimer, timeoutMs: options.fetchTimeoutMs || FETCH_TIMEOUT_MS };
  let notices = loadStored();
  let notesCache = null;
  let schedState = {}; // in memory: every launch fetches 30 s in
  const quiet = { info: () => {}, warn: (...a) => log.warn && log.warn(...a), error: (...a) => log.warn && log.warn(...a) };

  function loadStored() {
    try {
      const data = store.load();
      if (!data || !Array.isArray(data.notices)) return [];
      return data.notices.map(validateNotice).filter(Boolean).slice(0, LIMITS.rawNotices);
    } catch (_) { return []; }
  }

  const prefs = () => { try { return getPrefs() || {}; } catch (_) { return {}; } };
  const ctx = (p) => ({ now: now(), version, platform, dismissed: p.dismissedNotices, mode: noticesMode(p) });
  const visible = (p = prefs()) => visibleNotices(notices, ctx(p));

  function notifyNew(list) {
    const p = prefs();
    const done = new Set([...(p.notifiedNoticeIds || []), ...(p.seenNoticeIds || [])]);
    let sent = 0;
    let notified = p.notifiedNoticeIds;
    for (const n of list) {
      if (sent >= MAX_NOTIFY_PER_RUN) break;
      if (SEVERITY_RANK[n.severity] < SEVERITY_RANK.update || done.has(n.id)) continue;
      // Recorded before showing: a notification that fails is not retried forever.
      notified = capList(notified, n.id);
      sent++;
      try { notify(n); } catch (e) { quiet.warn('[notices] notification failed:', e && e.message); }
    }
    if (sent) patchPrefs({ notifiedNoticeIds: notified });
  }

  async function task() {
    if (noticesMode(prefs()) === 'off') return { status: 'skipped' };
    let list;
    try {
      list = await fetchNotices({ ...net, version, platform });
    } catch (e) {
      // Silent: offline, timeouts and a bad feed only back off.
      return { status: 'failed', reason: (e && e.message) || 'error' };
    }
    notices = list;
    try { store.save({ fetchedAt: now(), notices: list }); } catch (e) { quiet.warn('[notices] could not save:', e && e.message); }
    const vis = visible();
    emit({ reason: 'fetched' });
    notifyNew(vis);
    // Warm the image cache so the list opens without waiting on the network.
    for (const n of vis) hydrateMedia(n, media.resolve).catch(() => {});
    return { status: 'ok', count: vis.length };
  }

  const scheduler = createScheduler({
    name: 'notices',
    task,
    getConfig: () => ({ intervalMs: 6 * HOUR }),
    gate: () => (noticesMode(prefs()) === 'off' ? { run: false, reason: 'disabled' } : { run: true, reason: 'due' }),
    getState: () => schedState,
    saveState: (st) => { schedState = st; },
    log: quiet,
    now,
    setTimer,
    clearTimer,
    options: { startupDelayMs: 30 * 1000, retryBaseMs: 15 * MIN, runTimeoutMs: 60 * 1000, ...(options.scheduler || {}) },
  });

  async function hydrated(n, seenIds) {
    const h = await hydrateMedia(n, media.resolve);
    return { ...h, seen: seenIds.has(n.id) };
  }

  let notesFlight = null;
  async function loadNotes() {
    if (notesCache) return notesCache;
    if (notesFlight) return notesFlight;
    notesFlight = (async () => {
      try {
        const fromSite = await fetchReleaseNotes({ ...net, version });
        if (fromSite) { notesCache = fromSite; return fromSite; }
      } catch (_) { /* offline: fall back to the bundled entry */ }
      let entries = [];
      try { entries = readChangelog() || []; } catch (_) { entries = []; }
      const list = Array.isArray(entries) ? entries : [];
      const entry = list.find((e) => e && e.version === version)
        // 2.3.0-rc.1 has no entry of its own: the changelog describes 2.3.0.
        || list.find((e) => e && e.version === baseVersion(version))
        || null;
      return whatsNewFromChangelog(entry, version);
    })();
    try { return await notesFlight; } finally { notesFlight = null; }
  }

  return {
    start() {
      const patch = startupPrefsPatch(prefs(), version);
      if (patch) { try { patchPrefs(patch); } catch (e) { quiet.warn('[whatsnew] could not save:', e && e.message); } }
      scheduler.start();
    },
    stop() { scheduler.stop(); },
    reschedule() { scheduler.reschedule(); },
    wake() { scheduler.wake(); },
    refresh() { return scheduler.runNow(); },
    get scheduler() { return scheduler; },

    /** notices:list -> Notice[] with `seen`, images as data: URLs. */
    async list() {
      const p = prefs();
      const seenIds = new Set(Array.isArray(p.seenNoticeIds) ? p.seenNoticeIds : []);
      return Promise.all(visible(p).map((n) => hydrated(n, seenIds)));
    },
    /** notices:dismiss(id) -> true when recorded. Non-dismissible notices refuse. */
    dismiss(id) {
      const key = cleanId(id);
      if (!key) return false;
      const n = notices.find((x) => x.id === key);
      if (!n || !n.dismissible) return false;
      patchPrefs({ dismissedNotices: capList(prefs().dismissedNotices, key) });
      emit({ reason: 'dismissed', id: key });
      return true;
    },
    /** notices:open(id) -> the notice (marked seen), or null. */
    async open(id) {
      const key = cleanId(id);
      if (!key) return null;
      const p = prefs();
      const n = visible(p).find((x) => x.id === key);
      if (!n) return null;
      const seen = capList(p.seenNoticeIds, key);
      patchPrefs({ seenNoticeIds: seen });
      return hydrated(n, new Set(seen));
    },
    /** Is `id` currently visible? (A notification click checks before navigating.) */
    has(id) { const key = cleanId(id); return Boolean(key && visible().some((n) => n.id === key)); },

    /**
     * whatsnew:get -> {version, date, highlight, body, media, links} | null.
     * Without options: only once per version (the first launch after an
     * update). { always: true }: whenever the user opens What's new.
     */
    async whatsNew(opts = {}) {
      if (!(opts && opts.always === true) && !shouldShowWhatsNew(prefs(), version)) return null;
      const notes = await loadNotes();
      if (!notes) return null;
      const h = await hydrateMedia(notes, media.resolve);
      const date = typeof notes.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(notes.date) ? notes.date.slice(0, 10) : null;
      return { version: notes.version, date, highlight: notes.highlight, body: h.body, media: h.media, links: notes.links };
    },
    /** whatsnew:seen(version): only the running version can be marked seen. */
    whatsNewSeen(v) {
      if (cleanVersion(v) !== version) return false;
      patchPrefs({ lastSeenVersion: version });
      return true;
    },
  };
}

module.exports = {
  BASE_URL, PREF_LIST_CAP, MAX_NOTIFY_PER_RUN,
  cleanId, cleanVersion, baseVersion, capList, getJson, fetchNotices, fetchReleaseNotes, rawMediaUrl,
  whatsNewFromChangelog, shouldShowWhatsNew, startupPrefsPatch, createNoticesService,
};
