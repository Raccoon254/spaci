'use strict';

// Privacy-respecting daily ping. Sends one anonymous heartbeat per calendar
// day: a random install ID, app version, platform and arch. Nothing else.
// Pure module: every dependency is injected so it can be tested offline.

const crypto = require('crypto');

const DEFAULT_ENDPOINT = 'https://spaci.kentom.co.ke/api/ping';
const TIMEOUT_MS = 5000;

const PLATFORMS = { darwin: 'mac', win32: 'windows', linux: 'linux' };

function mapPlatform(p) {
  return PLATFORMS[p] || String(p);
}

// UTC calendar day, YYYY-MM-DD, matching how the server buckets days.
function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

async function maybePing({
  prefs,
  savePrefs,
  version,
  platform = process.platform,
  arch = process.arch,
  fetchImpl = typeof fetch === 'function' ? fetch : null,
  now = () => new Date(),
  endpoint = DEFAULT_ENDPOINT
} = {}) {
  let timer;
  try {
    if (!prefs || prefs.telemetry === false) return false;
    if (typeof fetchImpl !== 'function') return false;

    const today = dayKey(now());
    if (prefs.lastPingDate === today) return false;

    if (!prefs.installId) {
      prefs.installId = crypto.randomUUID();
      // If the ID cannot be persisted, do not send: it would be regenerated
      // next launch and inflate the install count.
      await savePrefs(prefs);
    }

    const payload = {
      installId: prefs.installId,
      version: String(version),
      platform: mapPlatform(platform),
      arch: String(arch)
    };

    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!res || !(res.ok || res.status === 204)) return false;

    prefs.lastPingDate = today;
    await savePrefs(prefs);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = { maybePing, mapPlatform, DEFAULT_ENDPOINT };
