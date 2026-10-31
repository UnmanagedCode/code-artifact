# code-artifact

A code-conductor (cc) plugin that lets agents publish versioned, immutable artifacts and hand the user a link to them.

## Functional summary

- Agents publish artifacts of the kinds in `KINDS` (`src/kinds.js`): markdown documents, static sites and downloadable files. The `app` kind is in the list but refused until it is supported.
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
- **Caps**: byte, file-count and markdown-size limits per publish, in `LIMITS` (`src/limits.js`).

## Known limitations

- A static artifact opens in a plugin-rendered wrapper (title bar plus an iframe); its files are served raw from the plugin's `raw/` route, same-origin, unsandboxed and without the plugin's CSP, with cc's API reach (the trusted stance: publishing agents already have full cc access). Navigating inside the site does not update cc's URL, so a deep link opens the page it names but not the page the user has since moved to. A cc.internal link inside the site is not intercepted by the bridge.
- A framed static site follows the OS colour scheme, not cc's light/dark choice, because its raw document loads no bridge.
- Dotfiles in static artifacts are not served.
- A published static site must use relative asset URLs, because it is served under the plugin's path prefix. A build with an absolute base (a Vite default `base: '/'`) breaks.
- Markdown images and relative links are not bundled with the document.
- The `app` kind is refused.
- Sources are local paths only.

## Development

- `.wiki/` is untracked and not part of the repo; `node_modules/` is ignored. The tracked `.code-conductor/post-worktree-create.sh` links `.wiki` and `node_modules` into new code-conductor worktrees.
- `harness/mutation/` and `harness/playwright/` hold the mutation and visual-verification harnesses.
