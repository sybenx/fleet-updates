#!/bin/sh
# Takes this Mac off the page and removes the agent.
#   curl -fsSL '<dashboard>/install/mac/uninstall' | sh
# FLEET_INSTALL_NO_LOAD=1 leaves launchd alone (tests).
set -u
DIR="$HOME/Library/Application Support/FleetAgent"
PLIST="$HOME/Library/LaunchAgents/cc.aaro.fleet-agent.plist"
if [ "${FLEET_INSTALL_NO_LOAD:-0}" != 1 ] && [ -f "$PLIST" ]; then
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
fi
[ -x "$DIR/fleet-agent" ] && "$DIR/fleet-agent" uninstall
rm -f "$PLIST"
rm -rf "$DIR"
echo "Fleet agent removed."
