# Native cleanup: sources

Spaci cleans some developer caches with the tool's own command instead of
deleting the folder. This file records what each command does and why Spaci
uses it. The allowlist itself is `src/native-cleanup-specs.js`, and
`src/native-cleanup.js` runs it in the scan worker.

These rules apply to every tool:

- **Busy check first.** Spaci refuses straight away, without waiting, when:
  - a process of the tool is running and uses the cache (checked with
    `ps -axo pid=,args=`, or `Get-CimInstance Win32_Process` on Windows);
  - another process holds the tool's cache lock file open (checked with
    `lsof -t`, on macOS and Linux);
  - the tool's output says it is waiting for a lock. Spaci stops the command
    at once.

  If Spaci cannot read the process list, it refuses (fails closed). The
  message reads: "uv is busy (another uv process is running). Try again when
  it finishes."
- **No lock-bypass flags.** `validateArgs` rejects `--force`, `-f`,
  `--no-lock` and `--ignore-lock`, and every argument must be a plain constant
  (`SAFE_ARG`). The renderer sends only paths. Main maps a path to a target id
  through its own target index. The worker builds the command from the spec
  for that id.
- **Freed space is measured.** Spaci measures the tool's cache folders before
  and after the command (allocated bytes, using one `du -skx` so hard links
  count once, or a bounded walk on Windows). The figure comes from that
  measurement, never from what the tool reports.
- **Every run is bounded.** Each command has a timeout, streams its output as
  `clean:progress` events, and stops on cancel (`scan:cancel('clean')`). The
  History v2 item records the command, its exit status and the restore hint.
- **Missing CLI.** When the tool is not installed, Spaci falls back to the old
  folder delete. It does this only after the busy check has passed, so no
  process of the tool can be using the folder.

## Command table

| Target id | Manual clean | Auto-clean (tier A only) | Preview (read-only) | Busy when | Timeout | CLI missing |
|---|---|---|---|---|---|---|
| `pnpm` | `pnpm store prune` | `pnpm store prune` | `pnpm store path`, then the bytes of store files with one link (no project uses them) | `pnpm` or `pnpx` running install, add, update, fetch, store, dlx and similar; `index.db` open | 15 min | folder delete |
| `uv-cache` | `uv cache clean` (never `--force`) | `uv cache prune` | `uv cache dir`, then du | any `uv` or `uvx` process (`uv run` holds the lock); `.lock` open; output "currently in-use / waiting for other uv processes" | 10 min | folder delete |
| `go` | `go clean -cache` | `go clean -cache` | `go env GOCACHE`, then du | `go build/test/install/get/mod/generate/vet/list/clean/work/tool` (not `go run`, not `gopls`) | 10 min | folder delete |
| `go-modcache` (Review) | `go clean -modcache` | never (tier B) | `go env GOMODCACHE`, then du | as `go` | 15 min | folder delete (the cleaner handles read-only files) |
| `gradle` | `gradle --stop`, then empty `~/.gradle/caches` | never (stopping daemons unattended is disruptive) | du | a Gradle client (`GradleMain`, `GradleWrapperMain`, `gradle`, `gradlew`); a daemon still running after `--stop` (another Gradle version) | 2 min for the stop | folder delete, only when no daemon runs |
| `pip` | `pip cache purge` (pip3, then pip) | `pip cache purge` | `pip cache dir`, then du | `pip install/download/wheel/cache`, including `python -m pip` | 5 min | folder delete |
| `yarn` | Yarn 1: `yarn cache clean`. Yarn 2+: folder delete (berry only cleans inside a project) | same | `yarn cache dir`, then du | `yarn` running install, add, upgrade, cache and similar | 10 min | folder delete |
| `cocoapods` | `pod cache clean --all` | `pod cache clean --all` | du | `pod` running | 5 min | folder delete |
| `homebrew-cache` | `brew cleanup --prune=all` | never (it also removes old formula versions) | `brew cleanup --prune=all --dry-run`, parsing "would free approximately ..." | any `brew` process; output "has already locked" | 15 min | folder delete |
| `npm` | folder delete (no better command) | staged folder, as before | du | `npm` or `npx` running install, ci, exec, cache and similar | n/a | n/a |
| `cargo` | folder delete (no stable command) | staged folder, as before | du | `cargo` running | n/a | n/a |
| Docker build cache | `docker builder prune` (already in `src/docker.js`) | never | `docker system df` | n/a | n/a | n/a |

## When to prefer the native command, per tool

### pnpm: `pnpm store prune`
- Source: https://pnpm.io/cli/store. It "removes unreferenced packages from the
  store", meaning packages that no project on the system uses. `store path`
  returns the active store directory. `store status` only checks for modified
  packages and does not estimate the size.
- Why it is preferred: projects hard-link the files they use from the store.
  Deleting the folder frees almost nothing for those files and forces a fresh
  download on the next install. Prune removes only the unused packages.
- Preview: pnpm has no dry run. Spaci adds up the files under the store's
  `files/` folder that have one link, meaning no project links to them. This
  is an estimate. It can read low when a global virtual store also links the
  files.
- Duration: seconds to a few minutes.

### npm: folder delete
- Source: https://docs.npmjs.com/cli/v10/commands/npm-cache. `npm cache clean`
  deletes all data from the cache folder and "requires `--force`". The docs
  call it "typically unnecessary, as npm's cache is self-healing".
  `npm cache verify` only garbage-collects.
- Why Spaci keeps the folder delete: the command deletes the same `_cacache`
  folder, and it only runs with `--force`, which Spaci never passes. npm has
  no cache lock to respect. The busy check (an `npm install` or `npm exec`
  running) still applies.

### Yarn: `yarn cache clean` (Yarn 1)
- Yarn 1: https://classic.yarnpkg.com/en/docs/cli/cache. `yarn cache clean`
  clears the global cache, and `yarn cache dir` prints where it is.
- Yarn 2+: https://yarnpkg.com/cli/cache/clean. `--mirror` removes the global
  cache and `--all` removes both global and local. The command works on "the
  current project", so it is not run from the home folder. Spaci empties the
  global folder instead and says so in History.

### uv: `uv cache clean` / `uv cache prune`
- Source: https://docs.astral.sh/uv/concepts/cache/ (sections "Clearing the
  cache" and "Cache safety"):
  - `uv cache clean` removes all entries.
  - `uv cache prune` removes unused entries.
  - uv "blocks cache-modifying operations while other uv commands are
    running", with a 5-minute timeout.
  - `--force` ignores the lock.
- CLI help (`uv cache --help`, uv 0.12) lists `clean`, `prune`, `dir` and
  `size`. Neither `clean` nor `prune` has a dry run.
- The lock message was taken from the uv binary: "Cache is currently in-use,
  waiting for other uv processes to finish (use `--force` to override)".
  Spaci stops the command when it sees this message, instead of waiting 300 s.
  That 300 s wait is what happened on the owner's Mac.

### Go: `go clean -cache` / `go clean -modcache`
- Source: https://pkg.go.dev/cmd/go#hdr-Remove_object_files_and_cached_files.
  `-cache` removes the entire build cache. `-modcache` removes the entire
  module download cache. `-n` only prints what it would do.
- Source: https://go.dev/ref/mod#module-cache. Go creates module files
  read-only, so `go clean -modcache` is the supported way to remove them.
- Source: https://pkg.go.dev/cmd/go#hdr-Print_Go_environment_information.
  `go env GOCACHE GOMODCACHE` prints the locations.
- The module cache is its own Review target (`go-modcache`). Every project
  fetches it again, so it is never in Clean all or auto-clean.

### Gradle: `gradle --stop`, then the folder
- Source: https://docs.gradle.org/current/userguide/gradle_daemon.html.
  `--stop` terminates daemons "started with the same version of Gradle".
- Source: https://docs.gradle.org/current/userguide/directory_layout.html.
  Gradle cleans `~/.gradle/caches` automatically. Gradle documents no command
  that empties the caches.
- Because `--stop` only stops daemons of its own version, Spaci takes a new
  process snapshot after the stop. If a daemon from another version is still
  running, Spaci refuses and does not delete under it.
- `--stop` would also kill a daemon that is running a build. So right before
  it, Spaci runs `gradle --status` (read-only; it lists the daemons of this
  Gradle version as `PID STATUS INFO` rows, or says "No Gradle daemons are
  running.") and refuses unless every daemon is `IDLE` or `STOPPED`. `BUSY`,
  `CANCELED`, `STOPPING`, an unknown status, a non-zero exit or output it
  cannot read all refuse. Source:
  https://docs.gradle.org/current/userguide/gradle_daemon.html#sec:status.

### pip: `pip cache purge`
- Source: https://pip.pypa.io/en/stable/cli/pip_cache/. `purge` removes all
  items from the cache. `dir` shows the cache directory and `info` shows its
  size. There is no dry run.
- On macOS, Spaci never uses the `/usr/bin/pip3` stub. Without the command
  line tools installed, that stub opens an install dialog.

### Cargo: folder delete
- Source: https://doc.rust-lang.org/cargo/guide/cargo-home.html. Cargo will
  "do its best to restore sources" when any part of the cache is removed. The
  `cargo-cache` crate is a third-party tool.
- Source: https://doc.rust-lang.org/cargo/reference/unstable.html#gc.
  `cargo clean gc` is unstable (`-Zgc`).
- So Spaci keeps deleting `registry/cache` and `registry/src`, refusing while
  `cargo` runs.

### CocoaPods: `pod cache clean --all`
- Source: https://guides.cocoapods.org/terminal/commands.html#pod_cache_clean.
  `--all` removes every cached pod "without asking".

### Homebrew: `brew cleanup --prune=all`
- Source: https://docs.brew.sh/Manpage.
  - `cleanup` removes outdated downloads and old versions "for all formulae
    and casks".
  - `--prune=all` removes all cache files.
  - `-n` / `--dry-run` shows what would be removed.
  - `brew --cache` prints the cache path.
- Pinned and linked versions are kept. The source is
  https://github.com/Homebrew/brew/blob/master/Library/Homebrew/formula.rb
  (`eligible_kegs_for_cleanup` skips "due to it being pinned" and "due to it
  being linked").
- The dry-run total line comes from
  https://github.com/Homebrew/brew/blob/master/Library/Homebrew/cmd/cleanup.rb
  ("This operation would free approximately ... of disk space").
- The lock message comes from `Library/Homebrew/exceptions.rb` ("A `brew ...`
  process has already locked ...").
- Old versions are removed from the Cellar and Caskroom as well as the cache,
  so Spaci measures those folders too.
- `brew cleanup` also runs `brew autoremove`, which uninstalls formulae that
  were installed as dependencies and are no longer needed, unless
  `HOMEBREW_NO_AUTOREMOVE` is set (`Library/Homebrew/cleanup.rb`,
  `autoremove` call guarded by `EnvConfig.no_autoremove?`;
  `Library/Homebrew/env_config.rb`, `HOMEBREW_NO_AUTOREMOVE`). Uninstalling
  formulae is not cleaning a cache, so Spaci always sets it, for the dry run
  and the run.
- Belt and braces: right before the run Spaci repeats the dry run, and if it
  prints "Would autoremove" anyway (a Homebrew that ignores the variable), the
  run is refused and the row says why.
- Spaci runs it with `HOMEBREW_NO_AUTOREMOVE=1`, `HOMEBREW_NO_AUTO_UPDATE=1`,
  `HOMEBREW_NO_INSTALL_CLEANUP=1`, `HOMEBREW_NO_ENV_HINTS=1` and
  `HOMEBREW_NO_ANALYTICS=1`.

### Docker: `docker builder prune`
- Source: https://docs.docker.com/reference/cli/docker/builder/prune/.
  `-f` only skips the confirmation prompt, so it is not a lock bypass. The
  Docker card already uses this command (`src/docker.js`). It is listed here
  for completeness.

## Stopping part way (atomic and non-atomic commands)

Each spec says whether stopping its command part way leaves a cache the tool
still reads correctly (`atomic`, `atomicAuto` in `src/native-cleanup-specs.js`).

| Command | Atomic | Why |
|---|---|---|
| `pnpm store prune` | yes | removes only files no project links to; pnpm verifies the store (`verify-store-integrity`) and refetches a missing file |
| `go clean -cache` | yes | each build cache entry is checked by size and hash; a missing output is a cache miss (https://pkg.go.dev/cmd/go#hdr-Build_and_test_caching) |
| `pip cache purge` | yes | independent wheel and HTTP files |
| `gradle --stop` | yes | only stops daemons |
| `brew cleanup --prune=all` | yes | old kegs it removes are not linked; downloads are single files |
| `go clean -modcache` | no | the go command treats an extracted module folder that exists as complete, so a half removed one breaks builds until it is cleaned again (https://go.dev/ref/mod#module-cache) |
| `uv cache clean`, `uv cache prune` | no | unpacked archives are linked into environments as a whole folder; a half removed one installs broken packages |
| `yarn cache clean` (Yarn 1) | no | a package folder keeps `.yarn-metadata.json` while its files go, and Yarn 1 trusts the folder |
| `pod cache clean --all` | no | a half removed pod folder is still used by `pod install` |

For a non-atomic command Spaci:

- never offers or honours cancel once it started, and never kills it on a
  timeout. After 20 minutes it only says it is still running and keeps
  waiting (main waits up to 4 hours for the worker);
- if the command is stopped anyway (killed from outside, the app quit or
  crashed, or it exits non-zero), reports "Incomplete: run the clean again
  before building." and records that in History;
- remembers the unfinished clean (`native-incomplete.json` in the app data
  folder) until a clean of that target finishes, and shows the same warning
  with a "Finish cleaning" button on the row once the tool is idle.

## Finding the CLI

A Finder-launched app gets a minimal PATH. Besides PATH, Spaci looks in:

- macOS: `/opt/homebrew/bin`, `~/Library/pnpm`, `~/.local/bin`,
  `~/.cargo/bin`, `~/go/bin`, `~/.volta/bin`, `~/.bun/bin`,
  `/usr/local/go/bin`, `/usr/local/bin`.
- Linux: the same, plus the Linuxbrew folders.
- Windows: `%APPDATA%\npm`, `%LOCALAPPDATA%\pnpm`, `Program Files\Go\bin`.
- Version managers, so a CLI installed under one is found too: `PNPM_HOME`;
  nvm (`NVM_BIN`, every `$NVM_DIR/versions/node/*/bin`, newest first); fnm's
  default alias; volta; asdf and mise shims; pyenv shims; pipx
  (`PIPX_BIN_DIR`, else `~/.local/bin`). On Windows: nvm-windows
  (`NVM_SYMLINK`), fnm, Volta, mise and pyenv-win shims.
- Only tool folders. Relative PATH entries (`.`, `node_modules/.bin`) are
  dropped, and an env override that is a root or the home folder is ignored,
  so no project folder ever ends up on the child's PATH.

The child process gets the CLI's own folder first on PATH, so node-script
CLIs such as pnpm can find `node`. Windows `.cmd` shims run through the shell
because Node requires that. Their arguments are validated constants.
