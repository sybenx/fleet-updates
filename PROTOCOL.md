# Fleet Updates protocol (v1)

The code is `server/protocol.js` (dashboard) and `agent/protocol.go` + `agent/nostr.go` (machines).
`test/fixtures/protocol/vectors.json` (made by `node test/make-vectors.mjs`) holds both to the same
ids, hashes and signatures.

## State, not messages

Each machine has ONE latest report. The dashboard has ONE latest approval per machine. A newer one
replaces the older one, so a lost message is harmless: the next run sends everything again. There is
no job queue.

## Events

Both are Nostr events (NIP-01): `id` = sha256 of `[0, pubkey, created_at, kind, tags, content]`
serialized like `JSON.stringify`, `sig` = BIP340 Schnorr over the id. So an approval signed by a
Keykin child key in v2 verifies unchanged, and both can later ride over relays.

| | kind | signed by | `d` tag |
|---|---|---|---|
| report | 31748 | the machine's own key, made at join | machine id |
| approval | 31747 | the approver key | machine id |

Both kinds are addressable (30000-39999), not 30078, not in Keykin's kept set.

## Report

Tags: `["d", machine id]`, `["report", report_hash]`.
Content (JSON; NIP-44 encrypted to the dashboard inbox key in v2):

```json
{ "v": 1, "os": "mac", "host": "...",
  "items":   [{ "channel": "brew-cask", "name": "firefox", "title": "Mozilla Firefox",
                "current": "120.0", "latest": "121.0", "flags": { "apps": ["Firefox.app"] } }],
  "badges":  [{ "channel": "softwareupdate", "title": "macOS 27.2.1", "restart": true }],
  "applied": [{ "at": "...", "how": "click|overnight", "channel": "...", "name": "...",
                "from": "...", "to": "...", "status": "installed", "message": "" }],
  "last_counter": 4,
  "uninstall": true }
```

`report_hash` = sha256 of `[1, os, rows]` where rows are `[channel, name, current, latest]` for each
item, sorted. Flags that change minute to minute (an app running) are not in it.

The dashboard accepts a report only when the signature is good, the key is one it added at join,
the `d` tag is that key's machine, the hash matches the items, and `created_at` is not more than
600 s ahead. An older report than the one it has is ignored. `uninstall: true` takes the card off.

Channels: `brew-formula`, `brew-cask`, `flatpak-user`, `flatpak-system`, `winget`, `dockge`.
Badges (never installed by an agent): `softwareupdate`, `rpm-ostree`, `windows-update`.

## Approval

The page builds it (`POST /api/machines/:id/draft`), its signer signs it, the page posts it back
(`POST /api/machines/:id/approval`). Tags:

- `["d", machine id]`
- `["report", report_hash]`: the report it approves
- `["counter", n]`: only goes up, per machine (not `created_at`)
- `["expiration", unix]`: NIP-40, 24 h
- optional `["only", item id, ...]`: item id = first 12 hex of sha256(`channel \0 name`); narrows the
  machine's own list, never adds to it
- optional `["override", stack, "pinned" | "compare"]`: Dockge pin overrides from the page
- optional `["ask_first", winget id, ...]`: the Windows overnight ask-first list

`created_at` is now (the dev signer never signs one in the future).

## What a machine does each run

1. Regenerate its own list (from cache between full checks, every 2 h; 30 min between 02:00 and 05:00).
2. Fetch the approval (`GET /api/agent/approval?m=<id>`). Use it only if all hold:
   signature good, signer is the approver key from the join command, kind 31747, `d` is this
   machine, counter above the last one it applied, not expired, not from the future, and `report`
   equals the hash of its list. If the list came from cache, regenerate it and check again.
   Anything else: do nothing with it.
3. Apply its own items (filtered by `only`) under its own rules; remember the counter.
4. Between 02:00 and 05:00, apply what its own overnight rules allow. No approval needed.
5. Send a fresh signed report.

A newer valid approval (signature, signer, machine, counter, not expired) also carries policy
(`ask_first`) even when its hash no longer matches.

## Joining

`POST /api/joins` (page) makes a one-time join token (1 h, single use). The install command carries
it and the approver key. The agent makes its key and calls `POST /api/agent/register`
`{ join, os, host, pubkey }` -> `{ machine, approver }`; it refuses to join when the dashboard's
approver differs from the one in the command.

## Endpoints outside the Umbrel login

`/install/<os>`, `/install/<os>/uninstall`, `/api/agent/files/...`, `/api/agent/bin/...` (+ `.sha256`),
`/api/agent/register`, `/api/agent/report`, `/api/agent/approval`. Everything else is behind it.

## Signer

One interface (`server/page/signer.js` on the page, `server/signer.js` on the server). v1: a test key
in the data folder, only with `FLEET_DEV_SIGNER=1`. v2: the page signs through the shared Keykin
sign-in (child key, NIP-46 to the phone) and the server holds no approval key; it is then given
only the approver's public key (`FLEET_APPROVER`).
