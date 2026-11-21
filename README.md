# jj-harness

A reusable agent harness for Claude Code, shipped as a plugin. Install it once and every project gets:

- **Guardrails**: blocks destructive shell commands and edits to secrets, keys and `.git/`.
- **Verification loop**: runs format on every edit, and runs lint, typecheck and the tests related to the changed files before the agent can stop.
- **Session memory**: injects branch, dirty files and the last progress note at session start.
- **Workflow skills**: `harness-init` (detect the stack, write the config), `plan`, `verify`, `review`, `ship`, `handoff`.
- **Agents**: `reviewer` (read-only, verified findings only) and `test-writer` (tests in the project's style, related tests only). See [Agents](#agents).

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

Commit those four files. Under the hood the skill runs the plugin's CLI, which you can also run yourself: `node <plugin>/bin/harness.mjs init` (a dry run that prints JSON), `init --write [--force-config]`, and `verify [--all | --base <ref>]`. Plain `verify` checks the files that differ from `HEAD`. `--base main` also checks the files the branch changed since `main` (`git diff main...HEAD`), so it works on committed branches. `verify` exits 0 on `verify: passed` and also on `verify: nothing ran`, which means no check executed and is not a pass. It exits 1 when a check fails, and 2 on a usage, config or git error, including an unknown ref.

A config looks like this:

```json
{
  "verify": {
    "format": "npx --no -- prettier --write --ignore-unknown",
    "lint": { "run": "npx --no -- eslint --no-warn-ignored {files}", "files": ["**/*.ts", "**/*.tsx"] },
    "typecheck": { "run": "npx --no -- tsc --noEmit", "files": ["**/*.ts", "**/*.tsx", "**/tsconfig*.json"] },
    "test": { "run": "npx --no -- vitest related --run --passWithNoTests {files}", "files": ["**/*.ts", "**/*.tsx"] }
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

## Agents

The plugin ships two subagents. Claude Code names plugin agents `harness:<name>`.

- **`harness:reviewer`** reviews a diff or a branch against a base ref. It reads the project's `CLAUDE.md`/`AGENTS.md` first, then looks for correctness bugs, security problems (injection, secrets, authorization, unsafe deserialization, path traversal), races and resource leaks, error-handling gaps, missing tests and rule breaches. It checks every finding against the code, reproducing it in a temp dir where it can, and tags it CONFIRMED (reproduced) or PLAUSIBLE (reasoned from the code). It returns findings ranked `blocking` / `should-fix` / `nit`, each with file:line, evidence and a fix, plus a "Checked and fine" list and `Verdict: approve | request changes`. Its tools are `Read, Grep, Glob, Bash`, with no editing tools. It uses Bash for `git diff`/`log`/`show`, the related tests and scratch scripts, and its instructions forbid changing files or git state.
- **`harness:test-writer`** writes tests for a change. It follows the project's runner, layout and nearest existing test, prefers table-driven cases, and changes only test files and fixtures. If a test exposes a real bug, it stops and reports the bug with the failing test instead of fixing production code. It runs only the related tests (the `verify.test` command from `.harness/config.json`, or the files it wrote), then reports the command, the exact output and what it couldn't cover.

To use them:

- **Through the skill**: `/harness:review` collects the diff, sends it to `harness:reviewer` with the base ref and the rules files, re-checks each finding itself, and reports by severity. `review`, `ship` and `plan` offer `harness:test-writer` when changed behaviour has no tests.
- **Directly**: mention the agent (`@agent-harness:reviewer review my branch against main`), or ask Claude to "use the harness:test-writer agent to cover `src/parse.ts`".
## Develop

```sh
npm test
claude --plugin-dir .   # try the plugin locally
```
