# Draftsafe

## Deployment

- Canonical source: `MoorsArthur/draftsafe`, currently private. PR #2 merged
  the 0.8.0 candidate into `main`; the old `thunderbird-mcp` repository is a
  local historical backup.
- One combined Draftsafe 0.7.0 add-on is installed in the maintainer's
  Thunderbird profile. The 0.8.1 source is a release candidate.
- Codex and Claude use this repository's `scripts/launch.mjs` as their MCP
  entry point. Public update files are being prepared in a separate repository.

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
  separately signed HTTPS GitHub release feed for the MCP server (superseded
  for the private-source trial by the 2026-10-01 distribution decision).
- 2026-09-30: Keep the old local repository as a backup while active MCP
  clients use this GitHub-connected checkout.
- 2026-10-01: Keep full source and history private while publishing signed
  versioned update artifacts publicly; use a self-hosted XPI update manifest
  until an ATN listing is separately reviewed.

## Status

- State: active
- Phase: private-source update publication
- Now: The 0.8.1 local gate passes 284 tests and 58 isolated Thunderbird checks; the tag gate needs its X11 dependency fix reviewed.
- Next: Merge the CI fix, pass the 0.8.1 tag gate, publish update files, then install the XPI once in the live profile.
- Blocked by: None.
- Updated: 2026-10-01
