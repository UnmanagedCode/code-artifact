# Architecture

Node ESM backend (Express 4) plus a React/Vite/Tailwind v4 UI, one package. Contracts: [protocol.md](protocol.md). User-facing behaviour: [features.md](features.md).

## Module map

| Module | Responsibility |
|---|---|
| `server.js` | `createServer({storeDir, distDir, ccUrl, limits, mount, appTimings})` wires the pieces and reaps orphans; `start()` listens on `127.0.0.1:$PORT` (default 7500), prints the `readyWhen` line and stops every app on SIGTERM/SIGINT |
| `src/config.js` | `storeRoot()` (`CODE_ARTIFACT_STORE`, else `$PROJECTS_ROOT/.code-artifact`), `ccUrl()` (`CONDUCTOR_URL`) |
| `src/refusal.js` | `Refusal` and `CODES` (code → REST status) |
| `src/limits.js` | `LIMITS`: byte, file-count and markdown-size caps; injectable in tests |
| `src/links.js` | `PLUGIN_ID`, `MOUNT`, `appBasePath`, `ID_RE`, `deepLink` |
| `src/kinds.js` | `KINDS`, `resolveKind(info, explicit)` |
| `src/source.js` | `inspectSource`: stat, directory listing, tarball listing and validation |
| `src/ingest.js` | `stageContent`: walk, copy, extract, pack into a staging dir |
| `src/appManifest.js` | `parseAppManifest`, `readAppManifest`: the `artifact.json` schema |
| `src/appHost.js` | `createAppHost`: per-artifact process state machine, per-id lock, timers, `APP_TIMINGS` |
| `src/appProcs.js` | OS layer: process groups, `/proc` scans, zombie-aware liveness, port probe |
| `src/appLog.js` | Log file open/rotate/tail |
| `src/appRewrite.js` | Pure proxy rewriting: upstream path, forwarded headers, `Location`, `Set-Cookie` |
| `src/appProxy.js` | `appProxyRouter` (HTTP) and `appUpgrade` (WebSocket) for `app/<id>/…` |
| `src/markdown.js` | `renderMarkdown`: `marked` (GFM) then `sanitize-html` allowlist |
| `src/store.js` | `Store`: on-disk records, versions, mutex, sweep, prune |
| `src/cc.js` | cc REST reads: project existence, session label |
| `src/ops.js` | The operations behind both MCP and REST: argument checks, defaults, publish/update/list/get/remove/prune |
| `src/mcp.js` | Tool handlers keyed by manifest tool name; the envelope handler |
| `src/api.js` | REST router for the UI |
| `src/serve.js` | `a/…`, `raw/…`, `dl/…`, `_page/…` |
| `src/pages.js` | Markdown page, download landing page and the static and app wrapper (`staticPage`, `appPage`) templates |
| `src/webui.js` | Security headers, JSON-only mutation gate, UI mount, terminal handlers |
| `src/http.js` | `wrap` (async handler errors), `refusalJson`, `plain` |
| `assets/page.css` | Styles of the server-rendered pages (tokens only) |
| `assets/app-page.js` | The app wrapper's behaviour: status polling, Start/Stop, log tail, iframe swap |
| `frontend/` | The UI, per the plugin UI reference setup; `frontend/src/lib/artifacts.ts` holds the pure logic |

## Store on disk

```
<store>/artifacts/<id>/artifact.json
<store>/artifacts/<id>/v/<n>/content/…       served root (the single file, or the site tree)
<store>/artifacts/<id>/v/<n>/rendered.html   markdown only
<store>/artifacts/<id>/v/<n>/run/            app only: the working copy a run executes in (created at first Start)
<store>/artifacts/<id>/v/<n>/installed       app only: marker of a finished install
<store>/artifacts/<id>/data/                 app only: DATA_DIR
<store>/artifacts/<id>/app.log[.1]           app only: the current and previous run's log
<store>/.staging/<rand>/                     ingest scratch
<store>/.trash/<rand>/                       artifact dirs on their way out
```

`artifact.json`: `schema`, `id`, `kind`, `project`, `title` (current), `createdAt`, `nextVersion`, `versions[]`. A record is validated on every read (`recordProblem` in `src/store.js`); a malformed or unparseable one is logged, left on disk, and excluded from `get`, `list` and `prune`. A version: `n`, `title`, `publishedAt`, `sessionId`, `sessionLabel`, `source:{name,type}`, `file` (markdown/download), `app:{start, install?, prefix}` (app; `recordProblem` requires it), `bytes`, `files`.

- **Ids**: a slug of the title plus a random suffix; see `newId` in `src/store.js`. Every id matches `ID_RE`.
- **Version numbers** come from `nextVersion` and are never reused. Latest is the last remaining entry (the highest `n`).
- **Write order** (crash safety): stage in `.staging/`, rename to `v/<n>`, then write `artifact.json` via a temp file and rename.
- **Delete**: the version leaves `artifact.json` first, then its directory is removed; a whole artifact is renamed into `.trash/` then removed.
- **Sweep** (`Store.open`): empties `.staging/` and `.trash/`; removes `v/<n>` directories not listed in `artifact.json`; removes artifact directories with no `artifact.json` (a crash mid-create); logs a corrupt `artifact.json` and leaves the artifact in place, out of listings.
- **Concurrency**: every mutation runs through one promise-chain mutex (`#lock`); the backend is single-process.
- **Location**: outside every project tree, so artifacts outlive a plugin reinstall, a worktree deletion and a project deletion.

## Ingest safety

- A directory is walked with `lstat`: a symlink or any non-file, non-directory entry is `UNSAFE_ENTRY`, as is a name with a backslash. Files are copied with `COPYFILE_EXCL`.
- A tarball goes through a listing, an extraction and a walk: the listing with `tar.Parser` that allows only file and directory entries with safe paths and checks the caps (aborting early); the extraction uses `strict` and a type filter; the walk is the one used for directories.
- The sole-top-dir rule applies to tarballs only: one root entry that is a directory becomes the root.
- Failure removes the staging dir; the source is never modified.
- A static source with a root `v/<number>` is `RESERVED_PATH`: the pinned-version route would shadow it.

## Serving

- `serve.js` parses the raw (percent-encoded) `req.path`, not Express's decoded params, so an encoded `%2f` stays a refusal. Each segment is decoded and refused when empty, dot-led, or holding `/`, `\` or NUL.
- A file is served only when `lstat` says it is a regular file and its `realpath` stays inside the real `content/` directory.
- `res.sendFile` gets a relative path with `root`: an absolute path makes `dotfiles:'deny'` refuse everything under the store's dot-directory.
- A static artifact is two routes: `a/…` answers the wrapper page (`staticPage` in `src/pages.js`), and `raw/<id>/<n>/…` serves the files through the path resolution above. The wrapper exists because cc's `navigate` is only seen by documents that load the bridge and `nav.js`, which a raw site does not. The iframe `src` is relative, with one `../` per directory level of the wrapper's URL, and always names a concrete version.
- Raw responses drop the CSP header (`res.removeHeader`); everything else keeps it.
- The page assets under `_page/` are served from their one source file each, so the pages render while the UI is unbuilt.
- cc steers a page it already shows with `navigate` (a `replaceState` plus a synthetic `popstate`, never a load). `frontend/public/nav.js`, loaded by the UI document and by every server-rendered page, reloads when the path changes under the document, and, on a server-rendered page (its `<html>` carries `data-reload-on-search`), when the query changes too; the UI's own query routing and hash-only changes never reload. Without it, opening an artifact from the UI, or a second artifact link while the plugin is docked, would leave stale content.
- Markdown is rendered once at publish and read from `rendered.html`, so serving never parses.

## App processes

- **One process per artifact, always the latest version.** Invariant: an active process runs the version that was latest when it started, and every update restarts an active app. State is in memory; every boot starts all apps `stopped`. Each Start makes a new run object, and a run's callbacks (install exit, probe, child exit) act only while it is still the current one.
- **Per-id lock** (`locked` in `appHost.js`): Start, Stop, `restartIfActive` and `exclusive` (delete) queue per artifact. Lock order: ops takes the host lock first (`exclusive`), or calls the host after a store commit (`restartIfActive`); the host never calls into the store while the store's mutex is held.
- **Install into a copy.** Start copies `v/<n>/content/` to `v/<n>/run/` (`fsp.cp` with `COPYFILE_FICLONE`) and installs there; success writes `v/<n>/installed`. No marker (or no `run/`) means `rm -rf run/`, copy, install again. The published `content/` is never touched, so `dl/` stays the published tree.
- **Process groups.** `install` and `start` run as `/bin/sh -c` with `detached: true`; Stop is `SIGTERM` to the group, then `SIGKILL` after `graceMs`. Anything that left the group is caught by the marker sweep.
- **Run marker.** Every install and start process gets `CODE_ARTIFACT_RUN=<id>@<realpath of the store root>`. `reapMarked` scans `/proc/*/environ` (same uid; unreadable entries skipped) for a marker whose part after the first `@` is this store's real path. No pid files: a recycled pid has no marker, descendants that left the group still carry it, and another store's apps (the live plugin's, a test's) never match. Without `/proc` the group kill still works; the sweep and boot reaping are skipped with one logged warning.
- **Liveness is read from `/proc/<pid>/stat`**: a zombie does not count as alive (`kill(pid, 0)` succeeds on one, and a container's PID 1 may never reap). A group is alive while any non-zombie has that `pgrp`.
- **Logs are files, never pipes**: stdout and stderr of a run share one `O_APPEND` fd on `app.log`. Each Start renames it to `app.log.1`; a timer (`logCheckMs`) rotates a running log above `logCapBytes`, keeping its tail in `.1`.
- **Shutdown inside cc's grace.** cc stops a plugin with SIGTERM and SIGKILLs the group 3 s later. `start()` handles SIGTERM/SIGINT with `apps.shutdown()` (SIGTERM every group, SIGKILL after `shutdownGraceMs`, then a marker sweep) and exits 0. cc's restart of the *backend* does not adopt anything: apps are stopped, never adopted, so no ports or liveness need persisting.
- **`BASE_PATH` is `MOUNT/app/<id>`, a constant** (`createServer({mount})` is a test seam). Two start paths carry no forwarded prefix at all: the restart triggered by an `update_artifact` MCP call, and a WebSocket upgrade.
- **Ports and readiness**: `freePort()` listens on 0 and closes; `probe(port)` connects to `127.0.0.1` and `::1` and the answering address is where the proxy connects.

## Tests

App tests start real child processes from a dependency-free fixture app (`tests/fixtures/app-server.cjs`, options in its `fixture.json`) on ephemeral ports. `tests/_apps.mjs` holds the helpers: `startApps` injects short `appTimings` (`TIMINGS`), every wait is `waitFor` against a deadline, and `startApp`'s teardown awaits `server.apps.shutdown()` before the store is removed. `app-reap.test.mjs` also spawns `node server.js` to pin the SIGTERM path.

`npm test` runs `tests/run.mjs`, a programmatic `node:test` runner. Each test builds its own temp store and starts the app on port 0 (`startApp` in `tests/_helpers.mjs`); a fake cc (`fakeCc`) stands in for the conductor and `rawTarball` builds hostile archives. Pure UI logic is tested by importing `frontend/src/lib/artifacts.ts` directly. `npm run typecheck` checks the UI.
