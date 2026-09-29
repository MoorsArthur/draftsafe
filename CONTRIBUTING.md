# Contributing

Draftsafe treats mail as untrusted input and makes mailbox changes only through
the approval flow. Contributions that add a send or forward tool, let the bridge
execute a mailbox change directly, or let an external message approve a request
are outside this project's security model.

## Local setup

Use Node.js 20 or newer:

```sh
npm ci
npm test
npm run build
npm run typecheck
```

The test suite does not need Thunderbird. `npm run build` creates the MCP entry
point and both XPI files in `dist/`. The optional `npm run smoke` command needs
Thunderbird, Xvfb and xautomation. It uses a throwaway profile; read the smoke
script and confirm no other Draftsafe bridge is running before using it.

## Changes to review carefully

- Keep the bridge manifest's permission allowlist and fixed request routes
  narrow. The bridge must not gain send, move, delete or folder-management APIs.
- Keep every agent-requested mutation behind Tools validation and a real click
  or a user-started trust window. Do not add an approval runtime endpoint.
- Treat subjects, senders, bodies, folder names and reasons as untrusted text.
  Keep the MCP result wrapper and text-only UI rendering.
- Add focused tests when changing approval, identity, connection-file or
  permission behavior. Build the XPIs and check the permission tests.
- Use synthetic mail in tests. Never commit connection files, real mailbox
  exports, smoke logs, downloaded attachments or built XPIs.

Open a pull request describing the behavior change and the commands you ran.
For a vulnerability, follow [SECURITY.md](SECURITY.md).
