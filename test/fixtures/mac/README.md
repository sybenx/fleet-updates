`tailscale-status.json`: `tailscale status --json` recorded on the Mac 2026-11-21, then scrubbed:
only HostName, DNSName, OS, Online and the shape kept; every IP, node key, id, user, email and the
tailnet name replaced with fakes (100.64.0.x, example-tailnet.ts.net, owner@example.com). Only
machines already named in the README kept, plus one fake VPS whose HostName and DNS label differ.
