# Visual-verification harness

Drives the real UI and the server-rendered pages against a seeded sandbox store, using the shared `code-playwright` utilities, and saves a screenshot per step.

A shell outside code-conductor must first export the absolute projects root:

```bash
export CC_PROJECTS_ROOT=/path/to/projects-root
```

## Run

```bash
npm install                        # builds frontend/dist
node harness/playwright/golden.mjs
```

Screenshots land in `harness/playwright/out/` (gitignored) as `<step>-<desktop|phone>-<light|dark>.png`.

## Files

| File | Role |
|---|---|
| `resolve.mjs` | Resolves the shared harness from `$CC_PROJECTS_ROOT` |
| `seed.mjs` | `bootServer` on a sandboxed `CODE_ARTIFACT_STORE`; publishes a markdown artifact (two versions, the first backdated), a static site, a download and two apps (one that runs, one that fails) over MCP, plus two downloads whose session labels are raw markdown and an unbroken URL, created through the store |
| `golden.mjs` | List, detail, app detail, confirm dialog, prune dialog, cc ⋮ menu arrival (`?ccProject` on load; a simulated `navigate` that retargets without a reload or new history entry; an unknown and a hostile name; a missing name's alert; the filter through detail and Back; **Show all**; row links that match where their click goes; Back clearing the alert) and the markdown, download, static and app pages (stopped, Start, running frame, failed with log), ← Artifacts on every artifact page and its round trip (click, filtered list, Back), in light and dark at desktop and phone width; asserts the key states, that no list or detail page overflows horizontally, and fails on a console error or a failed request (the two host URLs excepted) |

## Notes

- Dark mode comes from `page.emulateMedia`: standalone, `theme-init.js` follows the OS.
- Standalone, `/pluginBridge.js` and `/pluginTheme.css` answer 404 by design; the harness ignores exactly those.
- cc's `navigate` is simulated (`history.replaceState` plus a synthetic `popstate`). Not covered here: behaviour inside a running cc (deep links, the bridge's history handling, a real ⋮ menu click). That needs a cc with the plugin enabled.
