// Shared helpers for the release scripts: validation of the rich changelog
// fields (highlight, notes, media, links, notice) and the URL rewriting that
// publishes repo-relative images from the immutable tag on GitHub.
//
// Used by release.mjs (validate before tagging), sync-feed.mjs (POST to the
// site) and release-notes.mjs (GitHub Release body). Pure apart from reading
// files under `root`, so it is tested directly (tests/changelog-lib.test.js).
// See changelog/README.md for how to write a release with these fields.

import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, posix } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isAllowedImageUrl } = require('../src/notice-model.js');

export const RAW_BASE = 'https://raw.githubusercontent.com/Raccoon254/spaci';
export const MEDIA_DIR = 'changelog/media/';
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_NOTES_BYTES = 200 * 1024;
// The site stores at most this many characters of notes and truncates the rest.
const MAX_NOTES_CHARS = 50000;
const SEVERITIES = ['info', 'update', 'important', 'critical'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function isHttps(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && Boolean(x.hostname) && !x.username && !x.password;
  } catch { return false; }
}
function isMailto(u) {
  try { return new URL(u).protocol === 'mailto:'; } catch { return false; }
}

/** First bytes -> png | jpeg | webp | gif | null (an SVG renamed to .png is null). */
export function sniffImageFile(file) {
  const buf = Buffer.alloc(12);
  let n = 0;
  const fd = openSync(file, 'r');
  try { n = readSync(fd, buf, 0, 12, 0); } finally { closeSync(fd); }
  if (n < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  const s6 = buf.subarray(0, 6).toString('latin1');
  if (s6 === 'GIF87a' || s6 === 'GIF89a') return 'gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

/**
 * A repo-relative path, normalised, or null when it escapes the repo or is
 * absolute on disk. `base` is the directory it is relative to (repo root = '').
 */
function repoPath(ref, base = '') {
  if (typeof ref !== 'string' || !ref || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//') || ref.includes('\\')) return null;
  const clean = ref.split('#')[0].split('?')[0];
  const joined = clean.startsWith('/') ? clean.slice(1) : posix.join(base, clean);
  const norm = posix.normalize(joined);
  if (!norm || norm.startsWith('..') || posix.isAbsolute(norm)) return null;
  return norm;
}

/** The public, immutable URL of a repo file at the release tag. */
export function rawUrl(rel, version) {
  return `${RAW_BASE}/v${version}/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

/** Check a local image under changelog/media/. Pushes errors; returns true when fine. */
function checkLocalImage(rel, root, where, errors) {
  if (!rel || !rel.startsWith(MEDIA_DIR)) {
    errors.push(`${where}: images must live under ${MEDIA_DIR} (got ${JSON.stringify(rel)}).`);
    return false;
  }
  const abs = join(root, rel);
  let st;
  try { st = statSync(abs); } catch {
    errors.push(`${where}: ${rel} does not exist.`);
    return false;
  }
  if (!st.isFile()) { errors.push(`${where}: ${rel} is not a file.`); return false; }
  if (!/\.(png|jpe?g|webp|gif)$/i.test(rel)) {
    errors.push(`${where}: ${rel} must be a .png, .jpg, .webp or .gif file (SVG is not allowed).`);
    return false;
  }
  if (st.size >= MAX_IMAGE_BYTES) {
    errors.push(`${where}: ${rel} is ${(st.size / 1048576).toFixed(1)} MB; images must be under 3 MB.`);
    return false;
  }
  if (!sniffImageFile(abs)) {
    errors.push(`${where}: ${rel} is not really a PNG, JPEG, WebP or GIF image (checked its bytes).`);
    return false;
  }
  return true;
}

// Markdown scanning. Fenced code blocks and inline code spans are skipped, so
// an example like `![x](y)` in a code block is neither validated nor rewritten.
const IMAGE_RE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const LINK_RE = /(^|[^!])\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const REF_RE = /^(\s{0,3}\[[^\]]+\]:\s*)<?(\S+?)>?(\s+"[^"]*")?\s*$/;

function mapMarkdown(md, onLine) {
  const lines = md.split('\n');
  let fence = null;
  return lines.map((line) => {
    const f = line.match(/^\s{0,3}(```+|~~~+)/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      return line;
    }
    if (fence) return line;
    // Leave inline code spans alone.
    return line.split(/(`+[^`]*`+)/).map((part, i) => (i % 2 ? part : onLine(part))).join('');
  }).join('\n');
}

/**
 * Validate a notes Markdown file's images and links. Returns the local image
 * paths it references (to stage with the release).
 */
function checkNotesMarkdown(md, notesRel, root, errors, warnings) {
  const base = posix.dirname(notesRel);
  const local = [];
  const where = notesRel;
  const checkImage = (alt, ref) => {
    if (/^https:\/\//i.test(ref)) {
      if (!isAllowedImageUrl(ref)) errors.push(`${where}: image ${ref} is not on the allowed hosts (spaci.kentom.co.ke, raw.githubusercontent.com/Raccoon254/, github.com/Raccoon254/ or /user-attachments/); the app would drop it.`);
    } else {
      const rel = repoPath(ref, base);
      if (checkLocalImage(rel, root, `${where}: image ${ref}`, errors)) local.push(rel);
    }
    if (!alt.trim()) errors.push(`${where}: image ${ref} needs alt text: ![what it shows](${ref}).`);
  };
  const checkLink = (ref) => {
    if (isHttps(ref) || isMailto(ref)) return;
    errors.push(`${where}: link ${ref} must be https: or mailto: (the app turns anything else into plain text).`);
  };
  mapMarkdown(md, (text) => {
    for (const m of text.matchAll(IMAGE_RE)) checkImage(m[1], m[2]);
    for (const m of text.matchAll(LINK_RE)) checkLink(m[3]);
    const r = text.match(REF_RE);
    if (r) {
      const ref = r[2];
      if (/^https:\/\//i.test(ref) || isMailto(ref)) checkLink(ref);
      else if (/\.(png|jpe?g|webp|gif|svg)$/i.test(ref)) checkImage('reference', ref);
      else checkLink(ref);
    }
    return text;
  });
  if (/<\s*[a-z][^>]*>/i.test(md.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, ''))) {
    warnings.push(`${where}: contains raw HTML, which is dropped when published. Use Markdown instead.`);
  }
  return local;
}

/** Rewrite repo-relative images in notes Markdown to raw URLs at the tag. */
export function rewriteNotesMarkdown(md, { version, notesPath }) {
  const base = posix.dirname(notesPath);
  const swap = (ref) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return ref;
    const rel = repoPath(ref, base);
    return rel ? rawUrl(rel, version) : ref;
  };
  return mapMarkdown(md, (text) => {
    let out = text.replace(IMAGE_RE, (all, _alt, ref) => {
      const i = all.indexOf('](') + 2; // alt cannot contain ']', so this is the target
      return all.slice(0, i) + all.slice(i).replace(ref, swap(ref));
    });
    const r = out.match(REF_RE);
    if (r && /\.(png|jpe?g|webp|gif)$/i.test(r[2])) out = `${r[1]}${swap(r[2])}${r[3] || ''}`;
    return out;
  });
}

/** A changelog media src -> the URL it is published at. */
export function mediaUrl(src, version) {
  if (/^https:\/\//i.test(src)) return src;
  const rel = repoPath(src);
  return rel ? rawUrl(rel, version) : null;
}

const allowedKeys = (obj, keys, where, errors) => {
  for (const k of Object.keys(obj)) if (!keys.includes(k)) errors.push(`${where}: unknown field "${k}" (allowed: ${keys.join(', ')}).`);
};

/**
 * Validate the rich fields of one changelog entry. Entries without them pass
 * untouched. Returns {errors, warnings, files} where files are the repo paths
 * (notes and local images) the release commit must include.
 */
export function validateEntry(entry, { root = '.' } = {}) {
  const errors = [];
  const warnings = [];
  const files = [];
  if (!isObj(entry)) return { errors: ['The changelog entry is not an object.'], warnings, files };

  if (entry.highlight !== undefined) {
    const h = entry.highlight;
    if (typeof h !== 'string' || !h.trim()) errors.push('highlight: must be a non-empty string.');
    else {
      if (h.length > 160) errors.push(`highlight: ${h.length} characters; the limit is 160.`);
      if (/[\r\n]/.test(h)) errors.push('highlight: must be one line.');
      if (/[<>]|\*\*|__|\]\(/.test(h)) warnings.push('highlight: is shown as plain text; Markdown and HTML will appear literally.');
    }
  }

  if (entry.notes !== undefined) {
    const rel = repoPath(entry.notes);
    if (typeof entry.notes !== 'string' || !rel || !rel.startsWith('changelog/') || !rel.endsWith('.md')) {
      errors.push(`notes: must be a Markdown file under changelog/, for example "changelog/${entry.version || 'x.y.z'}.md" (got ${JSON.stringify(entry.notes)}).`);
    } else {
      let md = null;
      try {
        const st = statSync(join(root, rel));
        if (!st.isFile()) errors.push(`notes: ${rel} is not a file.`);
        else if (st.size > MAX_NOTES_BYTES) errors.push(`notes: ${rel} is larger than 200 KB.`);
        else md = readFileSync(join(root, rel), 'utf8');
      } catch { errors.push(`notes: ${rel} does not exist.`); }
      if (md !== null && md.length > MAX_NOTES_CHARS) {
        errors.push(`notes: ${rel} has ${md.length} characters; the site keeps at most ${MAX_NOTES_CHARS}.`);
        md = null;
      }
      if (md !== null) {
        if (!md.trim()) errors.push(`notes: ${rel} is empty.`);
        files.push(rel);
        files.push(...checkNotesMarkdown(md, rel, root, errors, warnings));
      }
    }
  }

  if (entry.media !== undefined) {
    if (!Array.isArray(entry.media)) errors.push('media: must be an array of { src, alt, caption? }.');
    else {
      if (entry.media.length > 12) errors.push('media: at most 12 images.');
      entry.media.forEach((m, i) => {
        const where = `media[${i}]`;
        if (!isObj(m)) { errors.push(`${where}: must be an object { src, alt, caption? }.`); return; }
        allowedKeys(m, ['src', 'alt', 'caption'], where, errors);
        if (typeof m.alt !== 'string' || !m.alt.trim()) errors.push(`${where}: alt text is required (describe what the image shows).`);
        else if (m.alt.length > 300) errors.push(`${where}: alt text is over 300 characters.`);
        if (m.caption !== undefined && (typeof m.caption !== 'string' || m.caption.length > 300)) errors.push(`${where}: caption must be a string of at most 300 characters.`);
        if (typeof m.src !== 'string' || !m.src) { errors.push(`${where}: src is required.`); return; }
        if (/^[a-z][a-z0-9+.-]*:/i.test(m.src)) {
          if (!isAllowedImageUrl(m.src)) errors.push(`${where}: ${m.src} must be https on an allowed host (spaci.kentom.co.ke, raw.githubusercontent.com/Raccoon254/, github.com/Raccoon254/ or /user-attachments/), or a file under ${MEDIA_DIR}.`);
        } else {
          const rel = repoPath(m.src);
          if (checkLocalImage(rel, root, where, errors)) files.push(rel);
        }
      });
    }
  }

  if (entry.links !== undefined) {
    if (!Array.isArray(entry.links)) errors.push('links: must be an array of { label, url }.');
    else {
      if (entry.links.length > 20) errors.push('links: at most 20 links.');
      entry.links.forEach((l, i) => {
        const where = `links[${i}]`;
        if (!isObj(l)) { errors.push(`${where}: must be an object { label, url }.`); return; }
        allowedKeys(l, ['label', 'url'], where, errors);
        if (typeof l.label !== 'string' || !l.label.trim() || l.label.length > 80) errors.push(`${where}: label must be 1 to 80 characters.`);
        if (!isHttps(l.url)) errors.push(`${where}: url must be an https:// link (got ${JSON.stringify(l.url)}).`);
      });
    }
  }

  if (entry.notice !== undefined) {
    const n = entry.notice;
    const where = 'notice';
    if (!isObj(n)) errors.push('notice: must be an object { severity, title?, summary?, cta?, endsInDays? }.');
    else {
      allowedKeys(n, ['severity', 'title', 'summary', 'cta', 'endsInDays'], where, errors);
      if (!SEVERITIES.includes(n.severity)) errors.push(`notice.severity: must be one of ${SEVERITIES.join(', ')} (got ${JSON.stringify(n.severity)}).`);
      if (n.severity === 'critical') warnings.push('notice.severity is critical: users cannot dismiss it. Use it only for a real problem in older versions.');
      if (n.title !== undefined && (typeof n.title !== 'string' || !n.title.trim() || n.title.length > 80)) errors.push('notice.title: must be 1 to 80 characters.');
      if (n.summary !== undefined && (typeof n.summary !== 'string' || n.summary.length > 200)) errors.push('notice.summary: must be at most 200 characters of plain text.');
      if (n.cta !== undefined) {
        if (!isObj(n.cta)) errors.push('notice.cta: must be an object { label, url }.');
        else {
          allowedKeys(n.cta, ['label', 'url'], 'notice.cta', errors);
          if (typeof n.cta.label !== 'string' || !n.cta.label.trim() || n.cta.label.length > 80) errors.push('notice.cta.label: must be 1 to 80 characters.');
          if (!isHttps(n.cta.url)) errors.push(`notice.cta.url: must be an https:// link (got ${JSON.stringify(n.cta.url)}).`);
        }
      }
      if (n.endsInDays !== undefined && !(Number.isInteger(n.endsInDays) && n.endsInDays >= 1 && n.endsInDays <= 365)) {
        errors.push('notice.endsInDays: must be a whole number of days from 1 to 365.');
      }
      if (n.title === undefined && !entry.highlight && !entry.summary) errors.push('notice: needs a title, or a highlight or summary to fall back on.');
    }
  }

  return { errors, warnings, files: [...new Set(files)] };
}

/**
 * The rich fields for POST /api/releases. Only fields present in the entry
 * are returned, so an old entry produces exactly the old payload.
 */
export function releaseExtras(entry, { root = '.' } = {}) {
  const out = {};
  const version = entry.version;
  if (typeof entry.highlight === 'string' && entry.highlight) out.highlight = entry.highlight;
  if (typeof entry.notes === 'string' && entry.notes) {
    const rel = repoPath(entry.notes);
    const md = readFileSync(join(root, rel), 'utf8');
    out.notes = rewriteNotesMarkdown(md, { version, notesPath: rel });
  }
  if (Array.isArray(entry.media)) {
    out.media = entry.media.map((m) => {
      const url = mediaUrl(m.src, version);
      const item = { src: url, url, alt: m.alt };
      if (m.caption) item.caption = m.caption;
      return item;
    });
  }
  if (Array.isArray(entry.links)) out.links = entry.links.map((l) => ({ label: l.label, url: l.url }));
  if (isObj(entry.notice)) out.notice = entry.notice;
  return out;
}

/** Lines for the top of the GitHub Release body (highlight, then the notes). */
export function releaseBodyTop(entry, { root = '.' } = {}) {
  const out = [];
  if (typeof entry.highlight === 'string' && entry.highlight) out.push(`**${entry.highlight}**`, '');
  if (typeof entry.notes === 'string' && entry.notes) {
    const rel = repoPath(entry.notes);
    const md = readFileSync(join(root, rel), 'utf8');
    out.push(rewriteNotesMarkdown(md, { version: entry.version, notesPath: rel }).trim(), '');
  }
  return out;
}
