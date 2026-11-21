# jj-harness

A reusable agent harness for Claude Code, shipped as a plugin. Install it once and every project gets:

- **Guardrails**: blocks destructive shell commands and edits to secrets, keys and `.git/`.
- **Verification loop**: runs format on every edit, and runs lint, typecheck and the tests related to the changed files before the agent can stop.
- **Session memory**: injects branch, dirty files and the last progress note at session start.
- **Workflow skills**: `harness-init`, `plan`, `verify`, `review`, `ship`, `handoff`.
- **Agents**: `reviewer` (read-only), `test-writer`.

> Status: **in progress**. Progress and a per-step completion log are in [`docs/ROADMAP.md`](docs/ROADMAP.md); the design is in [`docs/design/rationale.md`](docs/design/rationale.md).

## Install

```sh
/plugin marketplace add rajitharx/jj-harness
/plugin install harness@jj-harness
```

Then, in any project:

```
/harness:harness-init
```

That writes `.harness/config.json`, which is the only file the harness reads per project:

```json
{
  "verify": {
    "format": "npx prettier -w",
    "lint": "npx eslint {files}",
    "typecheck": "npx tsc --noEmit",
    "test": "npx vitest related --run {files}"
  },
  "protectedPaths": ["secrets/**"],
  "blockedCommands": ["terraform destroy"],
  "stopGate": { "enabled": true, "maxAttempts": 3, "timeoutSec": 300 },
  "formatTimeoutSec": 30
}
```

The Stop gate checks only what changed, not the whole suite:

- **`{files}`** in any `verify` command is replaced with the shell-quoted, root-relative paths of the files that differ from `HEAD` (modified, added, renamed and untracked; deleted files and `.harness/` are left out). If no files changed, that stage is skipped. Use it for related-test and per-file lint commands, e.g. `jest --findRelatedTests {files}` or `vitest related --run {files}`.
- A command **without** `{files}` runs as written. That suits `typecheck`, which needs the whole project.
- **`format`** runs after every edit on the edited file, limited by `formatTimeoutSec`. Without `{files}`, the file path is appended. A path starting with `-` is passed as `./-name`, so it can't be read as an option.
- Before the agent stops, lint, typecheck and test run in that order, each with a `stopGate.timeoutSec` limit and all within an overall 840 s budget (below the 900 s hook timeout). The first failure blocks the stop with its output. A passing tree is fingerprinted, so stopping again without changes doesn't re-run anything. After `stopGate.maxAttempts` blocks in a row, the gate gives up for that turn.
- Harness state lives in `.harness/state/`, which ignores itself in git.

## Develop

```sh
npm test
claude --plugin-dir .   # try the plugin locally
```
