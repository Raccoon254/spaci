#!/bin/bash
# Spaci deb post-install. Same steps as electron-builder's default template,
# plus an AppArmor profile: Ubuntu 23.10 and later block unprivileged user
# namespaces, which Chromium's sandbox needs, so without it the app exits at
# launch. The profile only grants `userns` to Spaci's own binary (the real
# Electron binary behind the launcher, see build/after-pack.js).

if type update-alternatives 2>/dev/null >&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

# SUID chrome-sandbox for Electron 5+
chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true

# AppArmor 4 (Ubuntu 24.04+) understands the userns rule. Older releases do not
# restrict user namespaces and do not need a profile, so skip them.
if [ -d /etc/apparmor.d ] && [ -e /etc/apparmor.d/abi/4.0 ] && hash apparmor_parser 2>/dev/null; then
    cat > '/etc/apparmor.d/${executable}' <<PROFILE
abi <abi/4.0>,
include <tunables/global>

profile ${executable} "/opt/${sanitizedProductName}/${executable}-bin" flags=(unconfined) {
  userns,

  include if exists <local/${executable}>
}
PROFILE
    apparmor_parser --replace --write-cache --skip-read-cache '/etc/apparmor.d/${executable}' || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

if hash gtk-update-icon-cache 2>/dev/null; then
    gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
fi
