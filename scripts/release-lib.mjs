// Version rules for scripts/release.mjs, kept pure so node --test covers them.
//
// A release version is X.Y.Z. A release candidate is X.Y.Z-rc.N (N >= 1): it
// builds and publishes like a release, but release.yml marks it a GitHub
// prerelease and never syncs it to the website or the update feed.

export const RELEASE_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.([1-9]\d*))?$/;

/** '2.3.0-rc.2' -> { base: '2.3.0', rc: 2 }; '2.3.0' -> { base, rc: null }; anything else -> null. */
export function parseReleaseVersion(v) {
  const m = typeof v === 'string' ? v.match(RELEASE_RE) : null;
  if (!m) return null;
  return { base: `${m[1]}.${m[2]}.${m[3]}`, rc: m[4] ? Number(m[4]) : null };
}

export function isPrerelease(v) {
  const p = parseReleaseVersion(v);
  return Boolean(p && p.rc !== null);
}

/** The next candidate for `base`, given the existing git tags: v2.3.0-rc.1 and rc.2 exist -> 2.3.0-rc.3. */
export function nextRcVersion(base, tags = []) {
  let max = 0;
  for (const t of tags) {
    const p = parseReleaseVersion(String(t).replace(/^v/, ''));
    if (p && p.base === base && p.rc !== null && p.rc > max) max = p.rc;
  }
  return `${base}-rc.${max + 1}`;
}

/**
 * Which version to release.
 *   entryVersion  the top changelog.json entry's version
 *   rc            true for `release.mjs --rc`: the next candidate of that version
 *   tags          existing git tags
 * @returns {{ version: string, prerelease: boolean } | { error: string }}
 */
export function resolveReleaseVersion({ entryVersion, rc = false, tags = [] }) {
  const parsed = parseReleaseVersion(entryVersion);
  if (!parsed) {
    return { error: `The top changelog entry has an invalid version: ${JSON.stringify(entryVersion)}. Use X.Y.Z (or X.Y.Z-rc.N).` };
  }
  const released = tags.map(String).includes(`v${parsed.base}`);
  if (rc) {
    if (parsed.rc !== null) return { error: `--rc picks the candidate number itself: set the changelog entry to ${parsed.base}, not ${entryVersion}.` };
    if (released) return { error: `v${parsed.base} is already released, so there is nothing to make a candidate of. Add a new changelog entry.` };
    return { version: nextRcVersion(parsed.base, tags), prerelease: true };
  }
  if (parsed.rc !== null && released) return { error: `v${parsed.base} is already released; a candidate for it makes no sense.` };
  return { version: entryVersion, prerelease: parsed.rc !== null };
}
