# Architecture

Node ESM backend (Express 4) plus a React/Vite/Tailwind v4 UI, one package. Contracts: [protocol.md](protocol.md). User-facing behaviour: [features.md](features.md).

## Module map

| Module | Responsibility |
|---|---|
| `server.js` | `createServer({storeDir, distDir, ccUrl, limits, mount, appTimings})` wires the pieces and reaps orphans; `start()` runs `migrateLegacyStore` before `createServer`, then listens on `127.0.0.1:$PORT` (default 7500), prints the `readyWhen` line and stops every app on SIGTERM/SIGINT |
| `src/config.js` | `storeRoot()` (`CONDUCTOR_PLUGIN_DATA_DIR` only; `STORE_UNCONFIGURED` via `storeUnconfigured`), `ccUrl()` (`CONDUCTOR_URL`) |
| `src/migrateLegacyStore.js` | `migrateLegacyStore({env, dataDir, rename, log})`: the one-shot boot move of the legacy store |
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
| `src/pages.js` | Markdown page, download landing page (with the inline image preview, `isPreviewImage`) and the static and app wrapper (`staticPage`, `appPage`) templates |
| `src/webui.js` | Security headers, JSON-only mutation gate, UI mount, terminal handlers |
| `src/http.js` | `wrap` (async handler errors), `refusalJson`, `plain` |
| `assets/page.css` | Styles of the server-rendered pages (tokens only) |
| `assets/app-page.js` | The app wrapper's behaviour: status polling, Start/Stop, log tail, iframe swap |
| `assets/report.js` | `ccArtifact.report()` inside an artifact page: serializes, posts to the wrapper, resolves with its answer or `TIMEOUT` |
| `assets/relay.js` | The wrapper's side of reports: frame/origin check, limits (`MAX_REPORT_BYTES`, `RATE_LIMIT`, `RATE_WINDOW_MS`, `DEADLINE_MS`), prompt framing, `ccBridge.sendPrompt` |
| `frontend/` | The UI, per the plugin UI reference setup; `frontend/src/lib/artifacts.ts` holds the pure logic, including the route helpers `parseRoute`, `routeSearch` and `menuArrival` |

## Store location and migration

- `storeRoot()` reads `CONDUCTOR_PLUGIN_DATA_DIR` only; there is no override and no fallback. cc sets it and never creates the dir; the plugin does.
- Unset, empty or relative: `start()` logs a warning and boots with `storeDir` null; `getStore` then answers 503 `STORE_UNCONFIGURED` (built by `storeUnconfigured`) and no migration runs.
- `migrateLegacyStore` (called in `start()` between `storeRoot()` and `createServer`) moves `<PROJECTS_ROOT>/.code-artifact` to the data dir with a single `rename`, which keeps modes. It is the only code that names the legacy path.
- No-ops: `PROJECTS_ROOT` unset or empty (`'no-root'`), no legacy dir (`'absent'`), legacy path equal to the data dir (`'same'`).
- An empty target dir is replaced; missing parents are created with the explicit mode `migrateLegacyStore` passes to `mkdir` (umask can only narrow it).
- Refusals: a non-empty target, a non-directory at either end (a symlinked legacy counts), EXDEV (the message gives an `mv` command), inspect/create errors. Each names both paths and throws `ESTOREMIGRATE`.
- A refusal exits 1 before listening (the direct-run guard in `server.js`). It never moves or changes store data; it may leave the empty parents it created, and a removed empty target stays removed.
- Known gap: app processes orphaned by a crashed earlier backend carry the old store realpath in `CODE_ARTIFACT_RUN`, so boot reaping no longer matches them after the move. A clean cc stop has already stopped them.
- Gotcha: a spawned `server.js` must not inherit a real `PROJECTS_ROOT`; `tests/app-reap.test.mjs` and `harness/playwright/seed.mjs` clear it.

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

`artifact.json`: `schema`, `id`, `kind`, `project`, `title` (current), `createdAt`, `nextVersion`, `versions[]`. A record is validated on every read (`recordProblem` in `src/store.js`); a malformed or unparseable one is logged, left on disk, and excluded from `get`, `list` and `prune`. A version: `n`, `title`, `publishedAt`, `sessionId`, `sessionLabel` (cc's `displayLabel` stored as returned; cleaned only for display by `sessionText`/`plainLabel` in `frontend/src/lib/artifacts.ts`), `source:{name,type}`, `file` (markdown/download), `app:{start, install?, prefix}` (app; `recordProblem` requires it), `bytes`, `files`.

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
- Raw responses drop the CSP header (`res.removeHeader`); dl/ responses replace it with `DL_CSP` (`src/serve.js`); everything else keeps it.
- Raw `.html`/`.htm` files get the report helper's tag spliced in (`sendHtml` and `reportOffset` in `src/serve.js`); every other file goes through `res.sendFile`. Only the first `DOCTYPE_SCAN_BYTES` are read to place the tag; the head, the tag and a read stream of the rest from the same file handle are sent with `Content-Length` = file size + tag length, so memory stays bounded whatever the file's size. `sendHtml` sets its own weak `ETag` (served length and mtime) and `Last-Modified` and answers `req.fresh` with `304` and HEAD with headers only, since neither `send` nor `res.send` is in the path. It answers `Accept-Ranges: none` (body offsets are not file offsets). Handle lifetime: a response already destroyed when the reads finish (the client left, and `close` has fired unseen) closes the handle at once; once streaming, `stream.pipeline` destroys the read stream, which closes the handle, on any abort. A file gone at `open` (the version deleted mid-request) is a 404. The offset is searched on the latin1 view of the bytes (one char per byte), so no byte is re-encoded. The tag goes after the doctype because a script before it switches the page to quirks mode; being first, the blocking script defines `ccArtifact` before the page's own scripts and before any `<base>`, so its relative `src` resolves against the document URL. `DOCTYPE_RE`'s comment body cannot span `-->`; a lazy `[\s\S]*?` there backtracks exponentially on many leading comments without a doctype.
- Reports (`ccArtifact.report()`, contract in [protocol.md](protocol.md)) go through the wrapper because the wrapper, not the site, is cc's plugin frame: cc attributes a bridge call to a frame by `ev.source` and defines `ccBridge` only in a framed `/plugins/<id>` document, so the raw site's own window (whose parent is the wrapper) has none. That is not isolation: the site is same-origin and unsandboxed, so its scripts can reach `window.parent.ccBridge` and the wrapper's DOM directly. `relay.js`'s source and origin checks, its limits and its framing are protocol hygiene for well-behaved pages, not an integrity boundary against a hostile artifact. `relay.js` is a blocking script first in `<body>`, so its listener exists before the iframe's page can post; it looks the iframe up per message because the app wrapper replaces it. A future `sandbox` on the frame (opaque origin) would need a source-only check in the relay and `'*'` as both targetOrigins.
- The page assets under `_page/` are served from their one source file each, so the pages render while the UI is unbuilt.
- cc steers a page it already shows with `navigate` (a `replaceState` plus a synthetic `popstate`, never a load). `frontend/public/nav.js`, loaded by the UI document and by every server-rendered page, reloads when the path changes under the document, and, on a server-rendered page (its `<html>` carries `data-reload-on-search`), when the query changes too; the UI's own query routing and hash-only changes never reload. Without it, opening an artifact from the UI, or a second artifact link while the plugin is docked, would leave stale content.
- A cc ⋮ menu click (`?ccProject=…`) is query-only from the UI document, so `nav.js` leaves it to the UI's `popstate` handler, which retargets in place and re-fetches the list. From a server-rendered artifact page it is a path change, so `nav.js` reloads and the UI handles the arrival on load. Either way `menuArrival` replaces the cc query with the UI's own route via `history.replaceState`.
- Markdown is rendered once at publish and read from `rendered.html`, so serving never parses.

## App processes

- **One process per artifact, always the latest version.** Invariant: an active process runs the version that was latest when it started, and every update restarts an active app. State is in memory; every boot starts all apps `stopped`. Each Start makes a new run object, and a run's callbacks (install exit, probe, child exit) act only while it is still the current one.
- **Per-id lock** (`locked` in `appHost.js`): Start, Stop, `committing` (an update's store write plus the restart of an active app) and `exclusive` (delete) queue per artifact, so a version delete cannot interleave with an update's commit. Lock order: the host lock is always taken before the store's mutex, never the reverse.
- **Install into a copy.** Start copies `v/<n>/content/` to `v/<n>/run/` (`fsp.cp` with `COPYFILE_FICLONE`) and installs there; success writes `v/<n>/installed`. No marker (or no `run/`) means `rm -rf run/`, copy, install again. The published `content/` is never touched, so `dl/` stays the published tree.
- **Process groups.** `install` and `start` run as `/bin/sh -c` with `detached: true`; Stop is `SIGTERM` to the group, then `SIGKILL` after `graceMs`. Anything that left the group is caught by the marker sweep.
- **Run marker.** Every install and start process gets `CODE_ARTIFACT_RUN=<id>@<realpath of the store root>`. `reapMarked` scans `/proc/*/environ` (same uid; unreadable entries skipped) for a marker whose part after the first `@` is this store's real path. No pid files: *selection* is marker-based, so a pid that was recycled before the scan has no marker and is never selected (a pid recycled between selection and the signal could still be hit; there is no pidfd), descendants that left the group still carry it, and another store's apps (the live plugin's, a test's) never match. Without `/proc` the group kill still works; the sweep and boot reaping are skipped with one logged warning.
- **The sweep rescans until clean.** `reapMarked` SIGTERMs what the first scan found (`graceMs`), then rescans and SIGKILLs until two consecutive scans find nothing live, within `graceMs` + 1 s. It resolves `{reaped, survivors}`; `appHost`'s `sweep` logs survivors with `console.error`. A process that was alive at one scan can spawn marked children that scan never saw; a SIGKILLed one cannot, so the next scan catches them. To list what a store still has marked by hand: `grep -la "CODE_ARTIFACT_RUN=.*@<store realpath>" /proc/[0-9]*/environ` (`-a` is required: environ is NUL-separated).
- **Known limit: isolation is best-effort.** A marked process that forks and then exits on its own between a scan's `/proc` listing and its check, twice in a row (once per confirming scan), leaves a child the sweep never sees. Closing it needs `cgroup.kill` or a subreaper supervisor; the plugin uses neither, because it takes no external helper or dependency.
- **Liveness is read from `/proc/<pid>/stat`**: a zombie (`Z`) or a process being reaped (`X`) does not count as alive (`kill(pid, 0)` succeeds on a zombie, and a container's PID 1 may never reap). A group is alive while any other process has that `pgrp`.
- **Logs are files, never pipes**: stdout and stderr of a run share one `O_APPEND` fd on `app.log`. Each Start renames it to `app.log.1`; a timer (`logCheckMs`) rotates a running log above `logCapBytes`, keeping its tail in `.1`. A check that finds the log grew while it read the tail skips that round (the tail could be partial) but at most once in a row, so an app that writes continuously is still rotated (`createRotator` in `src/appLog.js`).
- **Shutdown vs cc's 3 s grace.** cc stops a plugin with SIGTERM and SIGKILLs the group 3 s later. `start()` handles SIGTERM/SIGINT with `apps.shutdown()` and exits 0. `shutdown()` sets `closed`, then SIGTERMs every group in parallel and SIGKILLs the survivors after `shutdownGraceMs` (2 s), waits up to 1 s for a SIGKILLed group to vanish, then sweeps by marker for descendants that left their group (SIGKILL at once, rescanning until clean, up to 1 s more). `halt` kills each group once; a launch that is not stopping also kills what its install left behind. The worst case is therefore `shutdownGraceMs` + 1 s + 1 s, about 4 s, and only when a process is stuck uninterruptibly (an in-progress content copy, `fsp.cp` into `run/`, is not bounded by these timings: shutdown waits for it to notice the stop); one that dies on SIGTERM or SIGKILL takes milliseconds. After `shutdown()` resolves nothing is spawned or running: `startLocked` re-checks `closed` in the same synchronous step as `states.set`, so a Start is either in `shutdown()`'s snapshot or refused. cc's restart of the *backend* does not adopt anything: apps are stopped, never adopted, so no ports or liveness need persisting.
- **`BASE_PATH` is `MOUNT/app/<id>`, a constant** (`createServer({mount})` is a test seam). Two start paths carry no forwarded prefix at all: the restart triggered by an `update_artifact` MCP call, and a WebSocket upgrade.
- **Ports and readiness**: `freePort()` listens on 0 and closes; `probe(port)` connects to `127.0.0.1` and `::1` and the answering address is where the proxy connects. Known limitation: another process can take the port between `freePort()` and the app's bind, and `probe` accepts any listener on the port, so the app could be reported `running` while something else answers. There is no retry.

## Tests

App tests start real child processes from a dependency-free fixture app (`tests/fixtures/app-server.cjs`, options in its `fixture.json`) on ephemeral ports. `tests/_apps.mjs` holds the helpers: `startApps` injects short `appTimings` (`TIMINGS`), every wait is `waitFor` against a deadline, and `startApp`'s teardown awaits `server.apps.shutdown()` before the store is removed. `app-reap.test.mjs` also spawns `node server.js` to pin the SIGTERM path (the backend gets `CONDUCTOR_PLUGIN_DATA_DIR` and has `PROJECTS_ROOT` removed); tests that run real app processes tear them down before their store is removed (teardown registered before `tmp()`), and the SIGTERM test reaps by marker (`reapStore`) because a SIGKILLed backend cannot stop its app.

`npm test` runs `tests/run.mjs`, a programmatic `node:test` runner. Each test builds its own temp store and starts the app on port 0 (`startApp` in `tests/_helpers.mjs`); a fake cc (`fakeCc`) stands in for the conductor and `rawTarball` builds hostile archives. Pure UI logic is tested by importing `frontend/src/lib/artifacts.ts` directly. `npm run typecheck` checks the UI.
