# Local AI models and developer tools: sources

What Spaci reads and runs for each store in `src/devtools/`, and where each
fact comes from. "Source" means the upstream code, read on the date below;
"local" means checked on a Mac with the tool installed. Checked 2026-10-01.

Rules that apply to every store: one process per tool (never one per file),
a time limit on every process and HTTP call, an lstat walk for sizes, and
"unknown" blocks a delete. Nothing is deleted outside the store's own folder
(string and real-path containment), and the main process records each
removal in history v2 with its restore command.

## Local AI

| Store | Where (macOS / Windows / Linux, overrides) | List, in use | Delete | Restore |
|---|---|---|---|---|
| Ollama | `$OLLAMA_MODELS`, else `~/.ollama/models` (Windows `%USERPROFILE%\.ollama\models`; Linux service `/usr/share/ollama/.ollama/models`). Server `OLLAMA_HOST`, default `127.0.0.1:11434`. | `GET /api/tags` (name, size, details.parameter_size, details.quantization_level, family), `GET /api/ps` (loaded models), `ollama list`, `ollama ps` | `DELETE /api/delete {"model"}` when the server answers; otherwise remove `manifests/<host>/<ns>/<model>/<tag>` and the `blobs/sha256-<hex>` no other manifest references (what `Manifest.Remove` + `RemoveLayers` do) | `ollama pull <name:tag>` |
| LM Studio | `~/.lmstudio/models/<publisher>/<model>/` (home named in `~/.lmstudio-home-pointer`; folder changeable in My Models), older `~/.cache/lm-studio/models` | `lms ps --json`, REST `GET /api/v0/models` (`state: loaded`), `GET /api/v1/models` (`loaded_instances`) | No delete command in `lms`; Spaci removes the model folder (as the app does) | `lms get <publisher/model>` |
| Hugging Face hub | `HF_HUB_CACHE`, else `HUGGINGFACE_HUB_CACHE`, else `$HF_HOME/hub` (`HF_HOME` default `$XDG_CACHE_HOME/huggingface` or `~/.cache/huggingface`) | `models--org--name/{blobs,snapshots/<rev>,refs}`; `hf cache ls` / `scan-cache` | Repo: remove its folder. Revision: huggingface_hub's DeleteCacheStrategy (snapshot folder, refs to it, blobs no other snapshot links). Xet repos (nested blobs, `.refs`): whole repo only | `hf download <repo> [--revision]` |
| Docker Model Runner | `~/.docker/models` (`MODELS_PATH`) | `docker model ls --json`, `docker model ps` | `docker model rm <name>` | `docker model pull <name>` |
| GPT4All | `~/Library/Application Support/nomic.ai/GPT4All`, `%LOCALAPPDATA%\nomic.ai\GPT4All`, `~/.local/share/nomic.ai/GPT4All` | `*.gguf` files; app process | Remove the file (no CLI) | Download in the app |
| Jan | `~/Library/Application Support/Jan/data`, `%APPDATA%\Jan\data`, `~/.local/share/Jan/data`; models in `llamacpp/models/<org>/<repo>`, `mlx/models/<id>` | Model folders; app process | Remove the folder (no CLI) | Jan Hub |
| llama.cpp | `LLAMA_CACHE`, else `~/Library/Caches/llama.cpp`, `%LOCALAPPDATA%\llama.cpp`, `$XDG_CACHE_HOME/llama.cpp`. Newer `-hf` builds use the HF hub layout and appear under Hugging Face | Files; `llama-server` / `llama-cli` processes | Remove the file (no CLI) | Re-run with `-hf` |
| Whisper | `$XDG_CACHE_HOME/whisper` or `~/.cache/whisper`, `<name>.pt` | Files | Remove the file | `whisper.load_model(name)` |
| ComfyUI | `<install>/models/{checkpoints,loras,vae,...}`; `--base-directory`, `--models-directory`, `extra_model_paths.yaml` | Files over 20 MB; ComfyUI process | Remove the file | Download again |
| AUTOMATIC1111 | `<webui>/models/{Stable-diffusion,Lora,VAE,...}`; `--models-dir`, `--ckpt-dir` | Files over 20 MB | Remove the file | Download again |
| MLX | Uses the HF hub cache (`mlx-community/...`), labelled MLX there | as Hugging Face | as Hugging Face | as Hugging Face |
| llamafile, whisper.cpp | No managed store (files live where the user put them) | Not listed | n/a | n/a |

## Developer tools

| Tool | Where | List, in use | Delete | Restore |
|---|---|---|---|---|
| Xcode simulators | `~/Library/Developer/CoreSimulator/Devices/<UDID>`; runtimes as cryptex disk images | `xcrun simctl list -j devices` (state, isAvailable, dataPath, dataPathSize); `xcrun simctl runtime list -j` (sizeBytes, deletable, lastUsedAt) | `xcrun simctl delete <udid>`, `xcrun simctl runtime delete <id>` | `xcrun simctl create`, `xcodebuild -downloadPlatform iOS` |
| Xcode DeviceSupport | `~/Library/Developer/Xcode/{iOS,watchOS,tvOS,visionOS} DeviceSupport/<version>` | Folders | Remove the folder | Copied again when a device connects |
| Android | SDK `ANDROID_HOME` (`ANDROID_SDK_ROOT` deprecated), default `~/Library/Android/sdk`, `%LOCALAPPDATA%\Android\Sdk`, `~/Android/Sdk`; AVDs `ANDROID_AVD_HOME`, else `$ANDROID_EMULATOR_HOME/avd`, else `$ANDROID_USER_HOME/avd`, else `~/.android/avd` | `<name>.ini` + `<name>.avd/config.ini` (`image.sysdir.1`), `system-images/<api>/<tag>/<abi>`, `sdkmanager --list_installed`; emulator `*.lock` files and `-avd <name>` processes | `avdmanager delete avd -n <name>`, `sdkmanager --sdk_root=<sdk> --uninstall "<package>"` (Homebrew's sdkmanager defaults to its own root, so the root is always passed) | `sdkmanager "<package>"`, `avdmanager create avd` |
| nvm | `NVM_DIR`, else `$XDG_CONFIG_HOME/nvm` or `~/.nvm`; `versions/node/vX` | `alias/default`; pins | `nvm uninstall` is a shell function that deletes the folder; Spaci deletes the folder | `nvm install <v>` |
| fnm | `FNM_DIR`, else `$XDG_DATA_HOME/fnm`, `~/.fnm`, `~/Library/Application Support/fnm`, `%APPDATA%\fnm`; `node-versions/<v>` | `aliases/default` | `fnm uninstall <v>` | `fnm install <v>` |
| Volta | `VOLTA_HOME`, else `~/.volta`, `%LOCALAPPDATA%\Volta`; `tools/image/node/<v>` | `tools/user/platform.json` | No uninstall for Node (unsupported in Volta); Spaci deletes the image folder | `volta install node@<v>` |
| pyenv | `PYENV_ROOT`, else `~/.pyenv` (`pyenv-win` under it on Windows); `versions/<v>` | `version` (global) | `pyenv uninstall -f <v>` | `pyenv install <v>` |
| uv Python | `UV_PYTHON_INSTALL_DIR`, else `$XDG_DATA_HOME/uv/python` or `~/.local/share/uv/python`, `%APPDATA%\uv\data\python` | Folder keys; `uv python list --only-installed` also lists system interpreters, so only the managed folder is read | `uv python uninstall <key>` | `uv python install <v>` |
| uv cache | `UV_CACHE_DIR`, else `~/.cache/uv`, `%LOCALAPPDATA%\uv\cache` | System Cleaner target | Emptied like `uv cache clean` | Refills on install |
| conda | Environments listed in `~/.conda/environments.txt` | `conda-meta/` present; base and active env protected | `conda env remove -p <prefix> -y` | `conda env create -f environment.yml` |
| rustup | `RUSTUP_HOME`, else `~/.rustup`; `toolchains/<name>` | `settings.toml` default and overrides; `rust-toolchain(.toml)` | `rustup toolchain uninstall <name>` | `rustup toolchain install <name>` |
| JetBrains | Config `~/Library/Application Support/JetBrains/<Product><Ver>`, `%APPDATA%\JetBrains`, `~/.config/JetBrains`; caches `~/Library/Caches/JetBrains`, `%LOCALAPPDATA%\JetBrains`, `~/.cache/JetBrains`; logs `~/Library/Logs/JetBrains`; plugins `~/.local/share/JetBrains` (Linux) | Versions older than the newest of the same product | Remove the folders, as Help > Delete Leftover IDE Directories does | Nothing to restore |
| VS Code (and Insiders, Cursor, Windsurf) | `~/.vscode/extensions` (`VSCODE_EXTENSIONS`, `--extensions-dir`) | `extensions.json` (installed), `.obsolete` (superseded) | Remove superseded folders only, never one `extensions.json` lists | Not needed |
| Playwright | `PLAYWRIGHT_BROWSERS_PATH`, else `ms-playwright` under `~/Library/Caches`, `%LOCALAPPDATA%`, `$XDG_CACHE_HOME` | Revision folders | Remove the folder (`npx playwright uninstall` works per installation) | `npx playwright install` |
| Puppeteer | `PUPPETEER_CACHE_DIR`, else `~/.cache/puppeteer` | Folders | Remove the folder | `npx puppeteer browsers install chrome` |
| Cypress | `CYPRESS_CACHE_FOLDER`, else `~/Library/Caches/Cypress`, `%LOCALAPPDATA%\Cypress\Cache`, `~/.cache/Cypress` | Version folders | Remove the folder (as `cypress cache prune`) | `npx cypress install` |
| Electron | `electron_config_cache`, else `~/Library/Caches/electron`, `%LOCALAPPDATA%\electron\Cache`, `$XDG_CACHE_HOME/electron` | Zips in hash folders | Remove the entry | Next `npm install` |
| Terraform | `TF_PLUGIN_CACHE_DIR` or `plugin_cache_dir` in `~/.terraformrc` (off by default) | `<host>/<ns>/<type>/<version>` | Remove the folder | `terraform init` |
| Homebrew | `<prefix>/Cellar/<formula>/<version>`, current version linked from `<prefix>/opt/<formula>`; pinned formulae skipped; `HOMEBREW_CACHE` | Read from disk (`brew cleanup -n` took over two minutes locally and listed the same `xz 5.8.3`) | `brew cleanup --prune=all <formula>` | Not needed |
| Gradle | `GRADLE_USER_HOME`, else `~/.gradle`; `wrapper/dists/gradle-<v>-<bin|all>` | Projects' `gradle-wrapper.properties`; running daemons | Remove the folder | `./gradlew` downloads it |
| Go | `go env GOCACHE`, `GOMODCACHE` | Already a System Cleaner target (`go`) | Emptied like `go clean -cache -modcache` | Next build |

## Links

Ollama
- https://raw.githubusercontent.com/ollama/ollama/main/docs/faq.mdx
- https://raw.githubusercontent.com/ollama/ollama/main/envconfig/config.go
- https://raw.githubusercontent.com/ollama/ollama/main/types/model/name.go
- https://raw.githubusercontent.com/ollama/ollama/main/manifest/manifest.go
- https://raw.githubusercontent.com/ollama/ollama/main/manifest/paths.go
- https://raw.githubusercontent.com/ollama/ollama/main/api/types.go
- https://raw.githubusercontent.com/ollama/ollama/main/server/routes.go (DeleteHandler: `cmp.Or(r.Model, r.Name)`)
- https://raw.githubusercontent.com/ollama/ollama/main/server/images.go (PruneLayers, OLLAMA_NOPRUNE)
- https://raw.githubusercontent.com/ollama/ollama/main/docs/windows.mdx

LM Studio
- https://lmstudio.ai/docs/app/advanced/import-model
- https://lmstudio.ai/docs/app/basics/download-model
- https://lmstudio.ai/docs/cli/local-models/ls
- https://lmstudio.ai/docs/cli/local-models/ps
- https://lmstudio.ai/docs/cli/local-models/get
- https://lmstudio.ai/docs/developer/rest/endpoints
- https://github.com/lmstudio-ai/lms/tree/main/src/subcommands (no delete subcommand)

Hugging Face, MLX, llama.cpp, Whisper, GPT4All, Jan, ComfyUI, AUTOMATIC1111, Docker Model Runner
- https://raw.githubusercontent.com/huggingface/huggingface_hub/main/docs/source/en/package_reference/environment_variables.md
- https://raw.githubusercontent.com/huggingface/huggingface_hub/main/docs/source/en/guides/manage-cache.md
- https://raw.githubusercontent.com/ml-explore/mlx-lm/main/mlx_lm/manage.py
- https://raw.githubusercontent.com/ggml-org/llama.cpp/master/common/hf-cache.cpp
- https://raw.githubusercontent.com/ggml-org/llama.cpp/master/common/common.cpp
- https://raw.githubusercontent.com/openai/whisper/main/whisper/__init__.py
- https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/models/README.md
- https://raw.githubusercontent.com/nomic-ai/gpt4all/main/gpt4all-bindings/python/docs/gpt4all_desktop/settings.md
- https://raw.githubusercontent.com/janhq/jan/dev/docs/src/pages/docs/desktop/data-folder.mdx
- https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/folder_paths.py
- https://raw.githubusercontent.com/AUTOMATIC1111/stable-diffusion-webui/master/modules/paths_internal.py
- https://raw.githubusercontent.com/Mozilla-Ocho/llamafile/main/README.md
- https://raw.githubusercontent.com/docker/model-runner/main/pkg/envconfig/envconfig.go
- https://raw.githubusercontent.com/docker/model-runner/main/cmd/cli/commands/list.go
- https://raw.githubusercontent.com/docker/model-runner/main/cmd/cli/commands/rm.go
- https://raw.githubusercontent.com/docker/docs/main/content/manuals/ai/model-runner/get-started.md

Developer tools
- https://developer.android.com/tools/variables
- https://developer.android.com/tools/avdmanager
- https://developer.android.com/tools/sdkmanager
- `xcrun simctl help delete`, `xcrun simctl runtime help` (local, Xcode on macOS 27)
- https://raw.githubusercontent.com/nvm-sh/nvm/master/README.md
- https://raw.githubusercontent.com/Schniz/fnm/master/src/directories.rs
- https://raw.githubusercontent.com/Schniz/fnm/master/docs/commands.md
- https://raw.githubusercontent.com/volta-cli/volta/main/crates/volta-layout/src/v4.rs
- https://raw.githubusercontent.com/volta-cli/volta/main/crates/volta-core/src/tool/mod.rs (uninstall of node unsupported)
- https://raw.githubusercontent.com/pyenv/pyenv/master/README.md
- https://raw.githubusercontent.com/pyenv/pyenv/master/plugins/python-build/bin/pyenv-uninstall
- https://raw.githubusercontent.com/pyenv-win/pyenv-win/master/README.md
- https://raw.githubusercontent.com/astral-sh/uv/main/docs/reference/storage.md
- https://raw.githubusercontent.com/astral-sh/uv/main/docs/concepts/cache.md
- https://docs.conda.io/projects/conda/en/stable/user-guide/configuration/settings.html
- https://docs.conda.io/projects/conda/en/stable/commands/env/remove.html
- https://docs.conda.io/projects/conda/en/stable/commands/clean.html
- https://raw.githubusercontent.com/rust-lang/rustup/master/doc/user-guide/src/environment-variables.md
- https://raw.githubusercontent.com/rust-lang/rustup/master/doc/user-guide/src/overrides.md
- https://www.jetbrains.com/help/idea/directories-used-by-the-ide-to-store-settings-caches-plugins-and-logs.html
- https://code.visualstudio.com/docs/editor/extension-marketplace
- https://raw.githubusercontent.com/microsoft/playwright/main/packages/playwright-core/src/server/registry/index.ts
- https://raw.githubusercontent.com/puppeteer/puppeteer/main/packages/puppeteer/src/getConfiguration.ts
- https://docs.cypress.io/app/references/advanced-installation
- https://docs.cypress.io/app/references/command-line
- https://raw.githubusercontent.com/electron/electron/main/docs/tutorial/installation.md
- https://developer.hashicorp.com/terraform/cli/config/config-file
- https://docs.brew.sh/Manpage
- https://docs.gradle.org/current/userguide/directory_layout.html
- https://pkg.go.dev/cmd/go

## Not verified

- `xcrun simctl list -j devices` per-device `dataPathSize`: the test Mac had no devices. Spaci measures `dataPath` itself when the field is missing.
- Android emulator lock file names (`hardware-qemu.ini.lock`, `multiinstance.lock`): any `*.lock` in the `.avd` folder counts as running, and so does a qemu or emulator process naming the AVD.
- `lms ps --json` and `docker model ls --json` field names are not documented; Spaci accepts the documented REST fields too and treats an unreadable answer as "not checked", which blocks deletes.
- Windows defaults for nvm-windows (not handled: it has its own uninstall), Linux Homebrew cache, and conda's environment list location on Windows.
