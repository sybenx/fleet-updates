# Fleet Updates

One page that shows every machine's pending updates and installs them with one click. Runs as the
Umbrel app `aaro-updates` (store: `~/umbrel-store-syb`, store id `aaro`). Design: `PLAN.md`.
Messages: `PROTOCOL.md`.

- `server/`: Node 24, no framework, no npm installs (`@noble/curves` and `@noble/hashes` are
  vendored in `server/vendor`). State is one JSON file in `DATA_DIR`. Serves the page, the API, the
  install scripts and the agent binaries.
- `agent/`: one Go program for Mac, Linux (SteamOS, bazzite), Windows and Dockge. Signs its reports
  with its own key, checks approvals, applies only its own list under its own rules.
- `agents/`: the thin install and uninstall scripts, launchd plist, systemd units, Dockge compose.

## Adding machines

On the page, **Add machine**, pick the OS, run the one command it shows. The command works once,
within an hour. It downloads the agent, checks its sha256, makes the machine's key, registers it
and sets up the timer. Each card shows its uninstall command under **Machine**.

| Machine | Where to run it | Timer | Catch |
|---|---|---|---|
| Mac (Apple silicon) | Terminal | launchd, every 10 min and at wake | App Store apps are not covered (no `mas`) |
| Linux, SteamOS, bazzite (x86_64) | Terminal, as the desktop user | systemd user timer, every 10 min | System flatpaks need one sudo step for polkit; the installer prints it. `rpm-ostree` is a badge only |
| Windows (Took) | PowerShell, Run as administrator | Scheduled Task, every 10 min and at startup, Below Normal | Needs admin once |
| Dockge (xumbrel, axial) | Dockge: + Compose, name `fleet-agent`, paste the snippet, Deploy | the container polls every minute | Needs the `fleet-dockge-agent` image built |
| Umbrel (xumbrel, axial, ambrel) | nothing: enter its address and MCP token on the card | the server checks every 30 min | Updates are clicks only |

Mac and Linux commands look like
`curl -fsSL 'http://<dashboard>:7480/install/mac?t=<join>' | FLEET_APPROVER=<key> sh`, Windows
`$env:FLEET_APPROVER='<key>'; irm 'http://<dashboard>:7480/install/windows?t=<join>' | iex`.

## Rules

Overnight (02:00 to 05:00 local, decided on the machine, no approval needed):

- Homebrew formulae: yes, unless pinned.
- Homebrew casks: only if not a `.pkg`, the app is not running, and that version was first seen on
  this Mac at least 2 days ago. Never `--greedy`.
- Flatpak (user and system): everything.
- winget: everything not on the page's ask-first list (Java runtimes are on it by default) and not
  needing explicit targeting; always `--silent --accept-source-agreements --accept-package-agreements`.
- Dockge stacks, Umbrel apps, umbrelOS, macOS, Windows Update, rpm-ostree: never.

A click (an approval of the machine's latest report) installs the machine's own list as approved,
still never a `.pkg` cask without a person, never a running app, nothing while a game or Minecraft
client runs (Took: `steamapps/common`, Minecraft clients, `games.txt` in the agent folder), and on
Windows at Below Normal priority. The agent never works in `C:\mc`.

Dockge stacks: an image by `@sha256:` or an exact version tag is pinned (no button); a major-only
tag like `postgres:17` is compared within that major and labelled `major 17`; floating tags are
compared. Locally built images show `built locally`. The card can pin or unpin a stack.

## Develop

```sh
npm test                                   # Node tests; builds the Go agent if Go is installed
cd agent && go test ./...                  # Go tests
scripts/build-agents.sh                    # agent binaries into dist/ (gitignored)
FLEET_DEV_SIGNER=1 DATA_DIR=./data node server/server.js
```

Agent switches for testing: `FLEET_DRY_RUN=1` (print what it would install), `FLEET_FIXTURE_DIR`
(tool output from files), `FLEET_HOUR`, `FLEET_NOW`, `FLEET_OS`, `FLEET_STATE_DIR`.

## Release

Push a `v*` tag: `.github/workflows/images.yml` runs the tests, then builds
`ghcr.io/sybenx/fleet-updates` and `ghcr.io/sybenx/fleet-dockge-agent` for amd64 and arm64. Pin the
digest in `aaro-updates/docker-compose.yml` in the store.
