#!/bin/sh
# Builds the agent for the three targets into dist/ (gitignored). Uses the Go module cache only
# when GOPROXY=off is set by the caller.
set -eu
cd "$(dirname "$0")/.."
mkdir -p dist
for t in darwin/arm64 linux/amd64 windows/amd64; do
  os=${t%/*}; arch=${t#*/}; ext=; [ "$os" = windows ] && ext=.exe
  (cd agent && CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath -ldflags "-s -w" -o "../dist/fleet-agent-$os-$arch$ext" .)
  echo "dist/fleet-agent-$os-$arch$ext"
done
