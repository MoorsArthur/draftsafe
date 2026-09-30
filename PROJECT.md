# Draftsafe

## Deployment

- Canonical source: `MoorsArthur/draftsafe`, currently private. This checkout is
  the active feature branch; the old `thunderbird-mcp` repository is a local
  historical backup.
- One combined Draftsafe 0.7.0 add-on is installed in the maintainer's
  Thunderbird profile. The 0.8.0 source is a release candidate.
- Codex and Claude use this repository's `scripts/launch.mjs` as their MCP
  entry point. Public MCP and Thunderbird update channels are not active.

## Architecture

- A stdio Node.js MCP server connects to an authenticated loopback bridge in
  one Thunderbird MailExtension. The add-on also contains approval UI,
  Snooze, Send later and Follow-ups.
- Agents can read mail, prepare native compose windows and request bounded
  changes. Sending prepared mail requires the user's Thunderbird Send click.
- The `.ua/knowledge-graph.json` Understand Anything graph and
  `docs/understand-anything.md` explain the source structure.

## Decisions

- 2026-09-30: Keep Send later in the combined add-on and keep all agent
  compose routes free of send calls.
- 2026-09-30: Use reviewed Thunderbird Add-ons updates for the XPI and a
  separately signed HTTPS GitHub release feed for the MCP server.
- 2026-09-30: Keep the old local repository as a backup while active MCP
  clients use this GitHub-connected checkout.

## Status

- State: active
- Phase: release preparation
- Now: The 0.8.0 candidate passes 284 tests and 58 isolated Thunderbird smoke checks; its signed MCP bundle verifies locally.
- Next: Review and install the candidate in the live profile, then authorize public release and Thunderbird submission separately.
- Blocked by: Live installation and external publication require owner review of the prepared candidate.
- Updated: 2026-10-01
