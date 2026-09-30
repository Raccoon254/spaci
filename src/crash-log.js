'use strict';
/**
 * The main process log: uncaught exceptions, unhandled rejections, renderer and
 * child process crashes, and startup failures, appended to main.log in the
 * app's logs folder. When the file would pass maxBytes it is renamed to
 * main.log.1 (replacing the previous one) and a new file is started, so the log
 * never holds more than about twice maxBytes on disk.
 *
 * Writing a log line must never be the thing that crashes Spaci: every write
 * swallows its own errors. fs and the clock are injectable for tests.
 */
const nodeFs = require('fs');
const path = require('path');

const MAX_BYTES = 1024 * 1024;
const MAX_ENTRY_CHARS = 16 * 1024;

/** Readable text for anything thrown or rejected, including non-Error values. */
function describeError(err) {
  if (err instanceof Error) return err.stack || `${err.name}: ${err.message}`;
  if (err && typeof err === 'object') {
    try { return JSON.stringify(err); } catch (_) { return Object.prototype.toString.call(err); }
  }
  return String(err);
}

/** One entry: ISO time, level, message; continuation lines indented. Capped in length. */
function formatEntry(date, level, message) {
  let text = String(message == null ? '' : message);
  if (text.length > MAX_ENTRY_CHARS) text = text.slice(0, MAX_ENTRY_CHARS) + ` [truncated ${text.length - MAX_ENTRY_CHARS} chars]`;
  const [first, ...rest] = text.split(/\r?\n/);
  return `${date.toISOString()} [${level}] ${first}${rest.map((l) => '\n    ' + l).join('')}\n`;
}

/** Should the file be rotated before appending `incoming` bytes? */
function needsRotation(currentBytes, incomingBytes, maxBytes = MAX_BYTES) {
  return currentBytes > 0 && currentBytes + incomingBytes > maxBytes;
}

/**
 * @param {object} o
 * @param {string} o.file  absolute path of main.log
 * @param {number} [o.maxBytes]
 * @param {object} [o.fs]
 * @param {() => Date} [o.now]
 */
function createCrashLog({ file, maxBytes = MAX_BYTES, fs = nodeFs, now = () => new Date() } = {}) {
  let dirReady = false;
  function write(level, message) {
    if (!file) return false;
    try {
      const entry = formatEntry(now(), level, message);
      const bytes = Buffer.byteLength(entry);
      if (!dirReady) { fs.mkdirSync(path.dirname(file), { recursive: true }); dirReady = true; }
      let size = 0;
      try { size = fs.statSync(file).size; } catch (_) { size = 0; }
      if (needsRotation(size, bytes, maxBytes)) {
        try { fs.renameSync(file, file + '.1'); } catch (_) { /* keep appending to the old file */ }
      }
      fs.appendFileSync(file, entry);
      return true;
    } catch (_) {
      return false;
    }
  }
  return {
    file,
    info: (msg) => write('info', msg),
    warn: (msg) => write('warn', msg),
    error: (msg, err) => write('error', err === undefined ? msg : `${msg}: ${describeError(err)}`),
  };
}

module.exports = { MAX_BYTES, describeError, formatEntry, needsRotation, createCrashLog };
