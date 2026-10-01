# Draftsafe

## Deployment

- Canonical source: public `MoorsArthur/draftsafe`. Version 0.8.1 is tagged
  and listed in GitHub Releases. The former development repository remains a
  separate private archive with its old pull-request refs.
- One combined Draftsafe 0.8.1 add-on is active in the maintainer's
  Thunderbird profile. Its self-hosted update URL points to the public
  `MoorsArthur/draftsafe-updates` repository.
- Codex and Claude use this repository's `scripts/launch.mjs` as their MCP
  entry point with the signed MCP updater enabled. The public repository has
  versioned 0.8.1 downloads and stable update manifests.
- The public repository was created from audited `main` and the two release
  tags. Its reachable history has no student-domain commit or tag email.
  The old private archive keeps historical PR refs that were deliberately
  excluded from the public repository.

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
  until an ATN listing is separately reviewed (source privacy superseded by
  the public-source decision below; the update channel remains unchanged).
- 2026-10-01: Publish only audited source refs in a fresh public repository
  under the original name. Keep the former repo private as an archive and
  keep the public update URLs stable for installed copies.
- 2026-10-01: Require the maintainer's GitHub noreply commit/tag identity in
  CI and a local push hook. Public `main` requires the passing `verify` check
  for the owner and blocks force pushes/deletion. GitHub's account email
  privacy is also enabled; an anonymous profile check shows no public email.

## Status

- State: active
- Phase: public source, public update channel live
- Now: The 0.8.1 release gate passed 284 tests and 58 isolated Thunderbird checks; current main passes 288 tests and CI. Public XPI/MCP downloads matched CI hashes and both stable manifests verified. The add-on was verified live at 0.8.1 before the source publication; the fresh MCP exposed 21 tools while Thunderbird was closed.
- Next: Verify the noreply identity on the next GitHub web merge, observe a
  real later-version Thunderbird auto-upgrade, and review an ATN listing
  separately. A live bridge check awaits Thunderbird being open.
- Blocked by: None.
- Updated: 2026-10-01
