# Release channels

The GitHub-connected `MoorsArthur/draftsafe` repository is the source of truth.
The old local `thunderbird-mcp` checkout is a historical backup. MCP clients
launch `scripts/launch.mjs` from this repository. Neither channel is live
until the public release and Thunderbird review steps below complete.

## Thunderbird add-on

Publish `dist/draftsafe.xpi` as a new version of the existing
`draftsafe-tools@armain.be` add-on on addons.thunderbird.net. Keep that ID and
do not put a self-hosted `update_url` in the ATN-bound manifest. The
[submission draft](atn-submission.md), [privacy policy](../PRIVACY.md), source
tag and isolated smoke report accompany the submission. Thunderbird reviews
the privileged Experiment and mail permissions. The listed channel can update
installed copies only after review and approval.

## MCP server

The pinned Ed25519 [public key](../updates/public-key.txt) identifies the MCP
release signer. Its private counterpart is stored locally in
`~/.config/secrets/draftsafe-release-0.8.0.env` with mode 0600 and must never be
committed, uploaded or printed. A future release operator supplies that key
to `npm run sign:update` through `DRAFTSAFE_RELEASE_PRIVATE_KEY` and sets
`DRAFTSAFE_RELEASE_BUNDLE_URL` to the exact versioned GitHub release asset.

For version `X.Y.Z`, a release contains:

- `draftsafe.xpi`
- `draftsafe-mcp-X.Y.Z.json`
- `update-manifest.json`, signed over the version, versioned bundle URL and
  SHA-256 hash
- `SHA256SUMS` and `smoke-report.json`

The metadata URL used by installed launchers is
`https://github.com/MoorsArthur/draftsafe/releases/latest/download/update-manifest.json`.
The signed metadata points to a versioned bundle URL, so a new latest release
updates the feed without changing client configuration. Both downloads allow
at most three HTTPS redirects; the bundle is checked against the signed hash.
If a check fails, the active MCP server keeps running. An update is staged for
the next MCP launch, and `--rollback` restores the previous version.

## Publication checklist

1. Review the exact source diff, history audit, privacy copy and signer public
   key. Build and run `npm run release:check` with standalone Thunderbird in a
   separate headless session.
2. Create and push a matching `vX.Y.Z` tag only after authorizing a release.
   The tag workflow runs the same isolated gate and uploads candidate
   artifacts; it never publishes them automatically.
3. Compare candidate hashes to the locally reviewed artifacts. Sign the exact
   release bundle, verify the signature with the pinned public key, then
   publish the GitHub release assets and make the repository public with the
   owner's approval.
4. Fetch the public metadata and bundle without credentials and verify the
   staged update in a throwaway MCP data directory. Only then enable
   `DRAFTSAFE_AUTO_UPDATE=1` for active MCP clients.
5. Submit the XPI to Thunderbird Add-ons with the reviewer materials. Wait for
   approval. Verify an old-to-new update in a throwaway Thunderbird profile
   before calling add-on auto-updates active.

Do not confuse a built candidate, a published GitHub release and an approved
Thunderbird listing. They are separate states.
