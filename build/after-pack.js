'use strict';
// electron-builder afterPack hook. On Linux, puts a small launcher in front of
// the Electron binary: Ubuntu 23.10+ blocks unprivileged user namespaces through
// AppArmor, and an AppImage can ship neither an AppArmor profile nor a setuid
// sandbox helper, so Chromium aborts before any app code runs. Only in that exact
// case (running as an AppImage, restriction on) the launcher adds --no-sandbox.
// The deb keeps the sandbox: it installs an AppArmor profile for the real binary.
const fs = require('fs');
const path = require('path');

const LAUNCHER = `#!/bin/bash
HERE="$(dirname "$(readlink -f "$0")")"
if [ -n "$APPIMAGE" ] && [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = "1" ]; then
  exec "$HERE/__BIN__" --no-sandbox "$@"
fi
exec "$HERE/__BIN__" "$@"
`;

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;
  const name = context.packager.executableName;
  const exe = path.join(context.appOutDir, name);
  const bin = `${name}-bin`;
  fs.renameSync(exe, path.join(context.appOutDir, bin));
  fs.writeFileSync(exe, LAUNCHER.replace(/__BIN__/g, bin), { mode: 0o755 });
};
