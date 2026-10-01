# Draftsafe

## Deployment

- Canonical source: `MoorsArthur/draftsafe`, private. Version 0.8.1 is tagged
  and listed in its GitHub Releases; the old `thunderbird-mcp` checkout is a
  local historical backup.
- One combined Draftsafe 0.8.1 add-on is active in the maintainer's
  Thunderbird profile. Its self-hosted update URL points to the public
  `MoorsArthur/draftsafe-updates` repository.
- Codex and Claude use this repository's `scripts/launch.mjs` as their MCP
  entry point with the signed MCP updater enabled. The public repository has
  versioned 0.8.1 downloads and stable update manifests.
- The 2026-10-01 release audit found no credential or private home path in
  either reachable Git history or the published update files. Arthur approved
  a history rewrite. All nine private source branch/tag refs on GitHub were
  rewritten and verified against a private backup; the reachable history now
  has no student-domain commit or tag email. Six read-only GitHub PR refs and
  cached SHA views can still retain the old metadata, so this repository must
  stay private. Publish future source from a fresh audited repository.

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
- 2026-10-01: Require the maintainer's GitHub noreply commit/tag identity in
  CI and a local push hook. GitHub's account email privacy remains a separate
  setting; the available CLI token cannot change it.

## Status

- State: active
- Phase: private-source trial, public update channel live
- Now: The 0.8.1 local gate passed 284 tests and 58 isolated Thunderbird checks; the tagged CI gate passed. Public XPI/MCP downloads matched CI hashes, both stable manifests verified, and a fresh live MCP launch reported 21 tools and add-on 0.8.1. The signed updater reported `current`.
- Next: Verify GitHub account email privacy, observe a real later-version
  Thunderbird auto-upgrade, and use a fresh audited repo for any public source
  release. A live bridge check awaits Thunderbird being open.
- Blocked by: GitHub account email privacy must be enabled in Settings → Emails
  before another web PR merge or public source publication.
- Updated: 2026-10-01
