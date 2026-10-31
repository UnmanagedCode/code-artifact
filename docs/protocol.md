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
| `publish_artifact` | **path**, **title**, kind, project, sessionId | `{id, title, kind, project, version, sessionId, link, versionLink, bytes, files}`; an app adds `app:{status}` |
| `update_artifact` | **artifact**, **path**, title, kind, sessionId | the same shape, `version` = the new number; for an app, `app.status` is after the restart of an active app |
| `list_artifacts` | project, kind | `{artifacts:[{id, title, kind, project, versions, latest:{version, publishedAt, sessionId, sessionLabel}, link, app?}]}`, newest first |
| `get_artifact` | **artifact** | the stored record plus `link` and a `versionLink` per version; an app record adds `app:{status, version, error, since}` |
| `delete_artifact` | **artifact**, version | `{deleted:"artifact", id}` or `{deleted:"version", id, version, latest}` |

- `kind` is one of `KINDS` (`src/kinds.js`). The tool set has no process lifecycle: Start, Stop and logs are REST only.
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
| `KIND_CHANGE` | 409 | An update whose kind differs from the stored kind |
| `RESERVED_PATH` | 422 | A static source with a root `v/<number>` directory |
| `APP_MANIFEST_INVALID` | 422 | `artifact.json` is over 16 KiB, not UTF-8 JSON, not an object, has an unknown key, or has a bad `start`, `install` or `prefix` |
| `NOT_AN_APP` | 409 | `api/apps/:id/…` on an artifact that is not an app |
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

#### App routes

All store-backed (`STORE_UNCONFIGURED` when unset). An id that is not an artifact is `ARTIFACT_UNKNOWN`, a non-app artifact is `NOT_AN_APP`.

| Route | Answer |
|---|---|
| `GET api/apps/:id` | `{id, status, version, error, since}`; `status` is `stopped`, `installing`, `starting`, `running` or `failed` |
| `POST api/apps/:id/start` | `202` with the status object (`installing` or `starting`; progress is polled). Idempotent |
| `POST api/apps/:id/stop` | `200` with the status object (`stopped`), after the process group is gone. Idempotent; clears a failure |
| `GET api/apps/:id/log?bytes=` | `text/plain; charset=utf-8`, the last `bytes` bytes of `app.log` (default 65536, 1 to 1048576, else `INVALID_ARGUMENT`); `Cache-Control: no-store`; empty body before the first run |

`GET api/artifacts[/:id]` carries the same `app:{status, version, error, since}` on an app record.

Every non-GET/HEAD/OPTIONS request needs `Content-Type: application/json` (else 415), the DELETEs included.

## Content routes

| Route | Behaviour |
|---|---|
| `GET a/:id`, `GET a/:id/v/:n` | `301` to the relative `<id>/` and `<n>/` |
| `GET a/:id/…` | The latest version (a static artifact answers its wrapper page); `Cache-Control: no-cache` |
| `GET a/:id/v/:n/…` | A pinned version (a static artifact answers its wrapper page; `:n` is `[1-9][0-9]*`); `Cache-Control: private, max-age=31536000, immutable` |
| `GET raw/:id/:n/…` | A static site's files, byte for byte, always pinned to version `:n` (`:n` is `[1-9][0-9]*`); `Cache-Control: private, max-age=31536000, immutable`; no plugin CSP; `raw/:id/:n` redirects to `:n/` |
| `GET a/:id/…`, `a/:id/v/:n/…` (app) | The app wrapper page; `Cache-Control: no-cache` for pinned URLs too (it shows live status). A sub-path with a `..` segment (also percent-encoded) or a backslash is 404; other sub-paths, dot-led included, are forwarded |
| `* app/:id` | `301` to the relative `<id>/`, query kept |
| `* app/:id/…` | Reverse-proxied to the running app (below); an app that is not running is `503`, an id that is unknown or not an app is `404`, both plain text with the plugin CSP |
| `GET dl/:id/:n` | `Content-Disposition: attachment`: the stored file, or a `<id>-v<n>.tar.gz` of a static site's or an app's published tree |
| `GET _page/page.css`, `_page/fallback.css`, `_page/theme-init.js`, `_page/nav.js`, `_page/app-page.js` | Assets of the server-rendered pages |

Per kind at the version root: `markdown` and `download` answer a page (any deeper subpath is 404); `static` answers a plugin-rendered wrapper page (the shared page shell: bridge, theme, `nav.js`; a header bar with title, `v<n>` latest or pinned and the Download link; and a same-origin iframe, not sandboxed) at any safe subpath, whose iframe `src` is the relative URL `raw/<id>/<n>/<subpath>` (the current latest `n` for a latest URL; a query string is forwarded). The raw route serves the files: `index.html` for a directory URL, a relative `301` for a directory without a trailing slash, never a listing, never a dotfile. A path segment that is empty, `.`/`..`, dot-led, or holds `/`, `\` or NUL after decoding is 404, as is anything whose real path leaves the version's `content/`.

## App proxy

`app/<id>/…` (HTTP) and WebSocket upgrades to it are proxied to the app on `127.0.0.1` or `[::1]`, whichever answered the readiness probe. It is mounted before the JSON gate, so an app's own form posts pass. Rules live in `src/appRewrite.js`.

- **Upstream path**: `strip` sends the raw sub-path after `/app/<id>` (at least `/`) plus the query; `keep` sends `BASE_PATH` plus that. `BASE_PATH` is `MOUNT/app/<id>` (`MOUNT`, `appBasePath` in `src/links.js`), a constant: an upgrade and an MCP call carry no `X-Forwarded-Prefix`.
- **Request headers** (HTTP and upgrade): `Host` becomes the upstream address (Vite 6 rejects unknown hosts); `X-Forwarded-Host` is the incoming one, else the incoming `Host`; `X-Forwarded-Proto` is incoming, else `http`; `X-Forwarded-Prefix` is `BASE_PATH` (cc's value is replaced); `X-Forwarded-For` is incoming, else the socket address. Everything else (`Cookie`, `Origin`, `Sec-WebSocket-*`) passes unchanged; an upgrade keeps header order and casing. Bodies stream untouched both ways.
- **Response headers**: the plugin's CSP and `X-Content-Type-Options` are removed and the app's headers pass, its own CSP included. Hop-by-hop headers are dropped. An unreachable upstream is `502`.
- **`Location`** is rewritten to the plugin-root form `/app/<id>/…`, because cc prepends the mount to a `/`-led `Location`: a relative value passes; an absolute or protocol-relative value passes unless its origin is the app's own (`127.0.0.1`, `localhost`, `[::1]` on its port, or the forwarded host), in which case it is reduced to path, query and hash; a path equal to `BASE_PATH` or under it loses the mount; any other root-absolute path gains `/app/<id>`.
- **`Set-Cookie`**: a `Path` equal to `BASE_PATH` or under it passes; any other `Path=v` becomes `BASE_PATH` + `v`, so an app cannot shadow cc's or a share's cookies. No `Path`, `Domain` and all other attributes pass.
- **Upgrade** (`server.on('upgrade')`): only `/app/<id>/…` of a running app is piped, raw, to the app (the `101` and frames are not parsed); a `Set-Cookie` on a `101` is not rewritten. Otherwise the answer is `404` or `503` with `Connection: close`, then the socket closes; an unreachable app is `502`.

## Headers

- Every response carries `X-Content-Type-Options: nosniff` and the plugin CSP (`securityHeaders` in `src/webui.js`), the 404, 503 and 415 included.
- **Raw site responses (`raw/…`) and app responses (`app/…`) carry no plugin CSP**: a site runs as authored, and an app carries only the policy it sends itself. The wrapper and every other page keep it, including `frame-src 'self'` for the wrapper's iframe.
- Embedding: `frame-ancestors 'self'`.

## Deep links

`http://cc.internal/#plugin/code-artifact/a/<id>/` and `…/a/<id>/v/<n>/`. The id format has no dot segments, so cc's link validation accepts them.
