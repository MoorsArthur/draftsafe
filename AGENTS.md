# Draftsafe agent note

After a verified change to Draftsafe source, APIs or security behavior, run
`node .ua/refresh.mjs` once from the repo root and include the updated `.ua`
graph with the change. This keeps the Understand Anything dashboard current for
Codex as well as Claude. Run it after the change is stable, not after each edit.
