# Protocol

Interface contracts. Everything is relative to the plugin root; cc mounts it at `/plugins/code-artifact/`.

## Manifest

`conductor.plugin.json`: `id` `code-artifact`, `pluginApi` 1, backend `npm start` (health `/api/health`, ready when stdout matches `listening`), frontend `/` labelled "Artifacts", MCP endpoint `/api/mcp`.

## MCP wire contract

- cc POSTs `{tool, arguments, caller:{sessionId, project}}` to `/api/mcp`.
- A well-formed call always answers `200`: `{result}` or `{error:"<CODE>: <message>"}` (MCP errors are plain strings, so the refusal code is the message prefix). An unknown tool is `200 {error:"unknown tool <name>"}`.
- A malformed envelope (no string `tool`) answers `400`.
- `caller.project` is `.conduct` for a conductor session; a dot-leading project name is treated as no project.
- The schemas are in the manifest and stay inside cc's validator subset. `ops.js` repeats the checks and refuses unknown keys with `INVALID_ARGUMENT`.

### Tools

| Tool | Arguments (required in **bold**) | Result |
|---|---|---|
| `publish_artifact` | **path**, **title**, kind, project, sessionId | `{id, title, kind, project, version, sessionId, link, versionLink, bytes, files}` |
| `update_artifact` | **artifact**, **path**, title, kind, sessionId | the same shape, `version` = the new number |
| `list_artifacts` | project, kind | `{artifacts:[{id, title, kind, project, versions, latest:{version, publishedAt, sessionId, sessionLabel}, link}]}`, newest first |
| `get_artifact` | **artifact** | the stored record plus `link` and a `versionLink` per version |
| `delete_artifact` | **artifact**, version | `{deleted:"artifact", id}` or `{deleted:"version", id, version, latest}` |

- `kind` is one of `markdown`, `static`, `download`, `app`; `app` is refused.
- `project` matches `^[a-zA-Z0-9._-]+$` (at most 100 characters); `artifact` matches `ID_RE` (`src/links.js`).
- `update_artifact` refuses a `project` key with `PROJECT_FIXED`.

## Refusal codes

`CODES` in `src/refusal.js` is the single source; REST answers `{error, code}` with the status.

| Code | REST status | Meaning |
|---|---|---|
| `INVALID_ARGUMENT` | 400 | Unknown key, wrong type or length, bad format |
| `PATH_NOT_ABSOLUTE` | 400 | `path` is relative |
| `PATH_NOT_FOUND` | 404 | `path` does not exist |
| `UNSUPPORTED_SOURCE` | 422 | Neither a regular file nor a directory |
| `UNSAFE_ENTRY` | 422 | Symlink, hardlink, device, fifo, `..`, absolute or backslash path; the message names the relative path |
| `BAD_ARCHIVE` | 422 | Unreadable `.tar.gz` |
| `TOO_LARGE` | 413 | Over the byte, file-count or markdown-size cap |
| `KIND_SOURCE_MISMATCH` | 422 | The explicit kind does not fit the source |
| `KIND_NOT_SUPPORTED` | 422 | `app` (explicit or inferred) |
| `KIND_CHANGE` | 409 | An update whose kind differs from the stored kind |
| `RESERVED_PATH` | 422 | A static source with a root `v/<number>` directory |
| `PROJECT_REQUIRED` | 400 | No user project and none passed |
| `PROJECT_UNKNOWN` | 404 | cc does not know the explicit project |
| `PROJECT_FIXED` | 400 | `project` passed to an update |
| `ARTIFACT_UNKNOWN` | 404 | No such artifact |
| `VERSION_UNKNOWN` | 404 | No such version |
| `LAST_VERSION` | 409 | Deleting an artifact's only version |
| `CC_UNREACHABLE` | 502 | cc could not answer the project check |
| `STORE_UNCONFIGURED` | 503 | Neither `CODE_ARTIFACT_STORE` nor `PROJECTS_ROOT` is set |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | REST only: a mutating request without a JSON content type |

## REST (for the UI)

| Route | Behaviour |
|---|---|
| `GET api/health` | `{ok:true}` |
| `POST api/mcp` | The MCP envelope above |
| `GET api/artifacts?project=&kind=` | `{artifacts:[record + link + versionLink per version]}`, newest first |
| `GET api/artifacts/:id` | One record plus `link` and a `versionLink` per version |
| `DELETE api/artifacts/:id` | `{deleted:"artifact", id}` |
| `DELETE api/artifacts/:id/versions/:n` | `{deleted:"version", …}` |
| `POST api/prune` `{olderThanDays, project?, dryRun?}` | `{versions:[{id, version}], artifacts}`; never includes a latest version |

Every non-GET/HEAD/OPTIONS request needs `Content-Type: application/json` (else 415), the DELETEs included.

## Content routes

| Route | Behaviour |
|---|---|
| `GET a/:id`, `GET a/:id/v/:n` | `301` to the relative `<id>/` and `<n>/` |
| `GET a/:id/…` | The latest version; `Cache-Control: no-cache` |
| `GET a/:id/v/:n/…` | A pinned version (`:n` is `[1-9][0-9]*`); `Cache-Control: private, max-age=31536000, immutable` |
| `GET raw/:id/:n/…` | A static site's files, byte for byte, always pinned to version `:n` (`:n` is `[1-9][0-9]*`); `Cache-Control: private, max-age=31536000, immutable`; no plugin CSP; `raw/:id/:n` redirects to `:n/` |
| `GET dl/:id/:n` | `Content-Disposition: attachment`: the stored file, or a `<id>-v<n>.tar.gz` of a static site |
| `GET _page/page.css`, `_page/fallback.css`, `_page/theme-init.js`, `_page/nav.js` | Assets of the server-rendered pages |

Per kind at the version root: `markdown` and `download` answer a page (any deeper subpath is 404); `static` answers a plugin-rendered wrapper page (the shared page shell: bridge, theme, `nav.js`; a header bar with title, `v<n>` latest or pinned and the Download link; and a same-origin iframe, not sandboxed) at any safe subpath, whose iframe `src` is the relative URL `raw/<id>/<n>/<subpath>` (the current latest `n` for a latest URL; a query string is forwarded). The raw route serves the files: `index.html` for a directory URL, a relative `301` for a directory without a trailing slash, never a listing, never a dotfile. A path segment that is empty, `.`/`..`, dot-led, or holds `/`, `\` or NUL after decoding is 404, as is anything whose real path leaves the version's `content/`.

## Headers

- Every response carries `X-Content-Type-Options: nosniff` and the plugin CSP (`securityHeaders` in `src/webui.js`), the 404, 503 and 415 included.
- **Raw site responses (`raw/…`) carry no CSP**: a site runs as authored. The wrapper and every other page keep it, including `frame-src 'self'` for the wrapper's iframe.
- Embedding: `frame-ancestors 'self'`.

## Deep links

`http://cc.internal/#plugin/code-artifact/a/<id>/` and `…/a/<id>/v/<n>/`. The id format has no dot segments, so cc's link validation accepts them.
