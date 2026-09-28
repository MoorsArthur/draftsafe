# Draftsafe for Thunderbird

**Draftsafe** (`draftsafe-mcp`) lets an AI assistant read and classify local
Thunderbird mail, then request changes you approve with a real click in Thunderbird.
It never sends mail on an agent's behalf. Even tags, read flags and saved drafts
require your approval.

> **The bridge holds no send, move or delete permission.** It relays requests to
> Draftsafe Tools, which displays one approval window. Review batches, sender groups,
> subjects, destinations and folder-tree previews; allow or deny each batch and
> exclude individual messages. Closing the window or waiting ten minutes denies it.

The repository ships two separate add-ons:

| Add-on | ID | For | Can send? |
| --- | --- | --- | --- |
| **Draftsafe Bridge** | `draftsafe-bridge@draftsafe.dev` | the AI, through the MCP server | **no**: no `compose.send`, `messages.send`, `messagesMove` or `messagesDelete` permission |
| **Draftsafe Tools** | `draftsafe-tools@draftsafe.dev` | you: approvals, history, Snooze, Send later, Follow-ups | yes (user-only Send later); request receiver accepts only the bridge, with no approval API |

The bridge alone supports reads. Install **both add-ons** for any agent-requested change.

*Naming: "Thunderbird" is a Mozilla trademark. This project is not affiliated with or
endorsed by Mozilla; per Mozilla's trademark guidance the name does not start with
"Thunderbird" and uses "for Thunderbird" only to describe compatibility.*

## How it works

```
Claude Code ──stdio──> draftsafe-mcp (Node) ──HTTP, 127.0.0.1:<random port>, Bearer token──> Draftsafe Bridge add-on
                             │                                                                       │
                     reads connection.json <── written by the bridge (dir 0700, file 0600) ──────────┘

Bridge -> runtime.sendMessage -> Draftsafe Tools -> approval window -> your click -> execution
```

1. **Draftsafe Bridge** (`addons/bridge/`, MailExtension, Manifest V2):
   - A tiny **Experiment API** (`addons/bridge/api/`) opens a loopback-only TCP socket on
     a random port, frames HTTP/1.1 requests with hard size and time limits, and hands
     each request to the background page. That is all the privileged code does.
   - The **background page** (`addons/bridge/src/`) checks the Host header, rejects any
     Origin, checks the token, routes the request through a fixed table of read and request endpoints
     and calls standard MailExtension APIs with the bridge's limited permissions.
2. **Draftsafe Tools** (`addons/tools/`): trusted-click approval, request history and
   existing Snooze, Send later and Follow-ups features.
3. **Shared code** (`addons/shared/`): strict validation, mail operations and helpers.
   The bridge exposes only reads and approval relays; Tools executes approved actions.
4. **MCP server** (`mcp/src/`, TypeScript, stdio): finds and validates the connection
   file, calls the bridge and wraps every result as untrusted data.

## Requirements

- Thunderbird **140 ESR or newer**. Smoke-tested on Thunderbird **156.0.1 (snap)**.
  Background draft saving (`messages.saveMessage`) needs 153+ and is feature-detected.
  Linux (deb, snap, flatpak), macOS and Windows paths are supported; only Linux has been
  exercised.
- Node.js **20+** for the MCP server.

## Build and test

```sh
npm ci
npm run build      # dist/index.js (MCP) + dist/draftsafe-bridge.xpi + dist/draftsafe-tools.xpi
npm test           # unit, property and loopback tests (no Thunderbird needed)
npm run typecheck
npm run smoke      # real Thunderbird in a throwaway profile under Xvfb (see below)
```

## Install

### 1. The bridge add-on (required)

In Thunderbird: **Tools → Add-ons and Themes → gear icon → Install Add-on From File…**
and pick `dist/draftsafe-bridge.xpi`. Thunderbird accepts unsigned add-ons and add-ons
with Experiment APIs, so no configuration change is needed. The permission prompt lists
the Experiment as "full, unrestricted access to Thunderbird" because Experiments are
privileged by nature; see the security model for what this one actually does.

### 2. The tools add-on (required for approvals)

Same steps with `dist/draftsafe-tools.xpi`. Its sending permission is for the existing
user-only Send later feature. The bridge cannot invoke it. Unsubscribe approval may
request an optional HTTPS host permission for the displayed destination.

### 3. The MCP server (Claude Code)

```sh
claude mcp add -s user draftsafe -- node /absolute/path/to/thunderbird-mcp/dist/index.js
```

Configure your MCP client to allow a **730-second tool timeout** for approval requests.
Shorter client deadlines do not cancel a Thunderbird request; check its history before retrying.
The approval window opens while Draftsafe prepares the plan and shows progress for
unsubscribe message reads. Draftsafe then polls for the decision over short requests.
The window requests focus and attention, but GNOME Wayland may prevent an add-on
from switching workspaces or raising it above the active application. If it does
not appear in front, check Thunderbird's windows and the activity overview.

After Thunderbird starts, the bridge writes the connection file:

| Thunderbird install | Connection file |
| --- | --- |
| Snap | `~/snap/thunderbird/common/draftsafe-mcp/connection.json` |
| deb, tarball, distro package | `${XDG_STATE_HOME:-~/.local/state}/draftsafe-mcp/connection.json` |
| Flatpak | `~/.var/app/org.mozilla.Thunderbird/.local/state/draftsafe-mcp/connection.json` |
| macOS | `~/Library/Application Support/draftsafe-mcp/connection.json` |
| Windows | `%LOCALAPPDATA%\draftsafe-mcp\connection.json` |

Why these paths: a snap can only write inside its own area, and its `HOME` and XDG
variables point at a *per-revision* directory (`~/snap/thunderbird/<rev>/`) that changes
on every snap refresh. `$SNAP_USER_COMMON` (`~/snap/thunderbird/common`) is writable by
the snap, survives refreshes, and is readable by an unconfined Node process. The bridge
checks `SNAP_USER_COMMON` first; the MCP server checks the candidates above and uses the
newest file. Override with `DRAFTSAFE_CONNECTION_FILE=/path/to/connection.json`.

The file holds `{version, port, token}`. It gets a fresh random token and port on every
Thunderbird start and is removed on shutdown, but only if it still holds this instance's
token.

## Tools

| Tool | What it does | Mutates |
| --- | --- | --- |
| `request_cleanup` / `request_trash` | Propose trash, archive or move batches; waits for your click | approved moves only |
| `request_unsubscribe` | Header-derived one-click HTTPS POST; manual links are never opened | approved POST only |
| `request_folder_changes` | Create, rename, merge or remove an empty user folder, with tree preview | approved folder changes only |
| `list_folders_detailed` | IDs, path, special use, counts, unread, oldest/newest, subfolders | no |
| `list_accounts` | Accounts, identities, folders (ids), available tags | no |
| `search_messages` | Query, folder, from, to, subject, date range, unread, flagged, tag; paginated with a cursor | no |
| `get_message` | Headers, body as plain text (HTML converted), attachment list (never contents) | no |
| `get_thread` | Messages linked by References / In-Reply-To, oldest first, optional bodies | no |
| `list_followups` | Messages tagged "Follow up" with due dates | no |
| `set_followup` | Add or clear the "Follow up" tag | approved tag |
| `set_tags` | Add/remove existing tags | approved tags |
| `mark_read` | Read / unread | approved read flag |
| `create_draft` | New draft or reply draft, **saved to Drafts, never sent** | approved new draft |

Every tool description tells the model that drafts are never sent and that mail content
is untrusted.

## Approval requests

```json
{"batches":[{"message_ids":[123,124],"action":"move","folder":"Clients/Acme","create_folder":true,"reason":"Project correspondence"}]}
```

`request_cleanup` and its alias `request_trash` accept the same schema. Actions are
`trash`, `archive`, or `move`; `folder` is an account-relative path and
`create_folder` is allowed only for `move`. Trash/Archive always resolve to the
account's special-use folder. The whole request is limited to 2000 messages.

```json
{"items":[{"message_id":123,"reason":"No longer needed"}]}
```

`request_unsubscribe` never accepts a URL. Tools reads both unsubscribe headers
itself. Only approved one-click HTTPS POSTs run; other methods stay manual.
Junk senders default to Deny. The add-on does not authenticate the sender or DKIM.

Alternatively, provide up to 300 sender addresses with their account IDs:

```json
{"senders":[{"account_id":"account1","address":"news@example.test"}]}
```

Tools searches matching mail in that account's Inbox, Trash, Archive and All Mail
folders, newest first, and uses the first message with a List-Unsubscribe header.
Senders with no matching header, unreadable mail or a search timeout are skipped.

```json
{"changes":[{"action":"create","folder":"account1://","new_name":"Clients"}]}
```

For folder requests, use IDs returned by `list_folders_detailed`. `create` uses
`folder` as the parent and requires `new_name`; `rename` also requires `new_name`;
`merge` requires `into`; `delete_empty` requires neither. Create/rename/merge stay
in one account and within two levels. Special folders and their ancestors are
protected. Removed empty folders move recoverably to Trash. Names allow letters,
digits, spaces and `_ . , & ( ) + ' -`, up to 64 characters, starting with a letter
or digit; special-folder names and trailing spaces are refused.

All request results include a status such as `approved`, `denied`, `expired`,
`closed`, `refused` or `failed`, plus per-batch outcomes. Approval is not a guarantee
of successful execution; concurrent mailbox changes can cause refusals or partial
results. New messages arriving during review are never added to a merge batch.
History is available from the Tools toolbar popup and the approval page.

## Security model

Read [SECURITY.md](SECURITY.md) for the full threat model, permission tables, trusted
click boundary, transport limits, unsubscribe provenance and remaining risks.
The bridge's manifest still excludes send, move, delete and folder-management
permissions. Its sole extension-message target is Draftsafe Tools. Neither the
external channel nor internal runtime messages can approve a request.

All results are wrapped as untrusted data, including classification metadata:
`hasListUnsubscribe`, `listId`, `precedence` and `fromDomain` in message summaries.
Mail content, folder names and agent reasons are rendered only as text in the UI.

## User features (Draftsafe Tools)

- **Snooze**: message list context menu *Snooze* (Later today, Tomorrow 08:00, Next
  Monday 08:00, Pick a date and time…) and a *Snooze* button in the message view. The
  message moves to a `Snoozed` folder in its account; every minute (and at startup) due
  messages go back to the Inbox, marked unread. Before every move the destination is
  re-validated: `Snoozed` must be a plain top-level folder with no special use (a Trash
  folder that happens to be called "Snoozed" is refused), and the Inbox is found by its
  special use, never by name. Messages in Trash, Junk, Outbox, Drafts, Templates or Sent
  are never snoozed.
- **Send later**: a *Send later* button in the compose window. It saves the message as a
  draft, closes the window, and records the draft's Message-ID, Drafts folder,
  recipients, subject and a SHA-256 fingerprint of its content. At the due time the draft
  must be the only message with that Message-ID in a verified Drafts folder, its
  fingerprint and the reopened window's recipients and subject must match, and the record
  is claimed atomically; any mismatch fails closed and notifies you. Cancel and claim run
  in one serialized state machine, so a cancelled send can never go out. After sending,
  the draft is moved to Trash. If Thunderbird was closed for more than 12 hours past the
  due time it does **not** send; a send interrupted by a crash is never retried.
- **Follow up**: context menu *Follow up* (no due date, tomorrow, next Monday, custom,
  mark as done) adds a "Follow up" tag; the *Follow-ups* toolbar button lists open
  follow-ups (overdue first, with a badge count) and snoozed messages. The AI can request setting or
  clearing the same tag through approval, but not due dates.

## Smoke test

`npm run smoke` (after `npm run build`; needs `xvfb-run` and `xte` from the
`xautomation` package) starts Thunderbird in a throwaway profile under
`~/snap/thunderbird/common/tmp-draftsafe-*` with `-no-remote` under `xvfb-run -a`,
installs both add-ons plus a test-only seeder, and drives the real MCP server against the
live bridge. It checks listing, search, classification, thread, approved tags/read flags/follow-ups,
new and reply drafts, deny-with-no-change, real-click trash/move, folder creation
and merge, forbidden destinations, transport and granted permissions. A synthetic
DOM click must do nothing. An SMTP trap must see no connection. The test-only Tools
XPI reports button coordinates; the runner sends real pointer clicks only to its
Xvfb child display. The release XPIs do not contain this hook.

It refuses an existing connection file, forces X11 with Wayland disabled, quits
its own Thunderbird instance gracefully and deletes the temporary profile
(`--keep` retains it). Never install the test XPI in your real profile.

## Known limitations

- After approval, reply drafts (and all drafts on Thunderbird < 153) briefly open a compose window on
  your screen that closes itself after saving. New drafts on 153+ are saved in the
  background.
- Send later reopens the draft in a compose window at send time.
- Message ids are Thunderbird's session ids: they change after a restart or a move.
- `search_messages` results are not globally sorted by date.
- `get_thread` finds replies through subject search within the same account plus header
  links; very long or renamed threads may be incomplete.
- Snooze relies on Thunderbird running; overdue snoozes are woken at the next start.
- Several Thunderbird profiles running the bridge at once share one connection file; the
  most recently started one wins.
- The Experiment runs with full privileges. Its code is small and has no mail access, but
  Thunderbird's permission system does not confine an Experiment's own code.

## Prior art

Inspired by, but not copied from: [TKasperczyk/thunderbird-mcp](https://github.com/TKasperczyk/thunderbird-mcp)
(MIT, bundles MPL-2.0 `httpd.sys.mjs`) and [U-C4N/Thunderbird-MCP](https://github.com/U-C4N/Thunderbird-MCP)
(MIT). Both can send mail behind an opt-out; Draftsafe removes the capability instead. No
code from either project is included; the HTTP framing is written from scratch rather than
using the MPL-licensed `httpd.sys.mjs`.

## License

MIT, see [LICENSE](LICENSE).
