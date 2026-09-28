# Security model

Draftsafe separates the AI-facing bridge from the add-on that can move mail.
Every agent-requested mailbox change normally requires a trusted click in a
Thunderbird approval window. A Thunderbird click can start a one-hour trust
session for cleanup, unsubscribe, folder, tag and read-flag requests. Reading needs no click.

## Permission boundary

| Add-on | Permissions and authority |
| --- | --- |
| Bridge | `accountsRead`, `messagesRead`, `messagesUpdate`, `messagesTags`, `messagesTagsList`, `messages.save`, `compose.save`. The existing permission set is unchanged. No `compose`, send, move, delete, folder-management or optional host permission. The route table relays all mutations; it does not execute them. |
| Tools | `accountsRead`, `accountsFolders`, `messagesRead`, `messagesMove`, `messagesUpdate`, `messagesTags`, `messagesTagsList`, `messages.save`, `compose`, `compose.save`, `compose.send`, `alarms`, `menus`, `notifications`, `storage`. `compose.send` serves the existing user-only Send later feature. No Experiment, network listener, `messagesDelete` or external send/snooze endpoint. Optional `https://*/*` lets the approval click request only the needed HTTPS origins. |

The bridge Experiment has full Thunderbird privileges by definition. Its source
is restricted to socket framing and private connection-file publication. The
manifest restriction on MailExtension APIs does not sandbox compromised Experiment
code. Tools is trusted code with mailbox privileges; compromise of Tools itself
or the user's OS account is outside this boundary.

## Request and approval boundary

1. Strict bridge validation permits only the documented fields. The only outbound
   extension message call targets `draftsafe-tools@draftsafe.dev`.
2. Tools checks `sender.id === "draftsafe-bridge@draftsafe.dev"` itself and validates
   again. Its external channel accepts request and status messages only. It never
   routes external messages into its existing user-feature handlers.
3. The popup opens as soon as the slot is reserved, before planning reads message
   identities, recipients for drafts, folder trees and destinations. Unsubscribe
   headers are read four at a time with an eight-second per-message limit;
   unreadable messages are skipped and shown in the review. One slot covers
   planning, the popup and execution. Cleanup and
   folder merges are capped at 2000 messages per request, with at most 10 cleanup
   batches, 50 folder changes, 200 unsubscribe message IDs or 300 senders.
4. The exact request, message identities, destinations and rendered view are
   bound to a random one-use nonce and SHA-256 hash. The nonce never crosses the
   extension boundary. Tools rechecks the hash at execution.
5. The background attaches click handlers to its own approval page in the exact
   window it created. Both `isTrusted` and the page's native `MouseEvent` type are
   checked. The private decision function has no runtime message endpoint.
   `element.click()` and dispatched events cannot approve. The slot is consumed
   before asynchronous execution, so a repeated click cannot replay it.
   A native `menus.onClicked` event or the page's secondary trusted click can
   start an in-memory trust session. No runtime or external message can start
   or extend it. The menu click stops it immediately; a timer ends it 60 minutes
   after the starting click. Restart or add-on reload also clears it. Start and
   end show Thunderbird notifications, and the menu displays minutes remaining.
   Requests arriving during trust still reserve the single slot, validate and
   plan normally, then execute with the same rechecks. Revocation during planning
   denies the queued request. Draft and follow-up requests still open a window.
   History records `approved_trusted` with the original summary and reasons;
   MCP receives `status: approved` plus `trusted: true`.
6. Allow/Deny is per batch or folder change, with per-message exclusions. Reasons,
   sender names, subjects, draft content and folder names are text-only. Folder
   changes show a before/after tree; the preview assumes all displayed changes
   are selected. Unsubscribe destinations from the same sender remain separate.
7. Closing or ten-minute expiry denies unfinished work. There is a 20-second
   cooldown after denial and a 30-request/hour in-memory limit. Tools returns a
   request ID promptly; MCP polls the request status over short HTTP calls for up
   to eleven minutes. HTTP has a twelve-minute backstop. Configure the MCP client's
   tool timeout to at least 730 seconds. A disconnected client does not imply that
   an already-approved action stopped: check history before retrying.

History retains at most 200 local summaries and outcomes, displaying the latest
50. It contains untrusted mailbox metadata and agent reasons, never the approval
nonce. Interrupted work is not replayed after restart. Requests are not atomic:
partial success is reported and already-completed moves are not rolled back.

## Mail and folder safeguards

- Trash always means a move to the same account's unique special-use Trash.
  Archive similarly uses its special-use Archives. No permanent deletion, empty
  trash, automatic sending or agent-triggered snooze exists.
- Move destinations must be ordinary same-account folders at depth at most two,
  or the account's dedicated top-level Inbox for restoration.
  New folder names use the documented letter/digit/punctuation allowlist and
  cannot impersonate special folders. Creation happens only after approval.
- Special-use folders, their ancestors, virtual/unified/tag folders, and the
  Tools Snoozed folder are protected. Descendants of unsafe special folders are
  also refused. Account roots can be selected only as creation parents.
- Folder create, rename and merge stay within one account and depth two.
  Conflicting changes are rejected. Merge snapshots membership before approval:
  new arrivals never enter the approved batch and excluded messages stay put.
- `delete_empty` and empty-source removal after merge recheck both zero messages
  and zero children, then move the empty folder to Trash. They never call
  `folders.delete`. Thunderbird documents that API as requiring
  `messagesDelete`, whereas `folders.move` needs folder-management permission.
  [Thunderbird folders API](https://webextension-api.thunderbird.net/en/mv2/folders.html)
- Message identity, source folder and destination protection are checked again
  immediately before API calls. MailExtension APIs provide no transaction or
  conditional move, so a small check-to-action race with concurrent mail clients
  or servers remains. Operations may fail partway through.

## Unsubscribe network boundary

Tools itself reads `List-Unsubscribe` and `List-Unsubscribe-Post` from the selected
message. Request schemas accept message IDs and reasons or account-scoped sender
addresses, never agent-supplied URLs. Sender lookup queries Inbox, Trash, Archive
and All Mail within Thunderbird, with four workers and a per-sender deadline;
missing, timed-out and unreadable senders are skipped. It requires a HTTPS target and `List-Unsubscribe=One-Click` signalling,
and re-reads provenance before execution. The request follows the
[RFC 8058 POST format](https://www.rfc-editor.org/rfc/rfc8058.html), with no cookies,
no referrer, no redirect following and a 20-second network timeout. It never GETs
an unsubscribe page or sends a mailto message. Website-only/mailto entries are
plain-text manual instructions.

The approval click requests per-origin optional host permission. A trusted
unsubscribe runs without another click, so it can POST only if its per-origin
permission is already granted. Lack of permission returns `permission_denied`;
requested origins are removed after execution.
Senders with requested mail in Junk, or matching mail found in a Junk folder,
default to Deny and display a warning. Excluding the message that supplies the
chosen URL prevents the POST for that destination.

**Limits:** the add-on does not independently verify DKIM, so the header pair is
signalling, not authentication. It rejects IP literals, credentials, nonstandard
ports and obvious local hostnames, but cannot pin DNS resolution. A hostile
public-looking hostname could resolve to a private address. Approval can disclose
that the mailbox address is active. The host is shown for human review. Live
unsubscribe services are not contacted by tests; fetch behavior is mocked.

## Transport and untrusted data

Loopback-only socket, random port and 32-byte bearer token; exact Host allowlist;
Origin/Referer rejected; JSON POST only; duplicate security headers, chunked
encoding and pipelining refused. Limits: 8 KiB headers, 256 KiB body, 48 headers,
8 connections, 4 in-flight operations, 10 seconds to read requests, 4 MiB
responses, 15 seconds to write responses. In-flight permits remain held until
underlying work settles.

Connection files use a 0700 directory, a 0600 file, exclusive temporary creation
and rename. MCP checks owner/mode through an `O_NOFOLLOW` descriptor. The token
changes at startup and only the publishing instance removes its file at shutdown.

All tool results, including approval outcomes and classification fields, pass
through `wrapUntrusted()` with a fresh random boundary. Errors use fixed strings.
Wrapping reduces prompt-injection risk; it cannot make an AI immune to mail text.

## Verification

Release-XPI scans enforce bridge permissions, forbid mail-send/move/delete calls
there, and permit just the constant-target relay call. Tools has one external
request receiver and one unsubscribe fetch site. Tests cover route fuzzing,
sender checks, UI-only execution, binding/replay, expiry, caps, protected folders,
late arrivals, exclusions and unsubscribe provenance. The temporary smoke XPI
adds geometry reporting and an untrusted-click probe. Release builds never
include that hook; tests inspect both builds to prove the separation.

Real Thunderbird smoke uses a fresh `~/snap/thunderbird/common/tmp-draftsafe-*`
profile, `-no-remote` and `xvfb-run -a`; it refuses an existing bridge connection
file. X11 input is sent only to the Xvfb child display, never the user's DISPLAY.
