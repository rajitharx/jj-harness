# jj-harness

A reusable agent harness for Claude Code, shipped as a plugin. Install it once and every project gets:

- **Guardrails**: blocks destructive shell commands and edits to secrets, keys and `.git/`.
- **Verification loop**: runs format on every edit, and runs lint, typecheck and the tests related to the changed files before the agent can stop.
- **Session memory**: injects branch, dirty files and the last progress note at session start.
- **Workflow skills**: `harness-init` (detect the stack, write the config), `plan`, `verify`, `review`, `ship`, `handoff`.
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

`harness-init` detects the stack (Node with npm/pnpm/yarn/bun, Python with uv/poetry/pip, Go, Rust) and proposes verify commands that check only the changed files. It tries each command once, asks you about anything it can't decide (for example, Rust has no related-test mode), and then writes:

- `.harness/config.json`, the only file the harness reads per project. An existing one is kept unless you agree to replace it.
- `CLAUDE.md` and `AGENTS.md`. If they already exist, only a block between `<!-- harness:start -->` and `<!-- harness:end -->` is inserted or updated. Your text is left as is.
- `.harness/progress.md`, for the `handoff` skill's notes.

Commit those four files. Under the hood the skill runs the plugin's CLI, which you can also run yourself: `node <plugin>/bin/harness.mjs init` (a dry run that prints JSON), `init --write [--force-config]`, and `verify [--all]`.

A config looks like this:

```json
{
  "verify": {
    "format": "npx --no prettier --write --ignore-unknown",
    "lint": { "run": "npx --no eslint --no-warn-ignored {files}", "files": ["**/*.ts", "**/*.tsx"] },
    "typecheck": { "run": "npx --no tsc --noEmit", "files": ["**/*.ts", "**/*.tsx", "**/tsconfig*.json"] },
    "test": { "run": "npx --no vitest related --run --passWithNoTests {files}", "files": ["**/*.ts", "**/*.tsx"] }
  },
  "protectedPaths": ["secrets/**"],
  "blockedCommands": ["terraform destroy"],
  "stopGate": { "enabled": true, "maxAttempts": 3, "timeoutSec": 300 },
  "formatTimeoutSec": 30
}
```

Each `verify` entry is either a command string or `{ "run": "<command>", "files": ["<glob>", …] }`.

The Stop gate checks only what changed, not the whole suite:

- **`{files}`** in a command is replaced with the shell-quoted, root-relative paths of the files that differ from `HEAD`: modified, added, renamed and untracked. Deleted files and `.harness/` are left out. Use it for related-test and per-file lint commands, e.g. `jest --findRelatedTests {files}` or `vitest related --run {files}`.
- **`{dirs}`** is replaced with the unique directories of those files (`.` for the root, `./pkg/x` otherwise). Use it for tools that work per package, e.g. `go test {dirs}`.
- **`files`** narrows the changed files to the matching globs (`**`, `*`, `?`) before substitution. If no changed file matches, the stage is skipped, so a docs-only change never reaches eslint or pytest. A command with a filter but no placeholder, like `tsc --noEmit` above, runs only when a matching file changed.
- A command with no placeholder and no filter runs as written. That suits `typecheck`, which needs the whole project.
- **`format`** runs after every edit on the edited file, limited by `formatTimeoutSec`. Without a placeholder, the file path is appended. A path starting with `-` is passed as `./-name`, so it can't be read as an option.
- Before the agent stops, lint, typecheck and test run in that order. Each stage has a `stopGate.timeoutSec` limit, and the whole run has an 840 s budget (below the 900 s hook timeout). The first failure blocks the stop and shows its output. A passing tree is fingerprinted, so stopping again without changes doesn't re-run anything. After `stopGate.maxAttempts` blocks in a row, the gate gives up for that turn.
- Harness state lives in `.harness/state/`, which ignores itself in git.

## Develop

```sh
npm test
claude --plugin-dir .   # try the plugin locally
```
