'use strict';
// Entry point of Spaci's scan worker, started by src/main.js with Electron's
// utilityProcess.fork (plain Node, no Electron APIs). Every disk walk and every
// git/du/docker spawn of a scan happens in this process; see scan-worker-ops.js
// for the protocol and the operations.
require('./scan-worker-ops').startWorker();
