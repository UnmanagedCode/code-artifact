# Features

What a user and an agent see. Interface contracts are in [protocol.md](protocol.md); internals in [architecture.md](architecture.md).

## Publishing

An agent publishes a local file, directory or `.tar.gz` with the `publish_artifact` MCP tool and gets a deep link. Artifacts are immutable and versioned: `update_artifact` adds a version, earlier versions stay.

### Kind inference

| Source | Kind | Notes |
|---|---|---|
| `*.md` file (any case) | `markdown` | Rendered once at publish time to sanitized HTML |
| `*.html` / `*.htm` file | `static` | Stored as the site's `index.html` |
| Directory with a root `index.html` | `static` | Served as a site |
| `*.tar.gz` / `*.tgz` with a root `index.html` | `static` | Extracted; a sole top-level directory is stripped (`tar czf x.tgz dist`) |
| Directory or tarball with a root `artifact.json` | `app` | Extracted like a site; the manifest is validated (`APP_MANIFEST_INVALID`). A root `artifact.json` wins over `index.html`; pass `kind:"static"` to publish such a directory as a site |
| Any other directory | `download` | Packed as `<name>.tar.gz` |
| Any other file or tarball | `download` | Kept as-is; a tarball is not extracted |

An explicit `kind` overrides inference when the source fits it, else `KIND_SOURCE_MISMATCH`. A tarball is listed (and refused if unsafe) only when no explicit kind is given or the kind is `static` or `app`; `kind:"download"` keeps any tarball untouched.

### Apps

A dynamic app is a directory or `.tar.gz` with a root `artifact.json`. code-artifact owns its process: **Start, Stop and logs come from the UI only** (no MCP tools). An app is published **stopped**; the user starts it from the link. Publish the source without `node_modules`: the install runs at first Start.

`artifact.json` (unknown keys are refused, which catches typos like `instal`):

| Key | Meaning |
|---|---|
| `start` | Required. The command that starts the app, run with `/bin/sh -c` from the working copy. It must listen on `$PORT` on loopback |
| `install` | Optional. Run once per version before the first start, in the same working copy |
| `prefix` | `"strip"` (default) or `"keep"`: what path the app is asked for, below |

Environment of `install` and `start`: the backend's environment plus `BASE_PATH` (`/plugins/code-artifact/app/<id>`, no trailing slash), `DATA_DIR` (`artifacts/<id>/data/` in the store; created on Start, survives updates, removed with the artifact) and, for `start` only, `PORT` (a free loopback port).

**Which path the app sees.** The app is served same-origin under `app/<id>/` through the plugin's reverse proxy, so it works inside cc and behind a code-hub share of cc. `BASE_PATH` (`/plugins/code-artifact/app/<id>`) is only the URL path when cc mounts the plugin; in a standalone `npm start` run the proxy is at `/app/<id>/…`, so any link or setting built from `BASE_PATH` (a `strip` app's prefixed links included) does not resolve there.
- `strip` forwards `/x` for `app/<id>/x`. Right for hand-written servers: use relative links, or prefix root-absolute ones with `$BASE_PATH`.
- `keep` forwards `$BASE_PATH/x`. Needed by frameworks that mount under their base themselves (Vite dev, Next `basePath`, SvelteKit, Astro); Vite's HMR WebSocket is accepted only under its `base`.

**Host and Origin.** The proxy sets `Host` to the app's own address (`127.0.0.1:<port>`; Vite 6 rejects unknown hosts), while the browser's `Origin` is cc's or the share's. A framework that compares `Origin` with `Host` for CSRF (Django, Rails) must be told to trust `X-Forwarded-Host`, which carries the original host.

Worked example, `strip`: `artifact.json` is `{"start": "node server.js"}` and `server.js` is

```js
require('node:http').createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(`<h1>Hello</h1><a href="${process.env.BASE_PATH}/about">about</a>`);
}).listen(process.env.PORT, '127.0.0.1');
```

Worked example, `keep` (a Vite scaffold published without `node_modules`):

```json
{
  "install": "npm ci",
  "start": "npx vite --host 127.0.0.1 --port $PORT --strictPort --base $BASE_PATH/",
  "prefix": "keep"
}
```

**Lifecycle.**
- **One process per artifact, always the latest version.** A pinned link to an older version shows "v<n> does not run; only the latest (v<m>) runs" and a link to the latest.
- **States:** `stopped`, `installing`, `starting`, `running`, `failed`. `starting` ends when the app accepts a connection on its port (or fails: it exits first, or does not listen within 60 s). A failed state shows the error and the log.
- **Install** runs asynchronously at the first Start of a version, in a fresh working copy of the published tree (`v/<n>/run/`), with a 15-minute limit. A failed install is retried from a clean copy; the published tree and its download never contain the install's output.
- **`update_artifact` restarts a running app** on the new version (a stopped app stays stopped). `DATA_DIR` persists.
- **Delete:** deleting the artifact stops the app and removes its data and logs. Deleting a version stops the app only when it is the version that runs, and the app then stays stopped. Prune never removes the running version.
- **A backend restart stops every app** (the plugin's stop, restart or update, or a crash): apps come back `stopped`, are never adopted, and a crash's orphans are reaped at the next boot.
- **Logs** (`app.log`, plus `app.log.1` from the previous run) hold the stdout and stderr of install and start and the host's own `[code-artifact]` lines; a running log over 1 MiB is rotated.

### Project and session

- `project` defaults to the calling session's project. The conductor's own project is not a user project, so a conductor must pass `project`.
- An explicit `project` must exist in cc (`PROJECT_UNKNOWN` otherwise).
- `sessionId` defaults to the calling session; the session's label is snapshotted at publish, so the UI can name the session after it exits. The snapshot is cc's display label: the session title if one is set at publish, else a preview of its first prompt. A title set later shows from the next `update_artifact`.

### Updating

`update_artifact` takes the artifact id and a new source of the **same kind** (`KIND_CHANGE` otherwise; pass `kind:"<stored>"` to force the source to be that kind). The project cannot change. A `title`, when given, becomes the current title.

### Deleting

`delete_artifact` removes a whole artifact, or one version when `version` is given. Version numbers are never reused. The only remaining version cannot be deleted on its own (`LAST_VERSION`).

## Viewing

Deep links look like `http://cc.internal/#plugin/code-artifact/a/<id>/` (latest) and `…/a/<id>/v/<n>/` (pinned). cc opens them in-app.

| Kind | What the link shows |
|---|---|
| `markdown` | A themed page with the title, `v<n>` (latest or pinned), a Download link, and the rendered document |
| `static` | A compact header bar (title, `v<n>` latest or pinned, Download) over an iframe that fills the rest of the view and shows the site as authored, same-origin, with its own scripts and styles. A deeper deep link (`…/a/<id>/docs/page.html`) opens that page in the frame |
| `download` | A landing page with the file name, size, publish time and a Download button |
| `app` | A bar (title, `v<n>` latest or pinned, live status, Start/Stop, Logs, Download) over an iframe with the running app. While the app is not running, a panel with a large **Start**, the error if any and a live log tail replaces the iframe. Navigation inside the frame is not mirrored to cc's URL |

Every version can be downloaded from `dl/<id>/<n>`; a static or app version downloads as `<id>-v<n>.tar.gz` (an app's published tree).

## UI

The plugin's own page (nav label "Code Artifact"):

- **List**: artifacts grouped by project (projects by name, artifacts newest first). Each row shows the title, kind, latest version, relative time, the publishing session (its label as plain text, else the 8-character id, else "unknown session"), and an **Open** link. Markdown in the label is stripped and a label longer than `MAX_SESSION_LABEL` (`frontend/src/lib/artifacts.ts`) is cut to at most that many code points, backing up to the last space only when it falls past halfway, with `…` appended. The session text is constrained to its card (truncated in the list, wrapped in the detail), so a long unbroken label never widens the page. An empty state names `publish_artifact`.
- **App rows and detail**: an app row shows a status badge. An app's detail view adds a panel with the status, **Start**, **Stop**, **Open**, the latest version's `start`, `install` and `prefix`, and the log tail (polled every second while installing or starting, else every 5 s).
- **Detail** (`?artifact=<id>`): versions newest first, each naming its session as the list does (`sessionText`), with **Open** (pinned), **Download** and **Delete** (a confirm dialog; disabled on the last version), plus **Delete artifact**.
- **Project filter** (`?project=<name>`): the list shows only that project, under a strip with the name as text and **Show all**. The filter carries through the detail (`?project=<name>&artifact=<id>`); its Back and **Delete artifact** return to the filtered list. With no artifacts in that project, the empty state names it.
- **Delete old…**: deletes versions published more than N days ago, optionally for one project. A live dry-run count is shown first. Every artifact keeps its latest version.
- Follows cc's light/dark theme and session width; works on a phone.

### Open from code-conductor

- **Show artifacts** sits in the ⋮ menu of each project row in cc's sidebar, under "Code Artifact". Worktree rows have none: an artifact belongs to a project, not a worktree.
- A click opens the list filtered to that project (see **Project filter**) and fetches the list afresh. An already-open page switches in place, without a reload.
- cc's query is replaced in place with `?project=<name>`, so a reload or Back never repeats the click.
- A name with no artifacts (cc lists only live projects) shows the project's empty state.
- A click that names no project shows an alert with **Dismiss** and leaves the view as it was. Any later navigation, Back included, clears the alert.
- A click only reads: it never creates, publishes or deletes anything.
