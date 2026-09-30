# Changelog

## 0.8.0 (release candidate)

- Added `fast:true` to message search. It returns Thunderbird's first page
  promptly, skips list-classification header reads and marks incomplete pages
  with a cursor. `get_message` still supplies full headers before an action.
- Added read-only `find_recipients` with bounded Sent history and local contact
  suggestions. Contact access is optional and begins only after a click in
  Thunderbird's Follow-ups popup. Ambiguous addresses are reported for user
  confirmation; no contact-write or send route was added.
- Clarified exact-address versus partial-name matching and compatibility with
  older add-ons.
- Search requests now use the requested page size and avoid prefetching an
  extra page. Recipient lookup shares the single search slot so a slow Sent
  query cannot pile up with mail searches.

## 0.7.1 (release candidate)

- Keeps bridge health responsive when Thunderbird searches or other reads
  stall. Only one search runs at a time so full-text queries cannot occupy
  every ordinary request slot. Busy and timeout responses remain distinct
  from a completed search with no matches.
- Search tool guidance favors narrower account, folder, sender, subject and
  date filters. The signed MCP updater accepts up to three HTTPS redirects
  for release assets while omitting credentials and checking the signature
  and bundle hash.
- Prepares one canonical repository, a tag-only release candidate workflow,
  public listing materials and a local release signing key. External release
  channels remain inactive until publication and review.

## 0.6.0 (unreleased)

- Up to five agent-created compose windows may stay open; twelve opens per
  rolling hour remain the limit. `update_compose_for_review` edits agent text,
  new-mail To/subject and agent-added attachments in a chosen window. It
  refuses to overwrite a window changed by the user.
- New and reply composers accept local files from bounded folders and
  attachments from existing emails. Local bytes use authenticated in-memory
  chunk staging with size, count and expiry limits. The configured signature
  and reply quote remain intact. No send route or new permission was added.
- Tests cover attachment byte fidelity, path and symlink rejection, multiple
  windows, user-edit conflicts, signatures and route-level no-send behavior.
  Manual real-profile compose review remains required after installation.

## 0.5.1 (unreleased)

- Agent-prepared new and reply composers now follow the selected identity's
  HTML or plain-text format. Thunderbird builds its configured signature and
  reply quote first; Draftsafe inserts escaped plain-text input above them.
  Reply drafts saved by `create_draft` use the same approach. New drafts saved
  directly in the background remain plain text and may not gain a signature.
- Updated MCP tool descriptions to tell agents not to duplicate the identity
  sign-off. No send route or new Thunderbird permission was added. Unit tests
  cover HTML signatures, inline logo references, quotes and plain-text mode;
  manual validation in a real profile is still required after installation.

## 0.5.0 (unreleased)

- Added `open_compose_for_review` for plain-text new messages and threaded
  replies. It opens a native Thunderbird composer, returns `sent:false`, and
  requires the user's Send click. One agent-opened window and twelve opens per
  hour are allowed; trust cannot bypass review. Isolated Thunderbird smoke
  confirms that opening does not reach SMTP, while a real Send click does.
- Combined the Bridge and Tools code into one Thunderbird add-on, updating the
  existing Tools ID so local Snooze, Send later and approval history remain.
  The old Bridge must be disabled before installation. The combined manifest
  includes `compose.send` for user-only Send later; SECURITY.md now states the
  resulting code-level, rather than manifest-level, MCP send boundary.
- Removed cross-extension messaging from the release XPI. A local interface
  only creates approval requests and reads status; trusted click decisions
  remain private to the approval manager.
- Made `list_folders_detailed` use folder metadata instead of scanning every
  message for oldest/newest dates. Those fields now return `null`.
- Added `check_connection`, accurate MCP version reporting, and clearer
  read-timeout and one-hour-trust instructions. Smoke uses its own connection
  directory so it cannot overwrite a live Draftsafe connection file.
- Removed the approval window's explicit focus and attention requests after
  reports of Thunderbird pulling focus from another app. The window still
  opens for review; behavior in existing user profiles remains unverified.
- GUI smoke now refuses an interactive desktop session after focus switching
  was reported during an Xvfb run. Standalone Thunderbird 153 passed 55/55
  isolated smoke checks; the live Snap/profile remain untouched.

## 0.4.3 (2026-09-29, not installed live)

- Bounded slow Thunderbird reads and reported a read timeout separately from
  a disconnected bridge. MCP re-reads the connection file on every call.

## 0.4.2 (2026-09-29)

- Trusted unsubscribe requests can obtain HTTPS permission from the starting
  click. Sender lookup prioritizes Trash, Junk, Inbox and Archive and reports
  bounded failure reasons.

## 0.4.0 (2026-09-28)

- Added user-started one-hour trust for eligible approval requests and
  approved moves back to the account's special-use Inbox.

## 0.3.0 (2026-09-28)

- Added relay-only cleanup/trash, unsubscribe and folder-change requests, plus
  detailed folder listing and classification headers. Bridge send/move/delete
  permissions remain absent.
- All existing agent mutations (tags, follow-ups, read flags and drafts) now also
  require approval in Tools. Bridge-only installs provide reads.
- Added one-window review, per-batch decisions, sender/subject grouping, individual
  exclusions, folder-tree previews and local request history. Only trusted UI
  clicks can execute a one-use nonce/hash-bound plan; no approval message API.
- Added 2000-message cap, 10-minute expiry, sender checks, special-folder/ancestor
  protection, same-account depth-two folder rules and execution-time checks.
  Merge membership is frozen before review; empty folders move to Trash.
- Unsubscribe reads URLs from mail headers and uses only approved HTTPS POSTs
  with per-origin optional permissions. Junk senders default off. Manual methods
  never open a URL or send mail. No independent DKIM verification.
- Added property/boundary tests and isolated Thunderbird smoke checks with real
  X11 clicks. Smoke instrumentation is proven absent from both release XPIs.
- Documented the approval protocol, client timeout, partial-failure behavior and
  remaining races/network risks in README and SECURITY.md.

## 0.2.0 (2026-09-28)

Security release after an adversarial review. The single add-on is split in two so
that the AI-facing part holds no permission that can send, move or delete mail.

### Changed

- **Split into two add-ons.** `draftsafe-bridge` (loopback bridge + MCP-facing routes)
  requests only `accountsRead`, `messagesRead`, `messagesUpdate`, `messagesTags`,
  `messagesTagsList`, `messages.save` and `compose.save`: no `compose`,
  `compose.send`, `messages.send`, `messagesMove`, `messagesDelete` or
  `accountsFolders`. `draftsafe-tools` holds Snooze, Send later and Follow-ups and has
  no Experiment API, no listener and no cross-extension messaging.
- **Snooze left the bridge and the MCP server** (`snooze_message` is gone). It is a
  user-only feature in `draftsafe-tools`.
- `set_followup` no longer takes a due date; the AI can only set or clear the tag.
- Reply drafts use `compose.beginReply` details plus a plain-text quote, so the bridge
  needs no `compose` permission.

### Fixed

- Snooze could move mail into a Trash folder named "Snoozed". Destinations are now
  validated by special use and identity immediately before every move; Trash, Junk,
  Outbox, Drafts, Templates and Sent are never sources or destinations.
- Send later trusted mutable storage and message identity. Schedules are now bound to
  the draft's Message-ID, verified Drafts folder, recipients, subject and a SHA-256
  content fingerprint, re-verified before sending; malformed records (e.g. a `NaN`
  send time) and ambiguous matches fail closed.
- A cancelled send could still go out while another send was in flight. Claim and
  cancel now share one serialized state machine.
- The bridge now bounds response writes (15 s write deadline, 4 MiB cap) and in-flight
  operations, and releases a permit only when the work settles.
- Every MCP tool result is wrapped as untrusted mail data, and error texts are fixed
  strings instead of passed-through backend text.
- The connection file is written exclusively to a random temporary name and renamed
  into place, read by the MCP server through one `O_NOFOLLOW` descriptor with owner and
  mode checks, and removed on shutdown only if it still holds this instance's token.
- Found by the first real Thunderbird run (156.0.1 snap): the Experiment could not load
  its framing code (`loadSubScript` refuses `jar:file:` URIs), responses were sometimes
  lost to a TCP reset when the socket closed early (now a lingering close), and the
  connection file was left behind on quit (now removed synchronously).

### Added

- Property tests on the built bridge XPI: exact permission allow-list, API-to-permission
  table cross-checked against Thunderbird's own schemas, a bundle scan for send, move,
  delete and dynamic-code patterns, and a route fuzz with spy send/move/delete functions.
- `npm run smoke`: a real Thunderbird under Xvfb in a throwaway profile, driven through
  the MCP server, with an SMTP trap.

## 0.1.0 (2026-09-28)

- First version: one add-on with a loopback bridge, Snooze, Send later and Follow-ups,
  and a draft-only stdio MCP server. Not released.
