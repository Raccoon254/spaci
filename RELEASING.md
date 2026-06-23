# Releasing Spaci

Releases are automated. You write the changelog, run one command, and CI does the
rest: build for macOS, Windows and Linux, publish the installers to GitHub
Releases, and push the release (with real sha512 hashes and your notes) to
https://spaci.kentom.co.ke so the changelog and auto-update feed update live.

## One-time setup

In the GitHub repo settings (Settings, Secrets and variables, Actions) add:

- `RELEASE_PUBLISH_SECRET` — must match the value set on the spaci-web Vercel
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
     to the website, so the changelog and update feed go live.

That is it. Installed copies of Spaci pick up the update on their next check
(within six hours, or immediately via Check for updates on the About screen).

## Notes

- macOS auto-update installs require a signed and notarized build. The check and
  download work unsigned, but `quitAndInstall` on an unsigned mac build is blocked
  by Gatekeeper. Add signing certs as CI secrets when you are ready to ship signed.
- The website reads releases from its database first and falls back to the static
  `releases.ts` baseline, so the site never breaks if the database is unavailable.
