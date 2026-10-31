# code-artifact

A code-conductor (cc) plugin that lets agents publish versioned, immutable artifacts and hand the user a link to them.

## Functional summary

- Agents publish artifacts of four kinds: markdown documents, static sites, downloadable files, and dynamic apps served behind a path-based proxy.
- Artifacts are versioned and immutable: a published version is never edited in place.
- Publishing returns a deep link, `http://cc.internal/#plugin/code-artifact/...`, that opens the artifact in the cc web UI.

## Status

The implementation is not yet written.

## Development

- Planned stack: Node.js backend, web UI, MCP tools.
- `.wiki/` and `node_modules/` are kept out of git (`.wiki/` via `.git/info/exclude`, `node_modules` via `.gitignore`). `.code-conductor/post-worktree-create.sh` symlinks both from the main checkout into each new worktree.
