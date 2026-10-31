# Mutation harness

Config for the shared `code-mutant` runner, so a prover can run `/code-mutant:prove` against this project.

A shell outside code-conductor must first export the absolute projects root:

```bash
export CC_PROJECTS_ROOT=/path/to/projects-root
```

## Configuration (`config.json`)

| Key | Value | Why |
|---|---|---|
| `baselineCommand` | `node tests/run.mjs` | the whole suite: backend and pure UI logic, run through the programmatic runner |
| `testCommand` | `node tests/run.mjs {tests}` | `{tests}` is narrowed to the mutant's test files; the runner takes file paths as arguments |
| `runner` | `node-test` | the runner prints node:test counts, and exits 0 whenever no test failed |
| `isolation` | `copy` | every test builds its own temp store on port 0; `server.test.mjs` spawns `node server.js` from the copy's own root on a free port; nothing shells out to git; `node_modules` is symlinked via `preserve` |
| `baseBranch` | `main` | the integration branch |

## Scope

- Judges everything `npm test` runs: `server.js`, `src/`, the pure UI logic in `frontend/src/lib/artifacts.ts` and the style guards.
- React components and `npm run typecheck` are not mutation-judged; a harness takes one runner.
- Needs a clean worktree; commit before running.

## Commands

```bash
node "$CC_PROJECTS_ROOT/.plugins/code-mutant/mutate.mjs" baseline
node "$CC_PROJECTS_ROOT/.plugins/code-mutant/mutate.mjs" validate
node "$CC_PROJECTS_ROOT/.plugins/code-mutant/mutate.mjs" run --all
node "$CC_PROJECTS_ROOT/.plugins/code-mutant/mutate.mjs" candidates
```

`run` needs a catalog at `.mutation/mutants.json` (gitignored, authored per review); see `mutants.schema.md` in the runner's directory.

## Verified

`baseline` (without `--no-canary`) was run in copy isolation and exited 0. Read its result as: the baseline gate `PASSED` with the full suite's pass count and no failures or skips, and the canary gate `KILLED [counted grade, baseline scope]`. `run`, `validate` and `candidates` were not run: no catalog exists.
