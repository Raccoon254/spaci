# Releasing Spaci

Releases are automated. You write the changelog, run one command, and CI does the
rest: build for macOS, Windows and Linux, publish the installers to GitHub
Releases, and push the release (with real sha512 hashes and your notes) to
https://spaci.kentom.co.ke so the changelog and auto-update feed update live.

## One-time setup

In the GitHub repo settings (Settings, Secrets and variables, Actions) add:

- `RELEASE_PUBLISH_SECRET`: must match the value set on the spaci-web Vercel
  project. CI uses it to POST the release to `/api/releases`.

`GITHUB_TOKEN` is provided automatically and is used to upload the installers.

## Cutting a release

1. Add a new entry to the TOP of `changelog.json`:

   ```json
   {
     "version": "1.3.0",
     "date": "2026-07-01",
     "tag": "Latest",
     "major": false,
     "summary": "One line on what this release is about.",
     "added": ["New thing", "Another new thing"],
     "improved": ["Something nicer"],
     "fixed": ["A bug squashed"]
   }
   ```

   Do not add a `files` array, the build fills in sha512 and sizes.

2. Run:

   ```bash
   make release      # or: npm run release
   ```

   This syncs `package.json` to the version, commits, tags `v1.3.0` and pushes.

3. The tag triggers `.github/workflows/release.yml`, which:
   - builds and packages the app on macOS, Windows and Linux,
   - uploads the installers, blockmaps and `latest*.yml` to the GitHub Release,
   - reads the real sha512 from electron-builder's output and POSTs the release
     to the website, so the changelog and update feed go live,
   - writes the GitHub Release title and description from the same changelog entry.

   The tag also triggers `test.yml`, so the suite runs against exactly what ships.

That is it. Installed copies of Spaci pick up the update on their next check
(within six hours, or immediately via Check for updates on the About screen).

## Release candidates

Test a release on real machines before users get it:

1. Write the changelog entry for the final version (`"version": "2.3.0"`), as
   above.
2. Run:

   ```bash
   npm run release -- --rc      # or: node scripts/release.mjs --rc
   ```

   This picks the next candidate number from the existing tags
   (`v2.3.0-rc.1`, then `rc.2`, ...), sets `package.json` (and the lockfile's
   copy) to that version, commits `Release v2.3.0-rc.N`, tags and pushes. The
   changelog entry stays `2.3.0`. `node scripts/release.mjs --check --rc`
   shows which version it would tag without changing anything.
3. `release.yml` builds and uploads it like any release, but because the tag
   has a suffix it is a GitHub **prerelease**, and the `sync-feed` job does not
   run: the website, its changelog and the auto-update feed never see it, so no
   installed copy updates to a candidate.
4. Download the installers from the prerelease and test. To launch one without
   counting it as a user, start it with `SPACI_TELEMETRY=0` in the environment.
   An RC build's What's new falls back to the final version's changelog entry.
5. Fix, then cut `rc.2` the same way. When a candidate is good, run
   `npm run release` (no flag) to tag the final `v2.3.0` from the same entry.

A top entry versioned `X.Y.Z-rc.N` is also accepted and released as is, but
`--rc` is preferred: it keeps the changelog describing the real release.
`release.mjs` refuses a candidate of a version that is already released.

## Dependencies in CI

Every workflow installs with `npm ci`, so CI builds exactly the committed
`package-lock.json`. The lockfile carries the other platforms' optional
packages (for example `dmg-license`, macOS only); `npm ci --os=linux --cpu=x64`
and `--os=win32` with npm 10.8.2 (the npm of Node 20) install from it without
errors. After changing dependencies, commit the updated lockfile; `npm ci`
fails when `package.json` and the lockfile disagree.

## Where the changelog goes

`changelog.json` is the only place release notes are written. Every other surface
is generated from it, so they cannot tell different stories:

| Surface | How it gets there |
| --- | --- |
| GitHub Release description | `scripts/release-notes.mjs`, in the `sync-feed` job |
| Website changelog and download page | `scripts/sync-feed.mjs` POSTs to `/api/releases`, stored in Neon |
| Update feed (`/updates/latest-*.yml`) | Generated from the same database row |
| Site fallback (`spaci-web/src/lib/releases.ts`) | Updated when a release is cut, enforced by `npm run check:releases` there |

Artifact names, byte sizes and sha512 values always come from electron-builder's
`latest*.yml`, never typed by hand.

An entry can also carry a custom highlight, a Markdown notes file with images,
links and an in-app notice for users on older versions. See
[changelog/README.md](changelog/README.md). Check an entry without releasing:

```bash
node scripts/release.mjs --check
```

Preview the release description before tagging:

```bash
node scripts/release-notes.mjs                  # newest changelog entry
node scripts/release-notes.mjs --version 2.0.1  # a specific release
```

## Notes

- macOS auto-update installs require a signed and notarized build. The check and
  download work unsigned, but `quitAndInstall` on an unsigned mac build is blocked
  by Gatekeeper. Add signing certs as CI secrets when you are ready to ship signed.
- The website reads releases from its database first and falls back to the static
  `releases.ts` baseline, so the site never breaks if the database is unavailable.
