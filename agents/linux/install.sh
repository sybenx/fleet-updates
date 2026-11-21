#!/bin/sh
# Installs the Fleet Updates agent for this user as a systemd user timer. From the page:
#   curl -fsSL '<dashboard>/install/linux?t=<join token>' | FLEET_APPROVER=<key> sh
# The dashboard puts FLEET_URL and FLEET_JOIN at the top. This script only downloads the agent,
# checks its sha256, has it join, and sets up the timer.
# FLEET_INSTALL_NO_LOAD=1 leaves systemd alone (tests).
set -eu
umask 077
URL=${FLEET_URL:?no dashboard address}
URL=${URL%/}
case "$(uname -m)" in
  x86_64) BIN=fleet-agent-linux-amd64 ;;
  *) echo "Only x86_64 has an agent build." >&2; exit 1 ;;
esac
SHARE="$HOME/.local/share/fleet-agent"
UNITS="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$SHARE" "$UNITS"

curl -fsSL "$URL/api/agent/bin/$BIN" -o "$SHARE/fleet-agent.new"
want=$(curl -fsSL "$URL/api/agent/bin/$BIN.sha256" | awk '{ print $1 }')
have=$(sha256sum "$SHARE/fleet-agent.new" 2>/dev/null | awk '{ print $1 }')
[ -n "$have" ] || have=$(shasum -a 256 "$SHARE/fleet-agent.new" | awk '{ print $1 }')
if [ -z "$want" ] || [ "$want" != "$have" ]; then
  rm -f "$SHARE/fleet-agent.new"
  echo "The download does not match its sha256. Nothing installed." >&2
  exit 1
fi
chmod 700 "$SHARE/fleet-agent.new"
mv "$SHARE/fleet-agent.new" "$SHARE/fleet-agent"

if [ -n "${FLEET_JOIN:-}" ]; then
  "$SHARE/fleet-agent" join --os linux --url "$URL" --approver "${FLEET_APPROVER:-}" "$FLEET_JOIN"
fi

curl -fsSL "$URL/api/agent/files/linux/fleet-agent.service" -o "$UNITS/fleet-agent.service"
curl -fsSL "$URL/api/agent/files/linux/fleet-agent.timer" -o "$UNITS/fleet-agent.timer"
chmod 644 "$UNITS/fleet-agent.service" "$UNITS/fleet-agent.timer"

if [ "${FLEET_INSTALL_NO_LOAD:-0}" = 1 ]; then
  echo "wrote $UNITS/fleet-agent.timer (not enabled)"
  exit 0
fi
systemctl --user daemon-reload
systemctl --user enable --now fleet-agent.timer
# Keeps the timer running while nobody is logged in.
loginctl enable-linger "$(id -un)" 2>/dev/null || echo "Could not turn on linger: the agent runs only while you are logged in." >&2

# System flatpaks need polkit's OK when nobody is at the screen. One sudo step, printed, not run.
if command -v flatpak >/dev/null 2>&1 && [ -n "$(flatpak list --system --columns=application 2>/dev/null)" ]; then
  u=$(id -un)
  echo
  echo "To let the agent update system flatpaks without a password, run this once:"
  echo "  printf '%s\\n' 'polkit.addRule(function (a, s) { if ((a.id == \"org.freedesktop.Flatpak.app-update\" || a.id == \"org.freedesktop.Flatpak.runtime-update\") && s.user == \"$u\") return polkit.Result.YES; });' | sudo tee /etc/polkit-1/rules.d/50-fleet-agent.rules"
fi
echo "Fleet agent installed."
