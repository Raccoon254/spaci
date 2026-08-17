# Spaci 2.0

A complete **dev + Mac cleaner** desktop app (Electron). Reclaim disk space from
regenerable build artifacts and developer/system caches — with live previews,
smart recommendations and a polished UI. This is an Electron rewrite of the
original JavaFX *Spaci*, expanded with a system/Mac cleaner, previews and
recommendations.

## Features

**Projects (dev cleaner)**
- Scans any folder for projects (Node, Maven, Gradle, Android, Python, Rust, Go, Flutter, Composer, .NET, Xcode).
- Finds regenerable artifacts: `node_modules`, `target`, `build`, `dist`, `.next`, `.nuxt`, `.turbo`, `.gradle`, `__pycache__`, `.pytest_cache`, `vendor`, `Pods`, `DerivedData`, `coverage`, and more.
- Per-project details with per-item selection, sizes, safety badges, git branch and "reveal in Finder".
- Filter, and sort by size / name / recent.

**Mac Cleaner (system)**
- Measures developer caches (npm, Yarn, pnpm, Bun, Gradle, Maven, Cargo, CocoaPods, pip, Go, Deno),
  Xcode (DerivedData, Archives, DeviceSupport, Simulator caches),
  system (user caches, logs, Trash, saved app state) and browser caches.
- Everything listed is regenerable; nothing user-created is ever targeted.

**Docker**
- Detects whether Docker is installed and whether the daemon is up, on every platform, without assuming the CLI is on `PATH` (a Finder-launched app inherits almost none of it).
- Measures what the engine is holding: images, containers, volumes and build cache, using Docker's own de-duplicated totals.
- Marks every scanned project that uses Docker (Dockerfile, compose file, `.dockerignore`, devcontainer) and lists its compose services.
- Attributes real engine storage back to the project on disk, matched through the working directory compose stamps on each container it starts, not guessed from folder names.
- Offers only regenerable reclaims: build cache and untagged image layers. **Volumes are never pruned**: they hold databases and uploads.
- A machine without Docker scans exactly as before; nothing here can fail the scan.

**Recommendations**
- Surfaces the biggest, safest wins — oversized caches, stale projects (not modified in *N* days), and Docker build cache or unused images.

**Safe by design**
- Preview every deletion before it happens; `.DS_Store` and similar are always skipped; symlinks are never followed out of a target.
- Docker is reclaimed by the daemon through an allowlist of prune commands. Spaci never deletes Docker's own files.

## Scan performance

The project walk runs as a bounded worker pool over a queue (siblings in
parallel), sizes artifacts with `du` instead of per-file `stat`, and skips `.git`
while hunting for artifacts. On a home folder with 255 projects that took a
147 s scan down to about 12 s, with the same projects found:

```bash
npm run bench -- ~/projects
npm run bench -- ~/projects --compare /path/to/older/scanner.js
```

`du` reports blocks actually occupied, so a hardlinked `node_modules` is now
counted once rather than once per link.

## Run

```bash
npm install
npm start
```

Build installers: `npm run dist` (uses electron-builder).

## Architecture

| File | Role |
|---|---|
| `src/main.js` | Electron main process + IPC handlers + disk/recommendations |
| `src/preload.js` | Secure `window.api` bridge (contextIsolation) |
| `src/scanner.js` | Project detection + cleanable-artifact discovery + sizing + git |
| `src/docker.js` | Docker presence, engine storage, per-project attribution, prune allowlist |
| `src/system.js` | Catalog of safe cache locations + live `du` sizing |
| `src/cleaner.js` | Safe deletion engine (skips system files, reports freed bytes) |
| `src/renderer/*` | UI: shell, design system, and the app logic |
| `assets/icons/*` | iconsax two-tone icons, converted to `currentColor` |

Icons are [iconsax](https://iconsax.io) two-tone, recolored to `currentColor` so
they inherit theme colors and keep their duotone opacity.
