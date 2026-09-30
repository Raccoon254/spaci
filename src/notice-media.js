'use strict';
// Images for notices and What's new, fetched by the main process.
//
// The renderer CSP is `img-src 'self' data:`, so the renderer never loads a
// remote image. The main process downloads allowlisted images and hands back
// data: URLs:
//   - the URL, and every redirect target, must pass isAllowedImageUrl;
//   - at most 3 MB, enforced while streaming (Content-Length is only a hint);
//   - Content-Type must be png, jpeg, webp or gif, and the bytes must sniff as
//     one of those (an SVG or HTML page labelled image/png is refused);
//   - cached on disk under <dir>/<sha256(url)>, written atomically, with the
//     cache bounded by total bytes and file count (least recently used first).
//
// The network is injected (`request`), so tests drive it with fakes. The
// default transport is Node's https with redirects NOT followed automatically.

const nodeFs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isAllowedImageUrl } = require('./notice-model');
const { writeFileAtomic } = require('./scan-cache');

const MAX_BYTES = 3 * 1024 * 1024;
const RASTER = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const DEFAULTS = {
  maxBytes: MAX_BYTES,
  maxCacheBytes: 60 * 1024 * 1024,
  maxCacheFiles: 300,
  maxRedirects: 3,
  timeoutMs: 20 * 1000,
  failureTtlMs: 60 * 60 * 1000,
};

/** The real image type from the first bytes, or null. */
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  const head6 = buf.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

function headerType(headers) {
  const raw = headers && (typeof headers.get === 'function' ? headers.get('content-type') : headers['content-type']);
  return String(Array.isArray(raw) ? raw[0] : raw || '').split(';')[0].trim().toLowerCase();
}
function headerValue(headers, name) {
  const raw = headers && (typeof headers.get === 'function' ? headers.get(name) : headers[name]);
  return Array.isArray(raw) ? raw[0] : raw;
}

const hashUrl = (url) => crypto.createHash('sha256').update(url).digest('hex');

/**
 * Default transport: one GET, no redirect following, response body as a
 * stream. Resolves {status, headers, body (async iterable), destroy()}.
 */
function httpsRequest(url, { timeoutMs = DEFAULTS.timeoutMs } = {}) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { accept: 'image/png,image/jpeg,image/webp,image/gif', 'user-agent': 'Spaci' }, timeout: timeoutMs }, (res) => {
      resolve({ status: res.statusCode, headers: res.headers, body: res, destroy: () => res.destroy() });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/**
 * Download one allowlisted image. Resolves {mime, data: Buffer}; rejects with
 * an Error whose message says why (for logs and tests).
 */
async function downloadImage(url, { request = httpsRequest, maxBytes = DEFAULTS.maxBytes, maxRedirects = DEFAULTS.maxRedirects, timeoutMs = DEFAULTS.timeoutMs } = {}) {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!isAllowedImageUrl(current)) throw new Error(hop ? 'redirect-not-allowed' : 'url-not-allowed');
    const res = await request(current, { timeoutMs });
    const close = () => { try { if (res && res.destroy) res.destroy(); } catch (_) { /* already closed */ } };
    const status = res && res.status;
    if (status >= 300 && status < 400) {
      const loc = headerValue(res.headers, 'location');
      close();
      if (!loc) throw new Error('redirect-without-location');
      try { current = new URL(String(loc), current).href; } catch (_) { throw new Error('bad-redirect'); }
      continue;
    }
    if (status !== 200) { close(); throw new Error('http-' + status); }
    const type = headerType(res.headers);
    if (!RASTER.has(type)) { close(); throw new Error('bad-content-type'); }
    const declared = Number(headerValue(res.headers, 'content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) { close(); throw new Error('too-large'); }
    const chunks = [];
    let total = 0;
    try {
      for await (const chunk of res.body) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += b.length;
        if (total > maxBytes) throw new Error('too-large');
        chunks.push(b);
      }
    } finally {
      if (total > maxBytes) close();
    }
    const data = Buffer.concat(chunks, total);
    const mime = sniffImage(data);
    if (!mime) throw new Error('not-a-raster-image');
    return { mime, data };
  }
  throw new Error('too-many-redirects');
}

/**
 * @param {object} o
 * @param {string} o.dir  cache folder (userData/notice-media)
 * @param {Function} [o.request]  transport, see httpsRequest
 * @param {() => number} [o.now]
 */
function createMediaCache({ dir, request = httpsRequest, fs = nodeFs, now = () => Date.now(), log = console, options = {} }) {
  const opt = { ...DEFAULTS, ...options };
  const inflight = new Map();
  const failures = new Map(); // url -> failedAt, so a broken image is not refetched on every list

  const fileFor = (url) => path.join(dir, hashUrl(url));
  const toDataUrl = (mime, data) => `data:${mime};base64,${data.toString('base64')}`;

  function readCached(url) {
    const file = fileFor(url);
    let data;
    try { data = fs.readFileSync(file); } catch (_) { return null; }
    const mime = sniffImage(data);
    if (!mime || data.length > opt.maxBytes) { try { fs.unlinkSync(file); } catch (_) { /* gone */ } return null; }
    const t = new Date(now());
    try { fs.utimesSync(file, t, t); } catch (_) { /* recency is best effort */ }
    return toDataUrl(mime, data);
  }

  /** Keep the cache under its byte and file budgets, oldest use first. */
  function evict() {
    let names;
    try { names = fs.readdirSync(dir); } catch (_) { return; }
    const entries = [];
    for (const name of names) {
      const file = path.join(dir, name);
      let st;
      try { st = fs.statSync(file); } catch (_) { continue; }
      if (!st.isFile()) continue;
      // Leftover temp files from a crash mid-write.
      if (name.endsWith('.tmp')) { if (now() - st.mtimeMs > 60 * 1000) { try { fs.unlinkSync(file); } catch (_) { /* */ } } continue; }
      entries.push({ file, size: st.size, used: st.mtimeMs });
    }
    entries.sort((a, b) => a.used - b.used);
    let total = entries.reduce((s, e) => s + e.size, 0);
    let count = entries.length;
    for (const e of entries) {
      if (total <= opt.maxCacheBytes && count <= opt.maxCacheFiles) break;
      try { fs.unlinkSync(e.file); total -= e.size; count--; } catch (_) { /* */ }
    }
  }

  /** url -> data: URL, or null when it is not allowed or cannot be fetched. */
  function resolve(url) {
    if (!isAllowedImageUrl(url)) return Promise.resolve(null);
    const hit = readCached(url);
    if (hit) return Promise.resolve(hit);
    const failedAt = failures.get(url);
    if (failedAt && now() - failedAt < opt.failureTtlMs) return Promise.resolve(null);
    if (inflight.has(url)) return inflight.get(url);
    const p = (async () => {
      try {
        const { mime, data } = await downloadImage(url, { request, maxBytes: opt.maxBytes, maxRedirects: opt.maxRedirects, timeoutMs: opt.timeoutMs });
        try {
          writeFileAtomic(fileFor(url), data, { fs });
          evict();
        } catch (e) { log.warn && log.warn('[notice-media] cache write failed:', e && e.message); }
        failures.delete(url);
        return toDataUrl(mime, data);
      } catch (e) {
        failures.set(url, now());
        log.info && log.info('[notice-media] refused or failed:', e && e.message);
        return null;
      } finally {
        inflight.delete(url);
      }
    })();
    inflight.set(url, p);
    return p;
  }

  return { resolve, evict, fileFor };
}

/**
 * Replace every image URL in a notice-like object ({body, media}) with a data:
 * URL. Images that cannot be fetched are dropped, never passed through.
 */
async function hydrateMedia(obj, resolveUrl) {
  const swap = async (item) => {
    const url = await resolveUrl(item.url);
    return url ? { ...item, url } : null;
  };
  const media = (await Promise.all((obj.media || []).map(swap))).filter(Boolean);
  const body = (await Promise.all((obj.body || []).map((b) => (b.t === 'img' ? swap(b) : b)))).filter(Boolean);
  return { ...obj, body, media };
}

module.exports = { createMediaCache, downloadImage, sniffImage, hydrateMedia, httpsRequest, hashUrl, MAX_BYTES, DEFAULTS };
