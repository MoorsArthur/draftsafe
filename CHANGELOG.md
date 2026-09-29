# Changelog

## 0.4.2 (2026-09-28)

- Added an optional one-hour trust window started by a real Thunderbird menu or
  approval-page click. Eligible requests still validate, reserve one slot and
  recheck their targets before execution. Drafts and follow-ups still require
  an individual review window.
- Added account Inbox restoration for approved moves, plus sender-based
  unsubscribe requests with bounded mailbox searches.
- Kept send and forward unavailable to the MCP and bridge. Send later remains
  a user-only Tools feature.
- Improved startup readiness for the bridge-to-Tools request channel and
  documented the security and installation boundaries.

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
