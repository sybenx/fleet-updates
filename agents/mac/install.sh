#!/bin/sh
# Installs the Fleet Updates agent for this user and starts it with launchd. From the page:
#   curl -fsSL '<dashboard>/install/mac?t=<join token>' | FLEET_APPROVER=<key> sh
# The dashboard puts FLEET_URL and FLEET_JOIN at the top. This script only downloads the agent,
# checks its sha256, has it join, and sets up the timer.
# FLEET_INSTALL_NO_LOAD=1 leaves launchd alone (tests).
set -eu
umask 077
URL=${FLEET_URL:?no dashboard address}
URL=${URL%/}
case "$(uname -m)" in
  arm64) BIN=fleet-agent-darwin-arm64 ;;
  *) echo "Only Apple silicon Macs have an agent build." >&2; exit 1 ;;
esac
DIR="$HOME/Library/Application Support/FleetAgent"
PLIST="$HOME/Library/LaunchAgents/cc.aaro.fleet-agent.plist"
mkdir -p "$DIR" "$HOME/Library/LaunchAgents"

curl -fsSL "$URL/api/agent/bin/$BIN" -o "$DIR/fleet-agent.new"
want=$(curl -fsSL "$URL/api/agent/bin/$BIN.sha256" | awk '{ print $1 }')
have=$(shasum -a 256 "$DIR/fleet-agent.new" | awk '{ print $1 }')
if [ -z "$want" ] || [ "$want" != "$have" ]; then
  rm -f "$DIR/fleet-agent.new"
  echo "The download does not match its sha256. Nothing installed." >&2
  exit 1
fi
chmod 700 "$DIR/fleet-agent.new"
mv "$DIR/fleet-agent.new" "$DIR/fleet-agent"

if [ -n "${FLEET_JOIN:-}" ]; then
  "$DIR/fleet-agent" join --os mac --url "$URL" --approver "${FLEET_APPROVER:-}" "$FLEET_JOIN"
fi

curl -fsSL "$URL/api/agent/files/mac/cc.aaro.fleet-agent.plist" |
  sed -e "s|__AGENT__|$(printf '%s' "$DIR/fleet-agent" | sed 's/[&|]/\\&/g')|" -e "s|__HOME__|$(printf '%s' "$HOME" | sed 's/[&|]/\\&/g')|g" >"$PLIST"
chmod 644 "$PLIST"

if [ "${FLEET_INSTALL_NO_LOAD:-0}" = 1 ]; then
  echo "wrote $PLIST (not loaded)"
  exit 0
fi
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Fleet agent installed."
