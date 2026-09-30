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

// SPACI_TELEMETRY=0 (or false/off/no) turns the ping off for that process,
// whatever the prefs say: CI smoke launches and other automated runs are not
// users and must never be counted. No install ID is created either.
const OFF_VALUES = new Set(['0', 'false', 'off', 'no']);
function disabledByEnv(env = process.env) {
  const v = env && env.SPACI_TELEMETRY;
  return typeof v === 'string' && OFF_VALUES.has(v.trim().toLowerCase());
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
  endpoint = DEFAULT_ENDPOINT,
  env = process.env
} = {}) {
  let timer;
  try {
    if (disabledByEnv(env)) return false;
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

module.exports = { maybePing, mapPlatform, disabledByEnv, DEFAULT_ENDPOINT };
