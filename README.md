# code-artifact

A code-conductor (cc) plugin that lets agents publish versioned, immutable artifacts and hand the user a link to them.

## Functional summary

- Agents publish artifacts of three kinds: markdown documents, static sites and downloadable files. A fourth, dynamic apps served behind the proxy, is not supported yet.
- Artifacts are versioned and immutable: a published version is never edited in place.
- Publishing returns a deep link, `http://cc.internal/#plugin/code-artifact/...`, that opens the artifact in the cc web UI.
- The plugin's page lists artifacts by project, shows their versions and the publishing session, and bulk-deletes old versions.

Details: [docs/features.md](docs/features.md) · [docs/protocol.md](docs/protocol.md) · [docs/architecture.md](docs/architecture.md).

## Quick start

```sh
npm install     # installs dependencies and builds frontend/dist
npm start       # http://127.0.0.1:7500 ($PORT overrides)
npm test
npm run typecheck
```

## Key defaults

- **Store**: `$PROJECTS_ROOT/.code-artifact/`; `CODE_ARTIFACT_STORE` overrides it. With neither set, the API answers `503 STORE_UNCONFIGURED` and the UI still loads.
- **Port**: 7500, loopback only.
- **Caps**: 512 MiB and 20 000 files per publish; 4 MiB for a markdown source.

## Known limitations

- Static artifacts run same-origin with cc's API reach and are served as authored, without the plugin's CSP (the trusted stance: publishing agents already have full cc access).
- Dotfiles in static artifacts are not served.
- Markdown images and relative links are not bundled with the document.
- The `app` kind is refused.
- Sources are local paths only.

## Development

- `.wiki/` and `node_modules/` are kept out of git (`.wiki/` via `.git/info/exclude`, `node_modules` via `.gitignore`). `.code-conductor/post-worktree-create.sh` symlinks both from the main checkout into each new worktree.
- `harness/mutation/` and `harness/playwright/` hold the mutation and visual-verification harnesses.
