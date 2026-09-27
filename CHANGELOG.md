# Changelog

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
