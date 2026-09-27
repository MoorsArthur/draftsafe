# Draftsafe for Thunderbird

**Public name:** Draftsafe (`draftsafe-mcp`). A draft-only MCP server plus two
Thunderbird add-ons that let an AI assistant such as Claude Code work with your local
Thunderbird mail: read, search, tag, track follow-ups and **save drafts**.

> **The AI side of Draftsafe cannot send, move or delete mail.** The add-on it talks to,
> `draftsafe-bridge`, does not hold any Thunderbird permission that allows sending,
> moving or deleting, so even a bug in it, or code that took it over, could not do so
> through the MailExtension APIs. Drafts stay in your Drafts folder until *you* open
> them and press Send.

The repository ships two separate add-ons:

| Add-on | ID | For | Can send? |
| --- | --- | --- | --- |
| **Draftsafe Bridge** | `draftsafe-bridge@draftsafe.dev` | the AI, through the MCP server | **no**: no `compose.send`, `messages.send`, `messagesMove` or `messagesDelete` permission |
| **Draftsafe Tools** | `draftsafe-tools@draftsafe.dev` | you: Snooze, Send later, Follow-ups | yes (Send later), but it has no bridge, no Experiment API, no network listener and no cross-extension messaging |

You can install the bridge alone. The tools add-on is optional.

*Naming: "Thunderbird" is a Mozilla trademark. This project is not affiliated with or
endorsed by Mozilla; per Mozilla's trademark guidance the name does not start with
"Thunderbird" and uses "for Thunderbird" only to describe compatibility.*

## How it works

```
Claude Code ──stdio──> draftsafe-mcp (Node) ──HTTP, 127.0.0.1:<random port>, Bearer token──> Draftsafe Bridge add-on
                             │                                                                       │
                     reads connection.json <── written by the bridge (dir 0700, file 0600) ──────────┘

Draftsafe Tools add-on: menus and buttons for you only. Not reachable from the bridge or the MCP server.
```

1. **Draftsafe Bridge** (`addons/bridge/`, MailExtension, Manifest V2):
   - A tiny **Experiment API** (`addons/bridge/api/`) opens a loopback-only TCP socket on
     a random port, frames HTTP/1.1 requests with hard size and time limits, and hands
     each request to the background page. That is all the privileged code does.
   - The **background page** (`addons/bridge/src/`) checks the Host header, rejects any
     Origin, checks the token, routes the request through a fixed table of 10 endpoints
     and calls standard MailExtension APIs with the bridge's limited permissions.
2. **Draftsafe Tools** (`addons/tools/`): Snooze, Send later and Follow-ups, driven only
   by Thunderbird's own menus, buttons and alarms.
3. **Shared code** (`addons/shared/`): read-only helpers and the "Follow up" tag, packed
   into both add-ons.
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

### 2. The tools add-on (optional)

Same steps with `dist/draftsafe-tools.xpi`. Install it only if you want Snooze, Send
later and Follow-ups. Its permission prompt includes sending mail, which is what Send
later needs.

### 3. The MCP server (Claude Code)

```sh
claude mcp add -s user draftsafe -- node /absolute/path/to/thunderbird-mcp/dist/index.js
```

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
| `list_accounts` | Accounts, identities, folders (ids), available tags | no |
| `search_messages` | Query, folder, from, to, subject, date range, unread, flagged, tag; paginated with a cursor | no |
| `get_message` | Headers, body as plain text (HTML converted), attachment list (never contents) | no |
| `get_thread` | Messages linked by References / In-Reply-To, oldest first, optional bodies | no |
| `list_followups` | Messages tagged "Follow up" with due dates | no |
| `set_followup` | Add or clear the "Follow up" tag | tag |
| `set_tags` | Add/remove existing tags | tags |
| `mark_read` | Read / unread | read flag |
| `create_draft` | New draft or reply draft, **saved to Drafts, never sent** | new draft |

Every tool description tells the model that drafts are never sent and that mail content
is untrusted.

## Security model

**Threats considered:** a web page in any browser trying to reach the local port (CSRF,
DNS rebinding), other local users, a malicious email trying to steer the AI (prompt
injection), and a confused or manipulated AI trying to send or destroy mail.

### The bridge cannot send, move or delete

The guarantee comes from Thunderbird's permission system, not from the bridge's code
being bug-free. `draftsafe-bridge` requests exactly:

| Permission | Grants | Why |
| --- | --- | --- |
| `accountsRead` | accounts, identities, folder list | `list_accounts`, folder lookup |
| `messagesRead` | read messages and headers | search, get, thread |
| `messagesUpdate` | read/unread, flagged, junk flag, tags on a message | `mark_read`, tags |
| `messagesTags`, `messagesTagsList` | list and create tag definitions | `set_tags`, "Follow up" tag |
| `messages.save` | `messages.saveMessage()` only: save a new message as a draft or template in the background | new drafts (Thunderbird 153+) |
| `compose.save` | `compose.saveMessage()` only: save an open compose window as a draft or template | reply drafts, and new drafts on Thunderbird < 153 |

What it does **not** request, and what each would have allowed:

- `compose.send` (`compose.sendMessage`) and `messages.send` (`messages.sendMessage`):
  sending. In Thunderbird 156 the schemas list these as the *only* permissions for the
  two send functions, and `messages.send` is optional-only, so it could never be granted
  silently.
- `compose` (read or change an open compose window, `onBeforeSend`),
  `messagesMove`, `messagesDelete`, `messagesImport`, `accountsFolders` (create, rename,
  delete folders), `messagesModifyPermanent`.
- No `optional_permissions`, no `host_permissions`, no UI entry points, no
  `externally_connectable`.

`compose.beginNew` and `compose.beginReply` need no permission in Thunderbird; they only
open a compose window. The bridge uses `beginReply` for reply drafts (so Thunderbird sets
`In-Reply-To`/`References`), saves the window with `compose.saveMessage({mode: "draft"})`
and closes it. Without `compose.send` that window cannot be sent by the add-on; only a
human clicking Send could.

This is checked on the **built** XPI by `test/bridge-permissions.test.ts`: the manifest's
permission set is compared to an exact allow-list; every MailExtension function the bridge
calls is mapped to the permissions Thunderbird requires for it and cross-checked against
the installed Thunderbird's own API schemas; every file in the bundle is scanned for send,
forward, move, delete, compose-window, XPCOM mail service, cross-extension messaging and
dynamic-code patterns; and every route is fuzzed through the real background page against
a fake Thunderbird whose send, move and delete functions are spies. The smoke test also
reads back the permissions Thunderbird actually granted.

### Transport

- **No send, forward or delete endpoint.** The route table
  (`addons/bridge/src/bridge/routes.js`) and the MCP tool list (`mcp/src/tools.ts`) contain
  only reads and four mutations: tags (incl. follow-up), read/unread and create-draft.
  Unknown endpoints return 404; unknown parameters (such as a smuggled `send: true`) are
  rejected, not ignored.
- **Loopback only.** `nsIServerSocket` with `loopbackOnly`, on a random free port.
- **Bearer token.** 32 random bytes (base64url), new on every start, compared without
  an early exit. Unauthenticated callers learn nothing about routes.
- **Connection file.** Directory `0700`, file `0600`, written to an unpredictable
  temporary name with exclusive create and renamed into place; symlinks are refused. The
  MCP server opens it with `O_NOFOLLOW`, checks owner and mode on the same descriptor it
  reads, and checks the directory's owner and mode.
- **DNS rebinding.** The Host header must be exactly `127.0.0.1:<port>` or
  `localhost:<port>`, otherwise 403.
- **Browsers.** Any request with an `Origin` or `Referer` header is refused, only `POST`
  with `Content-Type: application/json` is accepted (a CORS preflight is always needed
  and always fails), and no CORS headers are ever sent.
- **Resource limits.** Header block 8 KiB, body 256 KiB, 48 headers, one request per
  connection, no chunked encoding or pipelining, duplicate security headers rejected,
  8 connections, 10 s to deliver a request, 90 s handler timeout, 15 s to read the
  response, 4 MiB response cap, and a separate cap on in-flight operations that is only
  released when the underlying work settles.
- **Small privileged surface.** The Experiment (`addons/bridge/api/implementation.js`)
  has no mail access, no JSON handling and no auth logic. It exposes `start`, `stop`,
  `publishConnection(token)` (fixed path, fixed format, token format-checked) and the
  `onRequest` event.
- **Prompt-injection hygiene.** Every tool result (including mutation results that echo
  mailbox data such as tag names or Message-IDs) is returned inside
  `<<<UNTRUSTED_MAIL_DATA nonce>>> … <<<END_UNTRUSTED_MAIL_DATA nonce>>>` with a random
  nonce per result. Error texts are fixed strings written by Draftsafe; backend error
  text is never passed through. Bodies are truncated (default 20 000 characters) and
  attachment contents are never returned. Wrapping lowers the risk; it does not make a
  model immune to instructions in mail.

### The tools add-on

`draftsafe-tools` holds `compose.send` and `messagesMove` because Send later and Snooze
need them. It is isolated from the AI path: no Experiment API, no socket, no
`runtime.onMessageExternal`/`onConnectExternal`, and the tests check this on the built
XPI. Its moves only go to folders validated immediately before the move (see below).

**Not defended against:** anything running as your own user account. It can read the
connection file, your Thunderbird profile, and could install its own add-on.

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
  follow-ups (overdue first, with a badge count) and snoozed messages. The AI can set and
  clear the same tag through the bridge, but not due dates.

## Smoke test

`npm run smoke` (after `npm run build`) starts Thunderbird in a throwaway profile under
`~/snap/thunderbird/common/tmp-draftsafe-*` with `-no-remote` under `xvfb-run -a`,
installs both add-ons plus a test-only seeder, and drives the real MCP server against the
live bridge. It checks listing, search, get, thread, tags, read flags, follow-ups, new and
reply drafts landing in Drafts (with `In-Reply-To`), nothing in Sent or the Outbox, an
SMTP trap that must see no connection, forbidden routes and flags, a transport soak, the
permissions Thunderbird actually granted, and that the connection file is removed on quit.
It refuses to run if a connection file already exists (a real bridge may be running), and
deletes the profile afterwards (`--keep` keeps it). It forces X11 because the snap's
launcher otherwise attaches to your Wayland session.

## Known limitations

- Reply drafts (and all drafts on Thunderbird < 153) briefly open a compose window on
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
