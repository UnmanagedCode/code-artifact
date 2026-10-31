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
| Directory or tarball with a root `artifact.json` | `app` | Refused: `KIND_NOT_SUPPORTED` (pass `kind:"static"` to publish it as a site) |
| Any other directory | `download` | Packed as `<name>.tar.gz` |
| Any other file or tarball | `download` | Kept as-is; a tarball is not extracted |

An explicit `kind` overrides inference when the source fits it, else `KIND_SOURCE_MISMATCH`. A tarball is listed (and refused if unsafe) only when no explicit kind is given or the kind is `static`; `kind:"download"` keeps any tarball untouched.

### Project and session

- `project` defaults to the calling session's project. The conductor's own project is not a user project, so a conductor must pass `project`.
- An explicit `project` must exist in cc (`PROJECT_UNKNOWN` otherwise).
- `sessionId` defaults to the calling session; the session's label is snapshotted at publish, so the UI can name the session after it exits.

### Updating

`update_artifact` takes the artifact id and a new source of the **same kind** (`KIND_CHANGE` otherwise; pass `kind:"<stored>"` to force the source to be that kind). The project cannot change. A `title`, when given, becomes the current title.

### Deleting

`delete_artifact` removes a whole artifact, or one version when `version` is given. Version numbers are never reused. The only remaining version cannot be deleted on its own (`LAST_VERSION`).

## Viewing

Deep links look like `http://cc.internal/#plugin/code-artifact/a/<id>/` (latest) and `…/a/<id>/v/<n>/` (pinned). cc opens them in-app.

| Kind | What the link shows |
|---|---|
| `markdown` | A themed page with the title, `v<n>` (latest or pinned), a Download link, and the rendered document |
| `static` | The site as authored, same-origin, with its own scripts and styles |
| `download` | A landing page with the file name, size, publish time and a Download button |

Every version can be downloaded from `dl/<id>/<n>`; a static version downloads as `<id>-v<n>.tar.gz`.

## UI

The plugin's own page (nav label "Artifacts"):

- **List**: artifacts grouped by project (projects by name, artifacts newest first). Each row shows the title, kind, latest version, relative time, the publishing session (its label, else the 8-character id, else "unknown session"), and an **Open** link. An empty state names `publish_artifact`.
- **Detail** (`?artifact=<id>`): versions newest first with **Open** (pinned), **Download** and **Delete** (a confirm dialog; disabled on the last version), plus **Delete artifact**.
- **Delete old…**: deletes versions published more than N days ago, optionally for one project. A live dry-run count is shown first. Every artifact keeps its latest version.
- Follows cc's light/dark theme and session width; works on a phone.
