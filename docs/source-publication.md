# Source publication and commit identity

`MoorsArthur/draftsafe` is the public source repository. The separate
`draftsafe-updates` repository serves signed add-on and MCP downloads at the
stable URLs already used by installed copies.

## Commit identity

The maintainer uses `MoorsArthur@users.noreply.github.com` for commits and
annotated tags. `npm run check:privacy` audits every reachable local commit and
tag. CI runs it on pushes, pull requests and release tags with full history.
The repository's `.githooks/pre-push` runs the same check for local pushes.
Install it in a checkout with:

```sh
git config --local core.hooksPath "$(pwd)/.githooks"
```

The check applies only to commits and tags attributed to Arthur Moors, so
outside contributors can choose their own Git identity. A contributor who
wants a private address should configure a GitHub noreply address before
committing. The public source's `main` branch requires the `verify` CI check
for its owner and rejects force pushes. A local hook can be bypassed, and
GitHub's web merge identity is controlled by the account's email settings.
The maintainer must keep **Keep my
email addresses private** and **Block command line pushes that expose my email**
enabled under GitHub Settings → Emails. Before merging a PR through GitHub,
verify that the proposed merge commit uses the noreply address. CI should
reject a bad merge commit, but a pending check is no substitute for review.

## How this source was published

The public repository was created with only audited `main`, `v0.8.0` and
`v0.8.1` refs. The former development repository is a separate private
archive. Its old pull-request refs and cached commit views may still contain
pre-rewrite author metadata, so do not change that archive's visibility or
merge obsolete branches from it into the public repository.

Before each public release, run `npm run check:privacy` on a full clone and
audit source refs, tags, release metadata, documentation and built artifacts
for credentials, private paths and personal data. Review permissions and
outgoing network behavior. Keep signing material out of Git and release
assets. Verify the public downloads and metadata anonymously.

The pre-publication history rewrite changed commit and annotated tag object
IDs. It did not change release XPI bytes, signed update manifests or the
published 0.8.1 downloads. Old private clones must not push their refs to
this public repository.

GitHub's [email privacy settings](https://docs.github.com/en/account-and-profile/how-tos/email-preferences/setting-your-commit-email-address),
[push blocking](https://docs.github.com/en/account-and-profile/how-tos/email-preferences/blocking-command-line-pushes-that-expose-your-personal-email-address)
and [history-removal guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)
describe the platform limits behind this gate.
