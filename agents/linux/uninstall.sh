#!/bin/sh
# Takes this machine off the page and removes the agent.
#   curl -fsSL '<dashboard>/install/linux/uninstall' | sh
# FLEET_INSTALL_NO_LOAD=1 leaves systemd alone (tests).
set -u
SHARE="$HOME/.local/share/fleet-agent"
UNITS="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
if [ "${FLEET_INSTALL_NO_LOAD:-0}" != 1 ]; then
  systemctl --user disable --now fleet-agent.timer 2>/dev/null || true
fi
[ -x "$SHARE/fleet-agent" ] && "$SHARE/fleet-agent" uninstall
rm -f "$UNITS/fleet-agent.service" "$UNITS/fleet-agent.timer"
rm -rf "$SHARE" "${XDG_STATE_HOME:-$HOME/.local/state}/fleet-agent"
[ "${FLEET_INSTALL_NO_LOAD:-0}" != 1 ] && systemctl --user daemon-reload 2>/dev/null
echo "Fleet agent removed."
echo "If you added /etc/polkit-1/rules.d/50-fleet-agent.rules, remove it with sudo."
