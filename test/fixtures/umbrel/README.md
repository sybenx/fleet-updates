Recorded 2026-11-21 from xumbrel's MCP tools (list_apps, get_app_status, check_os_update,
get_os_update_status, get_app_details; trimmed, and updateAvailable/available flipped to true on
some entries to have something to update). update_app and install_os_update were not recorded:
calling them would update something. server/umbrel/adapter.js marks what is assumed about those.

`mcp-401.txt`: `curl -si http://<axial's Tailscale IP>/mcp` with no token, recorded 2026-11-21 (what
`server/umbrel/discover.js` `looksLikeUmbrel` checks). `agent-message.txt`: the shape of the "send
your agent this message" text: the endpoint and header lines are assembled, the paragraph after them
is umbrelOS's own MCP server instructions as served by axial; the token is fake.
