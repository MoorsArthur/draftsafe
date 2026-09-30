# Draftsafe privacy policy

Draftsafe runs on your computer as one Thunderbird add-on and a local MCP
server. The add-on reads message headers, bodies, attachments, accounts and
folders when you use a related tool. The MCP server passes the requested
results to the agent you connected. Your agent provider's handling of those
results is governed by its own privacy policy.

Draftsafe does not operate a mail server, analytics service or telemetry
endpoint. Its bridge listens only on local loopback. It writes a private
connection file containing a short-lived authentication token. It also keeps
local add-on settings, scheduled Send later work, follow-up data, pending
approvals and a bounded history in Thunderbird storage. The MCP updater keeps
version and check status in a private local directory. Draftsafe does not
upload those records to its developer.

Recipient lookup can read the headers of up to three pages of Sent messages
from the last year. If you click **Enable local contacts** in Thunderbird,
Draftsafe may also query your local address books for names and email
addresses. This optional permission covers contact modification at the
Thunderbird manifest level, but Draftsafe exposes no contact-write route and
does not call contact-write APIs. Remote address books are excluded from this
lookup. You can revoke the permission in Add-ons Manager.

The add-on can connect to an external HTTPS address only when you approve a
List-Unsubscribe one-click action. It sends the standardized unsubscribe POST
to the address supplied by the email's sender. This can reveal your IP address
and that the email address is active to that sender. A user-started one-hour
trust session may request broad HTTPS permission for this feature. The grant
can remain in Thunderbird after trust ends; you can revoke it in Add-ons
Manager. Draftsafe does not follow redirects for unsubscribe requests.

Thunderbird checks the public Draftsafe update manifest and XPI over HTTPS
after you install a version with the self-hosted update URL. If you separately
enable MCP automatic updates, its updater requests signed release metadata
and bundles over HTTPS. These requests expose normal network details such as
your IP address to GitHub but do not include mailbox contents or the bridge
token.

Draftsafe's agent tools cannot send email. Agent-prepared compose windows
remain under your control; you review and click Thunderbird's Send button.
The add-on also includes a separate Send later feature that sends a message
you scheduled in Thunderbird. Mailbox changes requested by an agent require
your review click or an eligible user-started trust session.

You can remove Draftsafe and its Thunderbird storage using Add-ons Manager.
The separate MCP update cache is under `~/.local/share/draftsafe-mcp` unless
you use `XDG_DATA_HOME`; deleting it removes staged MCP releases and update
status. Removing Draftsafe does not delete your messages or undo changes you
previously approved.

For security or privacy questions, open an issue in the project's GitHub
repository. Do not include mailbox contents, tokens or credentials in a public
issue.
