#!/bin/sh
# OpenBand Box on a Raspberry Pi or any Debian-like Linux. Read it, then run it with sudo.
#   curl -fsSL https://raw.githubusercontent.com/iltempe/openband/main/scripts/box/install.sh | sudo sh
set -eu
[ "$(id -u)" = 0 ] || { echo "Run it with sudo." >&2; exit 1; }
apt-get update
apt-get install -y ffmpeg alsa-utils avahi-daemon gpiod curl
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sh
  apt-get install -y nodejs
fi
id openband >/dev/null 2>&1 || useradd --system --home /var/lib/openband --groups audio,gpio openband
install -d -o openband -g openband /var/lib/openband /opt/openband
npm install --global --prefix /opt/openband https://github.com/iltempe/openband/releases/latest/download/openband.tgz
hostnamectl set-hostname openband
systemctl enable --now avahi-daemon
OPENBAND_DATA=/var/lib/openband /opt/openband/bin/openband box install "$@"
chown -R openband:openband /var/lib/openband
echo "Done. Open http://openband.local:7777 from a phone on the same network."
