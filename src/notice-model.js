'use strict';
// The notice and release-notes data model, validated on the client.
//
// The website converts Markdown to the Block model and already strips anything
// unsafe. This module checks every field again anyway (defence in depth): the
// feed is network input, and the renderer builds DOM from whatever passes here.
// Rules, from the shared contract:
//   - blocks: h(2|3), p, ul, ol, quote, code, img, hr. Inlines: text, strong,
//     em, code, link. Anything else is dropped.
//   - at most 200 blocks, text runs at most 5,000 chars, nesting depth 4.
//   - links: https: and mailto: only. A link with any other href becomes its
//     plain text.
//   - images: https: only, host on the allowlist (with path rules).
// A notice with a malformed top-level field is rejected on its own; the rest
// of the feed is kept. Nothing here throws on bad input.
//
// Pure: no Electron, no I/O.

const { parseVersion, compareVersions } = require('./update-policy');

const LIMITS = {
  blocks: 200,
  text: 5000,
  depth: 4,
  listItems: 200,
  inlinesPerRun: 500,
  title: 80,
  summary: 200,
  highlight: 160,
  alt: 300,
  caption: 300,
  label: 80,
  url: 2048,
  id: 128,
  media: 12,
  links: 20,
  notices: 20,
  rawNotices: 100,
};

const SEVERITY_RANK = { info: 0, update: 1, important: 2, critical: 3 };
const KINDS = new Set(['release', 'announcement']);
const PLATFORMS = new Set(['mac', 'windows', 'linux']);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
// ISO 8601 date-time as JSON.stringify(Date) and most servers write it.
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;
// Control characters other than tab and newline have no place in a URL.
const URL_BAD_CHARS = /[\u0000-\u0020\u007f-\u009f\u2028\u2029]/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v, max, { min = 0 } = {}) => typeof v === 'string' && v.length >= min && v.length <= max;

function parseUrl(s) {
  if (typeof s !== 'string' || !s || s.length > LIMITS.url || URL_BAD_CHARS.test(s)) return null;
  try { return new URL(s); } catch (_) { return null; }
}

/** A link target the app may open: https (no credentials) or mailto. */
function isSafeHref(href) {
  const u = parseUrl(href);
  if (!u) return false;
  if (u.protocol === 'mailto:') return u.pathname.length > 0;
  if (u.protocol !== 'https:') return false;
  return Boolean(u.hostname) && !u.username && !u.password;
}

/** An https URL the app may open (CTA buttons, release links). */
function isHttpsUrl(href) {
  const u = parseUrl(href);
  return Boolean(u && u.protocol === 'https:' && u.hostname && !u.username && !u.password);
}

/**
 * Image hosts the main process may fetch from. Checked on the parsed URL, so
 * dot segments and percent-encoded dots are already resolved in `pathname`.
 */
function isAllowedImageUrl(s) {
  const u = parseUrl(s);
  if (!u || u.protocol !== 'https:' || u.username || u.password) return false;
  if (u.port && u.port !== '443') return false;
  const host = u.hostname.toLowerCase();
  const p = u.pathname;
  if (host === 'spaci.kentom.co.ke') return true;
  if (host === 'raw.githubusercontent.com') return p.startsWith('/Raccoon254/');
  if (host === 'github.com') return p.startsWith('/Raccoon254/') || p.startsWith('/user-attachments/');
  return false;
}

// ---------- blocks ----------

/** Inline[] -> clean Inline[]. Unsafe links become their children. */
function sanitizeInlines(list, depth = 1, budget = { n: 0 }) {
  if (!Array.isArray(list) || depth > LIMITS.depth) return [];
  const out = [];
  for (const node of list.slice(0, LIMITS.inlinesPerRun)) {
    if (!isObj(node)) continue;
    switch (node.t) {
      case 'text':
      case 'code':
        if (isStr(node.v, LIMITS.text)) out.push({ t: node.t, v: node.v });
        break;
      case 'strong':
      case 'em': {
        if (depth >= LIMITS.depth) break;
        const c = sanitizeInlines(node.c, depth + 1, budget);
        if (c.length) out.push({ t: node.t, c });
        break;
      }
      case 'link': {
        if (depth >= LIMITS.depth) break;
        const c = sanitizeInlines(node.c, depth + 1, budget);
        if (isSafeHref(node.href)) { if (c.length) out.push({ t: 'link', href: node.href, c }); }
        else out.push(...c); // plain text, never a clickable unsafe href
        break;
      }
      default: break; // unknown inline type: dropped
    }
  }
  return out;
}

function sanitizeImage(node) {
  if (!isAllowedImageUrl(node.url) || !isStr(node.alt, LIMITS.alt)) return null;
  const img = { url: node.url, alt: node.alt };
  if (node.caption !== undefined && node.caption !== null) {
    if (!isStr(node.caption, LIMITS.caption)) return null;
    img.caption = node.caption;
  }
  return img;
}

/** Block[] -> clean Block[]. Never throws; unknown or unsafe blocks are dropped. */
function sanitizeBlocks(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const b of list.slice(0, LIMITS.blocks)) {
    if (!isObj(b)) continue;
    switch (b.t) {
      case 'h': {
        if (b.level !== 2 && b.level !== 3) break;
        const c = sanitizeInlines(b.c);
        if (c.length) out.push({ t: 'h', level: b.level, c });
        break;
      }
      case 'p':
      case 'quote': {
        const c = sanitizeInlines(b.c);
        if (c.length) out.push({ t: b.t, c });
        break;
      }
      case 'ul':
      case 'ol': {
        if (!Array.isArray(b.items)) break;
        const items = b.items.slice(0, LIMITS.listItems).map((it) => sanitizeInlines(it, 2)).filter((c) => c.length);
        if (items.length) out.push({ t: b.t, items });
        break;
      }
      case 'code':
        if (isStr(b.text, LIMITS.text)) out.push({ t: 'code', text: b.text });
        break;
      case 'img': {
        const img = sanitizeImage(b);
        if (img) out.push({ t: 'img', ...img });
        break;
      }
      case 'hr':
        out.push({ t: 'hr' });
        break;
      default: break; // unknown block type: dropped
    }
  }
  return out;
}

/** media: [{url, alt, caption?}] with off-allowlist or malformed items dropped. */
function sanitizeMedia(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const m of list.slice(0, LIMITS.media)) {
    if (!isObj(m)) continue;
    const img = sanitizeImage(m);
    if (img) out.push(img);
  }
  return out;
}

function sanitizeLinks(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const l of list.slice(0, LIMITS.links)) {
    if (isObj(l) && isStr(l.label, LIMITS.label, { min: 1 }) && isHttpsUrl(l.url)) out.push({ label: l.label, url: l.url });
  }
  return out;
}

// ---------- notices ----------

function isIso(v) {
  return typeof v === 'string' && ISO_RE.test(v) && Number.isFinite(Date.parse(v));
}

function validAudience(a) {
  if (a === undefined || a === null) return {};
  if (!isObj(a)) return null;
  const out = {};
  if (a.platforms !== undefined) {
    if (!Array.isArray(a.platforms) || a.platforms.length > 3 || !a.platforms.every((p) => PLATFORMS.has(p))) return null;
    out.platforms = [...a.platforms];
  }
  for (const k of ['minVersion', 'maxVersion']) {
    if (a[k] === undefined || a[k] === null) continue;
    if (!parseVersion(a[k])) return null;
    out[k] = a[k];
  }
  return out;
}

/**
 * One raw notice -> a clean Notice, or null when any top-level field is
 * malformed. Unsafe content inside body and media is dropped, not fatal.
 */
function validateNotice(n) {
  if (!isObj(n)) return null;
  if (!isStr(n.id, LIMITS.id, { min: 1 }) || !ID_RE.test(n.id)) return null;
  if (!KINDS.has(n.kind)) return null;
  if (!Object.prototype.hasOwnProperty.call(SEVERITY_RANK, n.severity)) return null;
  if (!isStr(n.title, LIMITS.title, { min: 1 }) || !n.title.trim()) return null;
  if (!isStr(n.summary, LIMITS.summary)) return null;
  if (!Array.isArray(n.body) || !Array.isArray(n.media)) return null;
  let cta = null;
  if (n.cta !== null && n.cta !== undefined) {
    if (!isObj(n.cta) || !isStr(n.cta.label, LIMITS.label, { min: 1 }) || !isHttpsUrl(n.cta.url)) return null;
    cta = { label: n.cta.label, url: n.cta.url };
  }
  let version = null;
  if (n.version !== null && n.version !== undefined) {
    if (!parseVersion(n.version)) return null;
    version = n.version;
  }
  if (n.kind === 'release' && !version) return null;
  const audience = validAudience(n.audience);
  if (!audience) return null;
  if (!isIso(n.startsAt) || !isIso(n.publishedAt) || !isIso(n.updatedAt)) return null;
  if (n.endsAt !== null && n.endsAt !== undefined && !isIso(n.endsAt)) return null;
  if (typeof n.dismissible !== 'boolean') return null;
  return {
    id: n.id,
    kind: n.kind,
    severity: n.severity,
    title: n.title,
    summary: n.summary,
    body: sanitizeBlocks(n.body),
    media: sanitizeMedia(n.media),
    cta,
    version,
    audience,
    startsAt: n.startsAt,
    endsAt: n.endsAt || null,
    dismissible: n.dismissible,
    publishedAt: n.publishedAt,
    updatedAt: n.updatedAt,
  };
}

/**
 * The GET /api/notices body -> clean notices. Throws only when the envelope
 * itself is wrong (so the fetch counts as failed); bad notices are skipped.
 */
function parseNoticesResponse(json) {
  if (!isObj(json) || !Array.isArray(json.notices)) throw new Error('bad-feed');
  const out = [];
  const ids = new Set();
  for (const raw of json.notices.slice(0, LIMITS.rawNotices)) {
    const n = validateNotice(raw);
    if (!n || ids.has(n.id)) continue;
    ids.add(n.id);
    out.push(n);
  }
  return out;
}

/** Is this notice for this app right now? Re-applied on the client. */
function isActiveFor(n, { now, version, platform }) {
  const start = Date.parse(n.startsAt);
  if (!(start <= now)) return false;
  if (n.endsAt && !(now < Date.parse(n.endsAt))) return false;
  const a = n.audience || {};
  if (a.platforms && !a.platforms.includes(platform)) return false;
  if (a.minVersion || a.maxVersion) {
    if (!parseVersion(version)) return false;
    if (a.minVersion && compareVersions(version, a.minVersion) < 0) return false;
    if (a.maxVersion && compareVersions(version, a.maxVersion) > 0) return false;
  }
  return true;
}

function sortNotices(list) {
  const t = (n) => Date.parse(n.publishedAt) || 0;
  return [...list].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
    || t(b) - t(a) || (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
}

/**
 * What the user may see now. `mode` comes from noticesMode(prefs).
 * A notice that is not dismissible stays even if its id was dismissed.
 */
function visibleNotices(list, { now, version, platform, dismissed = [], mode = 'all' }) {
  if (mode === 'off') return [];
  const gone = new Set(Array.isArray(dismissed) ? dismissed : []);
  const out = (Array.isArray(list) ? list : []).filter((n) => n
    && isActiveFor(n, { now, version, platform })
    && !(n.dismissible && gone.has(n.id))
    && (mode === 'all' || n.severity === 'critical'));
  return sortNotices(out).slice(0, LIMITS.notices);
}

/**
 * The `notices` pref turns fetching off, except that critical notices are
 * still fetched unless update checks are off too.
 * @returns {'all'|'critical'|'off'}
 */
function noticesMode(prefs = {}) {
  if (prefs.notices !== false) return 'all';
  if (prefs.autoCheckUpdates !== false) return 'critical';
  return 'off';
}

// ---------- release notes (What's new) ----------

/** GET /api/releases/<version>/notes -> clean notes, or null. */
function validateReleaseNotes(json, expectedVersion) {
  if (!isObj(json) || !isStr(json.version, 64) || !parseVersion(json.version)) return null;
  if (expectedVersion && json.version !== expectedVersion) return null;
  let highlight = null;
  if (json.highlight !== null && json.highlight !== undefined && json.highlight !== '') {
    if (!isStr(json.highlight, LIMITS.highlight)) return null;
    highlight = json.highlight;
  }
  if (json.body !== undefined && !Array.isArray(json.body)) return null;
  return {
    version: json.version,
    // Release day only, as YYYY-MM-DD; anything else is dropped, never shown raw.
    date: typeof json.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(json.date) ? json.date.slice(0, 10) : null,
    highlight,
    body: sanitizeBlocks(json.body || []),
    media: sanitizeMedia(json.media),
    links: sanitizeLinks(json.links),
  };
}

module.exports = {
  LIMITS, SEVERITY_RANK,
  isSafeHref, isHttpsUrl, isAllowedImageUrl,
  sanitizeInlines, sanitizeBlocks, sanitizeMedia, sanitizeLinks,
  validateNotice, parseNoticesResponse, isActiveFor, sortNotices, visibleNotices, noticesMode,
  validateReleaseNotes,
};
