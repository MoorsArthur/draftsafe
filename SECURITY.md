# Security model

Draftsafe ships one Thunderbird add-on and one stdio MCP server. The add-on
contains a loopback bridge, approval manager, Snooze, Send later and Follow-ups.
Agent requests reach a fixed route table. Mailbox changes require a Thunderbird
approval click or an active one-hour trust session started by a Thunderbird click.
Draft and follow-up requests still require their own approval click.

## Updates

The add-on and MCP server are separate release artifacts. The current add-on
uses a self-hosted HTTPS update URL and a SHA-256-pinned XPI manifest. It is
not listed or reviewed on Thunderbird Add-ons. The MCP updater
is opt-in and runs outside the mail process. It requires a user-pinned Ed25519
public key, HTTPS metadata with at most three HTTPS redirects, a signed release version and
bundle hash, an exact file allowlist, and lockfile-pinned dependency install
with lifecycle scripts disabled. It receives no bridge token. Failed checks
leave the active server unchanged and the previous version is kept for
rollback. The MCP checks bridge protocol once per Thunderbird connection;
0.6.x without an explicit protocol field is treated as protocol 1.

A malicious signing key holder, compromised dependency pinned by the signed
lockfile, or a compromised add-on build can still run code with the authority
of the respective process. Release signing, source review, isolated smoke
tests and artifact review remain required before publishing an update. A
future Thunderbird Add-ons listing requires that service's review separately.

## Authority and limits

The combined add-on has `compose.send` for its user-only Send later feature,
`messagesMove` and `accountsFolders` for approved mailbox changes, and a
privileged Experiment to host the loopback socket. Thunderbird grants an
Experiment unrestricted internal access. A compromised add-on could therefore
send mail or alter the mailbox. One add-on cannot preserve the former split
manifest boundary that denied send permission to the agent-facing bridge.

The MCP has no send or forward tool, the bridge has no send route, and no bridge
or approval module calls a send API. The only send call in the release XPI is
in `tools/src/features/sendlater.js`, reached from the compose popup and its
timer. These are code and route guarantees against ordinary or malicious MCP
requests, not a sandbox around compromised add-on code. Draft creation saves
to Drafts and never sends. `open_compose_for_review` can fill and open a native
Thunderbird composer, but it has no send parameter or send call. The user must
click Thunderbird's Send button to attempt delivery. `messagesDelete` is absent, so permanent deletion
is not supported. The add-on can move mail to Trash after approval.

Recipient lookup reads at most three pages and 300 Sent headers from the last
year. It can query local contacts only after a user click grants the optional
`addressBooks` permission. Thunderbird's permission also covers contact
mutation, but Draftsafe exposes only a read route and calls no contact-write
API. Remote address books are excluded. Results report ambiguous matches and
bounded-search truncation; the agent must confirm the exact address.

Draftsafe uses the existing `compose` permission to read and update the
generated compose body, and to add, list and remove attachments. Agent text
stays above the identity signature and reply quote. No new Thunderbird
permission or send method was added for this feature.

The compose route accepts a new-message recipient list and subject or a reply
message ID, plus plain-text body and optional attachments. It rejects HTML,
Bcc, raw headers and send flags. New recipients and subject are validated
before a window opens. Replies keep Thunderbird's recipients and threading.
There is no fixed hourly or simultaneous compose count. Updates and closes
address only an agent-created tab and compare its
last confirmed body, fields and attachment list before changing anything. If
the user edits it, the operation fails with a conflict. Only agent-added
attachments may be removed by an agent. Ambiguous window or update results
are not retried automatically and block further agent compose operations
until the add-on restarts. User-started trust cannot send or skip review.
The MCP batch tool prepares 2 to 20 distinct composers through the same
validated open route, one at a time. It reports confirmed tab IDs and a
partial result on failure; it never retries an uncertain open or sends mail.

Local files are accepted only as absolute regular paths below Downloads,
Documents, Desktop or explicitly configured `DRAFTSAFE_ATTACHMENT_ROOTS`.
The MCP process checks canonical containment, refuses symlinks and hidden or
secret-looking names, and checks the open file's identity and size. Existing
mail attachments are fetched by Thunderbird from a message ID and part name.
Up to 100 files, 10 MiB each and 25 MiB total are the limits. Authenticated bridge
staging accepts ordered 128 KiB chunks, reserves at most 25 MiB and expires
after five minutes; bytes are consumed once or discarded. It returns no file
content in MCP results. The user must inspect each attachment before Send.
Thunderbird's native composer remains editable by the user, and the MCP
result never claims that a message was delivered. Other desktop automation
outside Draftsafe could still click Thunderbird's Send button.

The Experiment source is restricted to loopback socket framing and private
connection-file publication. It has no mail operation API. The background
bridge checks the bearer token, Host, Origin, method, content type and fixed
route name before calling standard MailExtension APIs. No external extension
message receiver is packaged. The local bridge interface can only create an
approval request and read its status; it has no decision method.

## Approval and trust

1. Strict schemas validate every request before planning. One slot covers
   planning, the review window and execution. The window opens before slow
   mailbox reads and shows progress. Cleanup and folder merges are capped at
   2,000 messages per request, with at most 10 cleanup batches, 50 folder
   changes, 200 unsubscribe message IDs or 300 senders.
2. The exact request, message identities, destinations and rendered view are
   bound to a random one-use nonce and SHA-256 hash. The nonce never crosses
   the loopback bridge. The background attaches click handlers to its own
   approval page in the exact window it created. It checks `isTrusted`, native
   `MouseEvent` type and page location. Synthetic DOM clicks do not approve.
3. Closing the window or waiting ten minutes denies unfinished work. Allow
   and Deny are per batch or folder change, with per-message exclusions.
   Mailbox names and content render as text. One-time slot consumption
   happens before asynchronous execution, preventing replay.
4. A native Thunderbird menu click or the approval page's secondary trusted
   click starts one-hour trust. It is in memory, expires after 60 minutes,
   and clears on restart or add-on reload. Only eligible cleanup,
   unsubscribe, folder, tag and read-flag requests auto-execute during trust.
   They still pass planning, caps and execution rechecks. Revocation during
   planning denies the queued request. Neither MCP nor runtime messages can
   start or extend trust.
5. MCP gets a request ID promptly, polls short status calls, and may wait up
   to eleven minutes. A client disconnect does not cancel already approved
   work. The approval history is authoritative before retrying.

History stores at most 200 local summaries and outcomes, showing the latest
50. It contains untrusted mailbox metadata and agent reasons, never the nonce.
Interrupted work is not replayed after restart. Requests are not atomic:
partial success is reported and completed moves are not rolled back.

## Mail and folder safeguards

- Trash and Archive are resolved by same-account special use, not a folder
  name. No permanent delete, empty-trash or agent-triggered snooze route exists.
- Move destinations are ordinary same-account folders at depth at most two,
  or the account's dedicated top-level Inbox for restoration. Special-use
  folders, their ancestors, virtual/unified/tag folders and the Snoozed folder
  are protected. Destinations are rechecked immediately before each move.
- Folder create, rename and merge stay within one account and depth two.
  Merge snapshots membership before approval, so new arrivals never enter
  the approved batch. Empty folders are moved recoverably to Trash only after
  checking that they still have no messages or children.
- Message identity and current folder are rechecked before mutation.
  MailExtension APIs offer no transaction or conditional move, so concurrent
  mail clients or servers leave a small check-to-action race.
- Send later binds a scheduled draft to its Message-ID, Drafts folder,
  recipients, subject and content fingerprint. Claim and cancellation share
  one serialized state update. A changed or ambiguous draft fails closed.
  Sends more than twelve hours late and interrupted sends are not retried.

## Unsubscribe network boundary

The add-on reads `List-Unsubscribe` and `List-Unsubscribe-Post` headers from
Thunderbird. MCP request schemas accept message IDs or account-scoped sender
addresses, never URLs. Sender lookup searches Trash, Junk, Inbox and Archive
with deadlines; Gmail All Mail, Important and Starred are skipped. Missing,
timed-out and unreadable senders are shown as skipped. Junk senders default
to Deny.

An approved one-click operation uses the [RFC 8058 POST format](https://www.rfc-editor.org/rfc/rfc8058.html)
for HTTPS targets only, with no cookies, referrer, redirects, GET requests or
mailto sends. The approval click requests the needed optional HTTPS origin;
one-hour trust requests broad HTTPS permission during the starting click.
Denial or a failed permission check prevents POST. The broad grant persists
after trust ends, although trust itself does not.

The add-on does not independently verify DKIM and cannot pin DNS resolution.
A hostile public-looking hostname could resolve to a private address. The
host is displayed for review, and a one-click POST may reveal that a mailbox
address is active. Live unsubscribe requests are mocked in tests.

## Transport and untrusted data

The socket binds `127.0.0.1` on a random port with a new 32-byte bearer token
each startup. Exact Host allowlist, Origin/Referer rejection, JSON POST only,
duplicate-header rejection and no CORS guard the HTTP endpoint. Limits are
8 KiB headers, 256 KiB body, 48 headers, 8 connections, 4 ordinary in-flight
operations, one search and two reserved health checks, 10 seconds to read requests, 4 MiB responses and 15 seconds to
write responses. Reads have an 80-second route budget and a 90-second MCP
deadline. Underlying Thunderbird work may continue after a timeout; its
in-flight permit remains held until it settles.

Connection files use a `0700` directory, a `0600` file, exclusive temporary
creation and rename. MCP checks owner and mode through an `O_NOFOLLOW`
descriptor and re-reads the file on each call. Only the publishing instance
removes its file at shutdown. Multiple profiles sharing one connection path
remain a limitation: the most recent publisher wins. During an upgrade from
the two-add-on release, disable the old Bridge before enabling the combined
add-on so it cannot compete for the connection file.

MCP wraps every result, including approval outcomes, in an untrusted-data
boundary. Errors use fixed public descriptions. This reduces prompt-injection
risk; mailbox text can still influence an agent, so consequential actions
remain gated by Thunderbird approval or the user-started trust window.

## Verification

Tests exercise route allowlists, transport limits, request validation,
approval binding, trusted-click and replay behavior, folder protection,
changed drafts, cancellation races and unsubscribe provenance. Release-XPI
tests verify one manifest, one send call site, no external receiver and no
test-only hook. Real Thunderbird smoke uses Xvfb, a throwaway profile, and
a separate `draftsafe-smoke-mcp` connection directory. It refuses an
interactive desktop session or an existing smoke connection file. The
runner passed 55/55 checks with standalone Thunderbird 153 inside a separate
headless filesystem and display namespace, including native approval clicks,
synthetic-click refusal, no SMTP connection from agent calls, one SMTP
connection after a native Send click to a local rejecting trap, and graceful
shutdown. An earlier interactive Xvfb run was stopped after desktop focus
switching was reported; whether the test window caused it is unconfirmed.
The combined 0.7.0 build is installed in the personal Snap Thunderbird
profile and live `check_connection` reported a healthy bridge. The 0.7.1
release candidate still needs isolated Thunderbird smoke and real-profile
verification before publication.
