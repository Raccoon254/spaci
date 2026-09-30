#!/bin/bash
# Spaci deb post-remove: electron-builder's default steps plus removing the
# AppArmor profile installed by after-install.sh.

if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/usr/bin/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

if [ -e '/etc/apparmor.d/${executable}' ]; then
    if hash apparmor_parser 2>/dev/null; then
        apparmor_parser --remove '/etc/apparmor.d/${executable}' 2>/dev/null || true
    fi
    rm -f '/etc/apparmor.d/${executable}'
fi
