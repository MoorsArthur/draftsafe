# Source publication gate

Draftsafe's source repository is private during the trial. Public releases in
`draftsafe-updates` contain the signed add-on and MCP bundle, not Git history.

## Commit identity

The maintainer uses `MoorsArthur@users.noreply.github.com` for commits and
annotated tags. `npm run check:privacy` audits every reachable local commit and
tag. CI runs it on pushes, pull requests and release tags with full history.
The repository's `.githooks/pre-push` runs the same check for local pushes.
Install it in a checkout with:

```sh
git config --local core.hooksPath .githooks
```

The check applies only to commits and tags attributed to Arthur Moors, so
outside contributors can choose their own Git identity. A contributor who
wants a private address should configure a GitHub noreply address before
committing. A local hook can be bypassed, and GitHub's web merge identity is
controlled by the account's email settings. The maintainer must keep **Keep my
email addresses private** and **Block command line pushes that expose my email**
enabled under GitHub Settings → Emails. Before merging a PR through GitHub,
verify that the proposed merge commit uses the noreply address. CI should
reject a bad merge commit, but a pending check is no substitute for review.

## Before opening the source

1. Confirm that the maintainer's GitHub profile no longer publicly lists a
   personal address and that a test PR merge uses the noreply address.
2. Run `npm run check:privacy` on a full clone. Audit all source refs, tags,
   release metadata, documentation and built artifacts for credentials,
   private paths and personal data. Review permissions and outgoing network
   behavior before public distribution.
3. Create a **new** public source repository from the audited commits. Keep
   this private repository private. Its old pull-request refs and cached commit
   views may still contain pre-rewrite author metadata even after a force push.
4. Review the public repository and release downloads from a separate account
   before announcing it. Keep signing material out of Git and release assets.

The history rewrite changes commit and annotated tag object IDs. It does not
change release XPI bytes, signed update manifests or the published 0.8.1
downloads. Existing clones must fetch the new refs and reclone or reconcile
their local history; do not merge old commits back into the cleaned repository.

GitHub's [email privacy settings](https://docs.github.com/en/account-and-profile/how-tos/email-preferences/setting-your-commit-email-address),
[push blocking](https://docs.github.com/en/account-and-profile/how-tos/email-preferences/blocking-command-line-pushes-that-expose-your-personal-email-address)
and [history-removal guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)
describe the platform limits behind this gate.
