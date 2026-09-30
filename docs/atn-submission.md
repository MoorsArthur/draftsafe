# Thunderbird Add-ons submission draft

This document is for the first reviewed public listing. No submission has
been made yet.

## Listing

**Name:** Draftsafe

**Short description:** Review agent-prepared Thunderbird mail actions and
compose windows before they happen. Includes Snooze, Send later and Follow-ups.

**Description:** Draftsafe connects a local MCP client to Thunderbird through
one add-on. An agent can search mail and prepare compose windows, drafts,
follow-ups and mailbox changes. You review sensitive changes in Thunderbird.
An agent-prepared message is sent only when you click Thunderbird's Send
button. Separate Thunderbird controls provide Snooze, Send later and
Follow-ups. No account credentials are needed by the MCP server.

**Privacy policy:** [PRIVACY.md](../PRIVACY.md), to be hosted at a stable public
URL before submission.

**Source:** a tagged source archive supplied privately to Thunderbird review
while `MoorsArthur/draftsafe` remains private. The tag must
match the add-on version. `npm ci && npm run build:xpi` with Node.js 20 or newer
builds `dist/draftsafe.xpi`. No minifier or private build dependency is used.
The package-lock file pins JavaScript dependencies.

## Reviewer notes

The manifest includes a privileged `draftsafeBridge` Experiment because a
standard MailExtension cannot host the loopback socket. The Experiment code
in `addons/bridge/api` handles socket framing and private connection-file
publication. Mail routes live in the background page and have a fixed
allowlist. `SECURITY.md` describes authority and safeguards.

`compose.send` is needed by the user-operated Send later feature. The MCP
route table has no send route. Its compose tools open, update and close
native compose windows; the user must click Send. The reviewer can inspect
`addons/tools/src/features/sendlater.js`, the only add-on send call site.

Suggested review with a throwaway mail profile:

1. Install the XPI and enable the local MCP server. Run `check_connection`;
   the add-on version and tools-ready state should appear.
2. Use `search_messages` and `get_message` to inspect synthetic mail. The
   bridge serves only authenticated local requests. `fast:true` returns the
   first page without classification-header reads; follow the cursor to
   completion before concluding there are no matches.
3. Use `find_recipients` before enabling contacts: it should suggest from
   bounded Sent history only. Click **Enable local contacts** in the
   Follow-ups popup and accept Thunderbird's optional permission, then repeat
   the lookup. Only local address books are queried and no contact is changed.
4. Use `open_compose_for_review`, then `update_compose_for_review` with its
   returned tab ID. Inspect the same compose window. No mail is sent until
   the reviewer clicks Send. `close_compose_for_review` closes an unchanged
   agent-prepared window and honors Thunderbird's unsaved-draft behavior.
5. Request a folder or message change. The approval window displays the
   exact planned operation and requires a real Thunderbird click. A synthetic
   click cannot approve it.
6. Use Snooze, Send later and Follow-ups from Thunderbird's own UI. Send later
   sends only an unchanged message that the user scheduled.

The isolated release test (`npm run release:check`) uses a standalone
Thunderbird, Xvfb, a throwaway profile and a rejecting local SMTP trap. It
tests that agent calls make no SMTP connection and that one native Send click
does. It refuses to touch an interactive desktop profile.

The optional HTTPS permission is requested only during approved one-click
unsubscribe handling. The operation uses the email's List-Unsubscribe HTTPS
URL and sends a POST with no cookies or redirects. See `PRIVACY.md` and
`SECURITY.md` for the data flow and limits.
