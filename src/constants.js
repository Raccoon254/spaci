'use strict';
/**
 * Shared constants with no dependencies. Kept apart so a module that only
 * needs a table (the cleaner in the main process) never loads a scan module
 * (scanner.js pulls in languages.js and docker.js, whose work belongs in the
 * scan worker).
 */

/** OS bookkeeping files the cleaner never deletes, wherever they appear. */
const SKIP_DELETE = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.localized']);

module.exports = { SKIP_DELETE };
