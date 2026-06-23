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

**Recommendations**
- Surfaces the biggest, safest wins — oversized caches and stale projects (not modified in *N* days).

**Safe by design**
- Preview every deletion before it happens; `.DS_Store` and similar are always skipped; symlinks are never followed out of a target.

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
| `src/system.js` | Catalog of safe cache locations + live `du` sizing |
| `src/cleaner.js` | Safe deletion engine (skips system files, reports freed bytes) |
| `src/renderer/*` | UI: shell, design system, and the app logic |
| `assets/icons/*` | iconsax two-tone icons, converted to `currentColor` |

Icons are [iconsax](https://iconsax.io) two-tone, recolored to `currentColor` so
they inherit theme colors and keep their duotone opacity.
