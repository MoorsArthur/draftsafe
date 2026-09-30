# Contributing

Draftsafe is a small local MCP server and a Thunderbird MailExtension. Please
open an issue before making broad changes to its approval or permission model.

## Development

Use Node.js 20 or newer and Thunderbird 140 or newer. Run `npm ci`,
`npm run build`, `npm test` and `npm run typecheck`. The build writes one
`dist/draftsafe.xpi` and the stdio server at `dist/index.js`.

The bridge has a fixed route table in `addons/bridge/src/bridge/routes.js`.
Keep agent parameters strict and bounded. Its only local approval interface
can request a plan and read status; it must not expose a decision method.
Native Thunderbird clicks, one-use nonce and plan hash are the execution
boundary. Do not add an MCP send route, a runtime approval message, or a
background shortcut to `compose.sendMessage`.
The `open_compose_for_review` route may open a native composer only. Keep its
strict input validation, edit snapshots and `sent:false` result. Never
turn window opening or one-hour trust into a send decision.

The combined add-on has `compose.send` for the user-only Send later feature.
It also has a privileged Experiment for the loopback socket. Review changes
to `addons/bridge/api`, the manifest and all code paths that can call mail
mutation APIs against [SECURITY.md](SECURITY.md). Avoid claims that the
manifest prevents a compromised combined add-on from sending.

Run `npm run smoke` only from a separate headless session. The runner refuses
an inherited DISPLAY or WAYLAND_DISPLAY because desktop focus switching was
reported during an Xvfb run. It creates a throwaway Thunderbird
profile and a separate smoke connection directory. Do not install the smoke
XPI in a real profile. The release-XPI test checks that the synthetic-click
hook is absent from the real build.

## Pull requests

Keep changes focused. Include a test at the call path for a reproduced bug,
or explain why the behavior cannot be exercised outside Thunderbird. Update
README, SECURITY and CHANGELOG when behavior, permissions or setup changes.
Never include mailbox contents, connection tokens, personal profile files or
credentials in issues, logs or commits.
