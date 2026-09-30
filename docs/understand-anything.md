# Explore Draftsafe with Understand Anything

The interactive graph lives at [`.ua/knowledge-graph.json`](../.ua/knowledge-graph.json).
It covers the MCP server, the single Thunderbird add-on, the loopback bridge,
approval flow, composer, tests and packaging. Open it with the Understand
Anything dashboard command `/understand-dashboard` from this repo. You can
also start the version-pinned standalone viewer without opening a browser:

```sh
npx --yes https://github.com/Egonex-AI/Understand-Anything/releases/download/v2.9.0/understand-anything-viewer.tgz . --no-open
```

The viewer prints a local URL with a temporary access token. Open that URL in
your own browser; do not publish it.

The dashboard's guided tour starts at the security boundary and follows an
agent tool call through the local bridge to Thunderbird. The layers group
related files, while imports and other edges show code and runtime links.
The [README](../README.md) has a smaller diagram for a quick first read.

After a verified code change, refresh once from this repo root:

```sh
node .ua/refresh.mjs
```

The command uses the installed Understand Anything plugin's scanner, import
resolver, structural extractor and fingerprint builder. It updates the graph,
metadata and the incremental baseline. Install and build the plugin first if
the command says it is unavailable. The plugin's `autoUpdate` setting also
prompts Claude after commits when its hook is active; the repo's `AGENTS.md`
gives Codex the same refresh step. Neither path runs after every keystroke.
