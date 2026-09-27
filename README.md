# Draftsafe for Thunderbird

**Public name:** Draftsafe (`draftsafe-mcp`). A draft-only MCP server and companion
add-on that let an AI assistant such as Claude Code work with your local Thunderbird
mail: read, search, tag, snooze, track follow-ups and **save drafts**.

> **Draftsafe never sends mail.** No MCP tool and no bridge endpoint can send, forward,
> reply-and-send or delete a message. Drafts are saved to your Drafts folder and stay
> there until *you* open them and press Send in Thunderbird. This is enforced by the
> code's shape (the capability does not exist), not by a setting.

The add-on also adds three everyday features for you, the human user: **Snooze**,
**Send later** and **Follow up**. Send later is the only code in the add-on that sends
mail, it only runs after you click it in a compose window, and it is unreachable from
the bridge (a test enforces this).

*Naming: "Thunderbird" is a Mozilla trademark. This project is not affiliated with or
endorsed by Mozilla; per Mozilla's trademark guidance the name does not start with
"Thunderbird" and uses "for Thunderbird" only to describe compatibility.*

## How it works

```
Claude Code ──stdio──> draftsafe-mcp (Node) ──HTTP, 127.0.0.1:<random port>, Bearer token──> Draftsafe add-on
                             │                                                                   │
                     reads connection.json <── written by the add-on (dir 0700, file 0600) ──────┘
```

1. **Add-on** (`addon/`, MailExtension, Manifest V2):
   - A tiny **Experiment API** (`addon/api/bridge/`) opens a loopback-only TCP socket on a
     random port, frames HTTP/1.1 requests with hard size and time limits, and hands each
     request to the background page. That is all the privileged code does.
   - The **background page** (`addon/src/`) checks the Host header, rejects any Origin,
     checks the token in constant time, routes the request through a fixed table of
     11 endpoints and calls standard MailExtension APIs.
2. **MCP server** (`mcp/src/`, TypeScript, stdio): finds and validates the connection
   file, calls the bridge and wraps all mail content as untrusted data.

## Requirements

- Thunderbird **140 ESR or newer** (built against the 153 ESR and 156 release API
  schemas; features that need 153+ are feature-detected, see below). Linux (deb, snap,
  flatpak), macOS and Windows paths are supported; only Linux has been exercised in tests.
- Node.js **20+** for the MCP server.

## Build

```sh
npm ci
npm run build      # dist/index.js (MCP server) + dist/draftsafe-mcp.xpi (add-on)
npm test           # unit + loopback integration tests (no Thunderbird needed)
```

## Install

### 1. The add-on

In Thunderbird: **Tools → Add-ons and Themes → gear icon → Install Add-on From File…**
and pick `dist/draftsafe-mcp.xpi`. Thunderbird accepts unsigned add-ons and add-ons with
Experiment APIs, so no configuration change is needed. Thunderbird shows the
permission list; the Experiment entry means "full, unrestricted access to Thunderbird"
because Experiments are privileged by nature (see the security model for what this one
actually does).

After installing, the add-on starts the bridge and writes the connection file:

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
the snap, survives refreshes, and is readable by an unconfined Node process. The add-on
checks `SNAP_USER_COMMON` first; the MCP server checks the candidates above and uses the
newest file. Override with `DRAFTSAFE_CONNECTION_FILE=/path/to/connection.json`.

The file holds `{version, port, token}`, is rewritten with a fresh random token and port
on every Thunderbird start and is removed on shutdown.

### 2. The MCP server (Claude Code)

```sh
claude mcp add -s user draftsafe -- node /absolute/path/to/thunderbird-mcp/dist/index.js
```

## Tools

| Tool | What it does | Mutates |
| --- | --- | --- |
| `list_accounts` | Accounts, identities, folders (ids), available tags | no |
| `search_messages` | Query, folder, from, to, subject, date range, unread, flagged, tag; paginated with a cursor | no |
| `get_message` | Headers, body as plain text (HTML converted), attachment list (never contents) | no |
| `get_thread` | Messages linked by References / In-Reply-To, oldest first, optional bodies | no |
| `list_followups` | Messages tagged "Follow up" with due dates | no |
| `set_followup` | Add or clear the "Follow up" tag and an optional due date | tag |
| `snooze_message` | Move to "Snoozed", back to Inbox (unread) when due | move to/from Snoozed |
| `set_tags` | Add/remove existing tags | tags |
| `mark_read` | Read / unread | read flag |
| `create_draft` | New draft or reply draft, **saved to Drafts, never sent** | new draft |

Every tool description tells the model that drafts are never sent and that mail content
is untrusted.

## Security model

**Threats considered:** a web page in any browser trying to reach the local port (CSRF,
DNS rebinding), other local users, a malicious email trying to steer the AI
(prompt injection), and a confused or manipulated AI trying to send or destroy mail.

- **No send, forward or delete capability.** The bridge route table
  (`addon/src/bridge/routes.js`) and the MCP tool list (`mcp/src/tools.ts`) contain only
  read operations and four mutations: tags (incl. follow-up), read/unread, snooze, and
  create-draft. Unknown endpoints return 404; unknown parameters (e.g. a smuggled
  `send: true`) are rejected, not ignored. Tests assert this four ways: declared names,
  a source scan for send/forward/delete APIs, an import-graph check that the send-later
  module is unreachable from the bridge, and a run of every route against a fake
  Thunderbird whose send/forward/delete functions are spies that must never be called.
- **Loopback only.** The server socket is bound to `127.0.0.1` (`nsIServerSocket`
  `loopbackOnly`), on a random free port.
- **Bearer token.** 32 random bytes (base64url) from `crypto.getRandomValues`, new on every
  start, compared in constant time. Unauthenticated callers learn nothing about routes.
- **Connection file.** Directory `0700`, file `0600`, written atomically. The MCP server
  refuses the file if it is group/world-readable or owned by another user.
- **DNS rebinding.** The Host header must be exactly `127.0.0.1:<port>` or
  `localhost:<port>`, otherwise 403.
- **Browsers.** Any request with an `Origin` or `Referer` header is refused, only `POST`
  with `Content-Type: application/json` is accepted (so a CORS preflight is always
  needed and always fails), and no CORS headers are ever sent.
- **Resource limits.** Header block 8 KiB, body 256 KiB, 48 headers, one request per
  connection, no chunked encoding, no pipelining, duplicate security headers rejected,
  8 concurrent connections, 10 s to deliver a request, 90 s handler timeout.
- **Small privileged surface.** The Experiment (`addon/api/bridge/implementation.js`)
  has no mail access, no JSON handling and no auth logic. It exposes `start`, `stop`,
  `publishConnection(token)` (fixed path, fixed format, token format-checked) and the
  `onRequest` event. Everything else runs in the normal, permission-limited extension
  context.
- **Prompt-injection hygiene.** Mail-derived output is returned inside
  `<<<UNTRUSTED_MAIL_DATA nonce>>> … <<<END_UNTRUSTED_MAIL_DATA nonce>>>` with a random
  nonce per result and a notice to treat it as data. Bodies are truncated (default 20 000
  characters); attachment contents are never returned.

Anything running as your own user account can read the connection file, as it could read
your Thunderbird profile directly; Draftsafe does not try to defend against that.

## User features

- **Snooze**: message list context menu *Snooze* (Later today, Tomorrow 08:00, Next
  Monday 08:00, Pick a date and time…) and a *Snooze* button in the message view. The
  message moves to a `Snoozed` folder in its account; every minute (and at startup) due
  messages go back to the Inbox, marked unread.
- **Send later**: a *Send later* button in the compose window. It saves the message as a
  draft, closes the window, and at the chosen time reopens the draft and sends it; the
  draft is then moved to Trash. If Thunderbird was closed for more than 12 hours past the
  due time it does **not** send, it notifies you and leaves the draft. A send interrupted by
  a crash is never retried automatically.
- **Follow up**: context menu *Follow up* (no due date, tomorrow, next Monday, custom,
  mark as done) adds a "Follow up" tag; the *Follow-ups* toolbar button lists open
  follow-ups (overdue first, with a badge count) and snoozed messages.

## Known limitations

- Not yet run inside a real Thunderbird: the tests cover everything except the XPCOM
  socket glue in `implementation.js`, which is exercised through a Node stand-in that
  uses the same framing code. First real-world check: install into a **test profile**.
- Reply drafts (and all drafts on Thunderbird < 153) briefly open a compose window that
  closes itself after saving. New drafts on 153+ are saved in the background.
- Send later reopens the draft in a compose window at send time.
- Message ids are Thunderbird's session ids: they change after a restart or a move.
- `search_messages` results are not globally sorted by date.
- `get_thread` finds replies through subject search within the same account plus header
  links; very long or renamed threads may be incomplete.
- Snooze relies on Thunderbird running; overdue snoozes are woken at the next start.
- The snap confinement is expected to allow a loopback listener (the snap has the
  `network` plug), but this has not been verified on a snap yet.
- Several Thunderbird profiles running at once would overwrite each other's connection
  file.

## Prior art

Inspired by, but not copied from: [TKasperczyk/thunderbird-mcp](https://github.com/TKasperczyk/thunderbird-mcp)
(MIT, bundles MPL-2.0 `httpd.sys.mjs`) and [U-C4N/Thunderbird-MCP](https://github.com/U-C4N/Thunderbird-MCP)
(MIT). Both can send mail behind an opt-out; Draftsafe removes the capability instead. No
code from either project is included; the HTTP framing is written from scratch rather than
using the MPL-licensed `httpd.sys.mjs`.

## License

MIT, see [LICENSE](LICENSE).
