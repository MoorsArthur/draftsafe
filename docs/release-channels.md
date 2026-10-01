# Release channels

`MoorsArthur/draftsafe` remains the private source repository. The public
`MoorsArthur/draftsafe-updates` repository distributes only versioned XPI and
MCP bundles, checksums and update metadata. Those bundles contain readable
code even though the full source history stays private. The old local
`thunderbird-mcp` checkout is a historical backup.

## Thunderbird add-on

The `draftsafe-tools@armain.be` add-on has a self-hosted `update_url` pointing
to the stable HTTPS `thunderbird-updates.json` file in the public distribution
repository. Version 0.8.1 is the first published artifact. `npm run build:thunderbird-update` copies the built XPI to a
versioned filename and writes the add-on ID, version, exact release asset URL
and SHA-256 hash into that manifest. Keep the public URL stable: installed
copies depend on it. The already-installed 0.7.0 XPI has no self-hosted URL,
so it must be updated once by hand to enter this channel. The maintainer's
profile has completed that step and reports add-on 0.8.1 with the expected
update URL. Later releases can be picked up by Thunderbird's normal add-on
update checks; an actual old-to-new automatic upgrade awaits a later release.

The [ATN submission draft](atn-submission.md) is for a future public listing.
The current private-source trial is self-distributed and has not been reviewed
or listed by Thunderbird Add-ons. A later move to ATN needs a tested channel
transition; do not publish competing versions under this ID.

## MCP server

The pinned Ed25519 [public key](../updates/public-key.txt) identifies the MCP
release signer. Its private counterpart is stored locally in
`~/.config/secrets/draftsafe-release-0.8.0.env` with mode 0600. Never commit,
upload or print it. `npm run sign:update` accepts its file path through
`DRAFTSAFE_RELEASE_KEY_FILE` and the exact versioned public asset URL through
`DRAFTSAFE_RELEASE_BUNDLE_URL`. It signs the version, URL and SHA-256 of the
already-reviewed bundle. The stable metadata URL is:

`https://raw.githubusercontent.com/MoorsArthur/draftsafe-updates/main/update-manifest.json`

The launcher checks that URL only when `DRAFTSAFE_AUTO_UPDATE=1`. Codex and
Claude Code's maintainer registrations now set this option. It follows
at most three HTTPS redirects, checks the signature and bundle hash, and
stages a newer server for the next MCP start. It sends no GitHub credential,
bridge token or mailbox content. A bad or offline check leaves the current
server running; `--rollback` restores the previous version.

## Publication order

1. Run `npm run release:check` with a standalone Thunderbird binary. Review
   source, privacy copy, smoke report and public artifacts.
2. Publish a version tag from the private source commit and compare the tag
   workflow's candidate hashes with the locally reviewed XPI, MCP bundle and
   Thunderbird manifest. The workflow never publishes automatically.
3. Sign the MCP bundle's exact public release URL and verify the signature
   with the pinned public key. Publish the versioned XPI and MCP bundle with
   their checksums and smoke report in the public distribution repository.
4. Publish `update-manifest.json` and `thunderbird-updates.json` in that
   repository after the versioned assets exist. Fetch all three URLs without
   credentials and check exact hashes, ID, version and signature.
5. Enable the MCP updater in active clients, back up the live Thunderbird
   profile, install the XPI once, restart and verify bridge health. Confirm
   the installed update URL. Test a real old-to-new Thunderbird update when a
   later version exists before claiming that behavior has been observed.

The 0.8.1 tag workflow passed its isolated Thunderbird smoke gate. The public
release files matched its candidate hashes, both stable manifests were fetched
without credentials, the MCP signature and bundle hash verified, and a fresh
live MCP process reported 21 tools and add-on 0.8.1. The public distribution
repository exposes the bundles to everyone. The private source repository and
its commit history remain accessible only to authorized collaborators.
