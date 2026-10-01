# Devtools fixtures

Captured on a Mac (2026-10-01) from the real tools, unedited:

| File | Command |
|---|---|
| ollama-api-tags.json | `curl http://127.0.0.1:11434/api/tags` (Ollama 0.34.4) |
| ollama-api-ps-empty.json | `curl http://127.0.0.1:11434/api/ps` |
| ollama-list.txt | `ollama list` |
| ollama-manifest-nomic-embed-text.json | `~/.ollama/models/manifests/registry.ollama.ai/library/nomic-embed-text/latest` |
| simctl-runtime-list.json | `xcrun simctl runtime list -j` |
| simctl-devices-empty.json | `xcrun simctl list -j devices` (no devices on that Mac) |
| sdkmanager-list-installed.txt | `sdkmanager --sdk_root=$HOME/Library/Android/sdk --list_installed` (progress lines dropped) |
| avdmanager-list-avd-empty.txt | `avdmanager list avd` (no AVDs on that Mac) |
| uv-python-list.json | `uv python list --only-installed --output-format json` |
| vscode-extensions.json | four entries of `~/.vscode/extensions/extensions.json` |
| vscode-obsolete.json | `~/.vscode/extensions/.obsolete` |
| vscode-extension-folders.txt | `ls ~/.vscode/extensions` |

Written by hand in the documented shape, because that Mac had none to capture
(see docs/devtools-sources.md for the field lists):

| File | Shape from |
|---|---|
| ollama-api-ps-loaded.json | Ollama api/types.go ProcessModelResponse |
| simctl-devices-sample.json | `xcrun simctl list -j devices` device fields |
| avdmanager-list-avd-sample.txt | `avdmanager list avd` text output |
