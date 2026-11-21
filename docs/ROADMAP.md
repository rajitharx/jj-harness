# Roadmap

Each step is a checklist. When a step is done, tick its boxes, set its status, and add an entry to the [completion log](#completion-log) with what shipped, how it was verified, and any changes from the sketch.

Status key: ⬜ not started · 🟡 in progress · ✅ done

| # | Step | Status |
| - | ---- | ------ |
| 0 | Scaffold and design sketch | ✅ |
| 1 | Core runtime: config and hook dispatch | ✅ |
| 2 | Guardrails | ✅ |
| 3 | Quality loop | ✅ |
| 4 | Workflow skills | ✅ |
| 5 | Agents | ✅ |
| 6 | Dogfood and release | ✅ |
| 0.1.1 | Post-0.1.0: doc fixes and gate notices | ✅ |
| 0.2.0 | Monorepo and .NET support in `harness-init` | ✅ |

## 0. Scaffold and design sketch ✅

- [x] Plugin manifest and marketplace entry (`.claude-plugin/`)
- [x] One hook entry point (`hooks/run.mjs`) and policy registry (`hooks/policies/index.mjs`)
- [x] Stub modules, skills, agents and templates with `not implemented` bodies
- [x] CI workflow, MIT license, README
- [x] Design rationale (`docs/design/rationale.md`)
- [x] `CLAUDE.md` describing the repo rules and the task workflow (branch → implement → document → PR → separate reviewer → squash-merge)

## 1. Core runtime: config and hook dispatch ✅

- [x] `lib/config.mjs`: find the project root, read `.harness/config.json`, validate it, merge it over the defaults, freeze the result
- [x] `lib/harness.mjs`: `runHook` runs each policy and fails open on crashes or bad verdicts; `mergeVerdicts` turns verdicts into Claude Code's hook JSON for each event
- [x] `hooks/run.mjs`: survives bad stdin and unexpected errors, and always exits 0
- [x] Tests: `test/config.test.mjs`, `test/harness.test.mjs`, `test/run.test.mjs`

## 2. Guardrails ✅

- [x] `guard-bash`: deny `rm -rf` on root, home, `.`/`..` or bare globs; force-push (`--force`, `-f`, `--force-with-lease`, `+refspec`, or a plain force-push while on main) to main/master, and deleting main/master; piping a download into a shell (`curl … | sh`, `bash <(curl …)`, `sh -c "$(curl …)"`); `DROP`/`TRUNCATE` sent to a database client; `mkfs`, `dd of=/dev/…`, `chmod -R … /` and fork bombs; plus `config.blockedCommands`. Rules are one table, checked over a quote-aware parse of the command, including heredocs, substitutions and nested `bash -c`/`eval` strings
- [x] `guard-paths`: deny Edit/Write/MultiEdit/NotebookEdit on `config.protectedPaths` (zero-dependency glob matching relative to `config.root`; `**/` patterns also match absolute paths outside the root)
- [x] Tests: tables of commands and paths that must be denied, and ones that must be allowed, plus an end-to-end `run.mjs` deny

## 3. Quality loop ✅

- [x] `lib/verify.mjs`: the one way to run a `verify.*` command. `{files}` is replaced with the shell-quoted, root-relative changed files (stage skipped when there are none); `format` without `{files}` gets the path appended; other commands run as written. Runs through the shell in `config.root` with `CI=1` and a timeout that kills the process group
- [x] `format-on-edit`: after Edit/Write/MultiEdit, run `verify.format` on the edited file (30 s limit); silent on success, failure tail as context, never blocks
- [x] `verify-gate`: on Stop, if the tree differs from HEAD (`git status --porcelain`), run lint, typecheck and test (related files only where the command uses `{files}`), each limited by `stopGate.timeoutSec`; block with the stage, command and output tail; skip re-runs when the changed-file fingerprint matches the last pass; give up after `stopGate.maxAttempts` consecutive blocks per session (`stop_hook_active` alone never bypasses it)
- [x] `session-context`: branch, dirty files (first 10), verify commands with the `{files}` note, the last 40 lines of `.harness/progress.md`, and a `harness-init` hint when there's no config; about 2 KB at most
- [x] Hook timeouts in `hooks.json`: Stop 900 s, PostToolUse 60 s
- [x] Tests for each policy against real temp git repos, including the loop guard, fingerprint, per-session attempts, timeouts and fail-open paths

## 4. Workflow skills ✅

- [x] Per-command file filters: a `verify.*` entry is a string or `{ "run": "<cmd>", "files": ["**/*.ts"] }`, validated and normalized to one shape in `lib/config.mjs`. `runStage` narrows the changed files to the filter before substitution and skips the stage when none match; a `{dirs}` placeholder gives the changed files' directories (`.` or `./dir`). The glob matcher moved to `lib/glob.mjs`, shared with `guard-paths`
- [x] `lib/detect.mjs`: `detectProject(root)` proposes related-only, file-filtered commands per stack, so the Stop gate checks only related tests: node (npm/pnpm/yarn/bun; `vitest related`, `jest --findRelatedTests`, `node --test {files}`; eslint `--no-warn-ignored` or biome; prettier or biome format; `tsc --noEmit`), python (uv/poetry; `pytest --testmon` or `pytest {files}` on test files; `ruff check`/`ruff format`; mypy or pyright), go (`go test {dirs}`, `go vet {dirs}`, `gofmt -w`, golangci-lint), rust (`rustfmt --edition …`, `cargo clippy`, `cargo check`, no test command). Strict tools never see docs or config files
- [x] `bin/harness.mjs`: `init [--write] [--force-config]` (dry-run JSON proposal; writes the config, a marker block in `CLAUDE.md`/`AGENTS.md`, and `progress.md`; idempotent; never overwrites user content) and `verify [--all]` (lint, typecheck, test through `runStage` on the changed files)
- [x] `harness-init`: dry run, try each command once, ask about the notes, `init --write`, remind to commit
- [x] `plan`: explore, write `.harness/plans/<yyyy-mm-dd>-<slug>.md` (Goal, Constraints, Steps with verification, Risks, Out of scope), stop for approval
- [x] `verify`: run `bin/harness.mjs verify` and report the output exactly
- [x] `review`: send the diff to the `harness:reviewer` agent, verify each finding, rank by severity
- [x] `ship`: refuse on main/master, verify, stage by path but never protected files, conventional commit, push, `gh pr create` with the repo's template; never force-push or merge
- [x] `handoff`: append a short dated progress entry (Done, In progress, Next, Open questions, Gotchas)
- [x] Tests: `test/glob.test.mjs`, `test/detect.test.mjs`, `test/cli.test.mjs`, `test/skills.test.mjs`, plus filter and `{dirs}` cases in the verify, config, gate and session-context tests

## 5. Agents ✅

- [x] `reviewer` (`agents/reviewer.md`): tools `Read, Grep, Glob, Bash` only. Reads `CLAUDE.md`/`AGENTS.md`, reviews a diff or base ref for correctness, security, concurrency/resource, error-handling, test-gap and project-rule problems. Checks every finding against the code or reproduces it in a temp dir outside the repo, tags it CONFIRMED or PLAUSIBLE, drops what it can't support, and returns `blocking`/`should-fix`/`nit` findings (file:line, claim, why, evidence, fix), a "Checked and fine" list, the checks it ran (`bin/harness.mjs verify --base <base>` when given the plugin path; "nothing ran" reported as no checks executed) and `Verdict: approve | request changes`. Its prompt forbids any file or git-state change
- [x] `test-writer` (`agents/test-writer.md`): explicit tools `Read, Grep, Glob, Edit, Write, Bash`. Learns the runner, layout and nearest test's style; writes table-driven tests for happy, edge, error and regression cases; changes only tests and fixtures, and reports real bugs with the failing test instead of fixing code; no network, sleeps or fixed temp paths; runs only the related tests (`verify.test` with `{files}`, or the files it wrote) and reports the exact output and what it couldn't cover
- [x] `review` skill passes the base ref, diff commands, rules files and plugin path (with `verify --base <base>`) to `harness:reviewer`, re-verifies each finding, and reports by severity with the verdict; `review`, `ship` and `plan` offer `harness:test-writer` for untested behaviour
- [x] Tests: `test/agents.test.mjs` (frontmatter, documented fields only, reviewer has no editing tool, every `harness:<agent>` reference in skills resolves); the frontmatter parser moved to `test/helpers.mjs`
- [x] Step 4 follow-up: rustfmt's edition for `edition.workspace = true` comes from the workspace root's `[workspace.package]` (`lib/detect.mjs`)

## 6. Dogfood and release ✅

- [x] Official validation: `claude plugin validate .` passes with no errors; the marketplace description, marketplace `version` and `network.hosts` warnings are fixed, and CI runs the validator (it needs no credentials)
- [x] End-to-end hook test (`test/e2e.test.mjs`): one session through `hooks/run.mjs`, spawned exactly as `hooks/hooks.json` does, against a fixture git repo with stub verify commands
- [x] Live dogfood with `claude -p --plugin-dir`: three headless sessions in a temp fixture (guard-paths deny, format-on-edit plus the Stop gate, `/harness:verify` plus a live Stop block). Report in `docs/dogfood-v0.1.0.md`
- [x] Release readiness: `CHANGELOG.md`, the `plugin.json` and `package.json` versions agree and the marketplace entry carries no version (`test/release.test.mjs`), CI on Node 22/24 × Ubuntu/macOS, README rewrite with a config reference checked against `lib/config.mjs`
- [x] Release checklist (README, "Release checklist"): `claude plugin tag` creates `harness--v0.1.0`, then `gh release create --verify-tag`. Tagging and the release are done by the orchestrator after this PR merges, not in this branch

## Post-0.1.0 ✅

Release 0.1.1: the PR #6 review's doc fixes and a visible Stop gate.

- [x] README release checklist: say what `claude plugin tag` checks (the marketplace version is compared only when the entry sets one, which ours doesn't; a dirty tree or an existing tag is refused)
- [x] `docs/ROADMAP.md` step 6: `plugin.json` and `package.json` agree, and the marketplace entry carries no version
- [x] README Quickstart: `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` described as the host-marketplace docs do (adding an `owner/repo` marketplace already falls back to HTTPS; `/plugin` installs and updates don't)
- [x] `{ kind: "notice", text }` verdict: `mergeVerdicts` maps notices to the top-level `systemMessage` on every event, joined, capped at 1,000 characters, alongside any block or context; an empty notice fails open as an invalid verdict
- [x] `verify-gate` notices: a pass lists each configured stage as ✓ or skipped with the changed-file count; all skipped says "no checks ran"; the fingerprint skip stays silent; give-up, deadline, unsaved-counter and unreadable-counter allows say so
- [x] Tests: table-driven mapping, combination, capping and invalid-notice cases in `test/harness.test.mjs`; notice content, skipped stages, nothing-ran, silent paths and every allow-without-pass notice in `test/verify-gate.test.mjs`; `systemMessage` on the passing, give-up and unreadable-counter Stops in `test/e2e.test.mjs`
- [x] Release 0.1.1: `plugin.json` and `package.json` bumped, `CHANGELOG.md` entry with compare links on the `harness--v<version>` tags

---

## 0.2.0: Monorepo and .NET support ✅

- [x] Detect stacks in the root's immediate subdirectories and in `apps/*`, `packages/*`, `services/*`, alongside or instead of the root (stdlib only)
- [x] .NET detection (`*.sln`, `*.slnx`, `*.csproj`) with `dotnet test`, flagged in `notes` as a full-suite command for the user to confirm
- [x] Per-package commands: `cwd` on a verify entry and arrays of entries per stage (schema extension, rationale recorded in `docs/design/rationale.md`); `lib/config.mjs` stays the only module that knows the schema; README config table and defaults block in sync
- [x] `harness-init` skill: reports the detected packages, asks which the Stop gate should check (`init --packages`), checks each command once
- [x] Tests: monorepo fixture (two npm apps and a .NET project), single-stack (no regression) and empty repo, plus `cwd` runtime, gate, session-context and CLI cases
- [x] README quickstart and `init --write` output mention `/reload-plugins` for a plugin installed mid-session

## Completion log

### Step 0: Scaffold and design sketch (2026-11-21)

**Shipped:** the plugin layout and a stub for every module. Private repo created at `rajitharx/jj-harness`.
**Verified:** `test/registry.test.mjs` checks that `hooks.json` and the policy registry name the same events.
**Decision:** a plugin plus a per-project config file, instead of copying a template into each repo. See the rationale doc.

### Step 1: Core runtime (2026-11-21)

**Shipped**
- `loadConfig(cwd)` walks up to the nearest directory containing `.harness/` or `.git`, validates every field (verify keys, string arrays, regexes, `stopGate` types), drops empty verify commands, and returns a deep-frozen config. Malformed files throw `ConfigError`.
- `runHook(event, input)` loads the config. If the config is invalid, it logs that and uses the defaults, which keeps secret protection on. It then runs the event's policies in parallel and turns the verdicts into Claude Code's JSON output:
  - **PreToolUse:** any block → `permissionDecision: "deny"` with all reasons joined
  - **PostToolUse:** block → `decision: "block"`; context → `additionalContext`
  - **Stop:** block → `decision: "block"`; context is dropped, because Stop has no context channel
  - **SessionStart:** blocks and context are both shown as `additionalContext`
- Fail open: a policy that throws or returns a malformed verdict is logged to stderr and counted as allow. Unknown events are ignored. `run.mjs` exits 0 even on bad stdin.

**Verified:** `npm test` gives 25/25 passing (config defaults, root discovery, merging, freezing, 8 rejection cases, verdict merging for each event, the fail-open paths, and spawning the entry point).

**Changes from the sketch**
- `HookResult.exitCode` is always `0` (it was `0 | 2`). Claude Code reads stdout JSON only on exit 0, and JSON can carry reasons and context for each event, so exit code 2 isn't needed.
- `HarnessConfig` gained `root`. Path guards and session context need the project root, and only the config module knows how to find it.
- `runHook` takes an optional third argument, `{ policies, log }`, used only by tests. It's the smallest way to test merging without exporting internals.
- Project `protectedPaths` **add to** the defaults instead of replacing them, so a project can't accidentally turn off `.env` protection. `templates/config.json` now starts with an empty list, so the defaults aren't listed twice.

**Known gap:** the five policies were stubs that throw. Step 2 implemented `guard-bash` and `guard-paths`. The step 3 policies (`format-on-edit`, `verify-gate`, `session-context`) still log a "not implemented" line to stderr on their events and allow the action.

### Step 2: Guardrails (2026-11-21)

**Shipped**
- `guard-bash` (PreToolUse, Bash only): one `RULES` table of `{ scope, test, reason }`. A small quote-aware parser splits the command into pipelines (on `&&`, `||`, `;`, `&`, newlines, parentheses) and segments (on `|`). It attaches heredoc bodies to the command that reads them, records command substitutions (`$(…)`, backticks, `<(…)`), and strips wrappers (`sudo`, `env`, `VAR=x`, `nohup`, `nice`, `timeout <n>`, `xargs`, …). Rules run on the raw command, on each pipeline or on each segment, whichever the check needs. Substitutions, `bash -c "…"`, `eval "…"` and heredocs fed to a shell are checked recursively. It blocks:
  - `rm` with recursive and force flags in any spelling, on `/`, `/*`, `~`, `~/`, `$HOME`, `*`, `.*`, `.`, `..`, `../..`, `./*`, `../*`, `$PWD`, `$(pwd)`, including `echo / | xargs rm -rf` (`rm -rf node_modules dist` is allowed)
  - `git push` with `--force`, `-f`, `--force-with-lease` or `+refspec` to `main`/`master` (including `HEAD:main` and `refs/heads/main`). With no refspec or a `HEAD` destination, the current branch is read from `<root>/.git/HEAD`, following a worktree's `gitdir:` file; if it can't be read, the push is allowed. Force-pushes to other branches are allowed
  - deleting main/master on the remote (`git push origin :main`, `--delete main`)
  - downloads piped or substituted into a shell (`curl … | sh`, `| sudo bash`, `/bin/bash <(curl …)`, `bash -lc "$(curl …)"`, `eval "$(curl …)"`, `source <(curl …)`); quoted mentions such as `echo "bash <(curl …)"` and `curl … | jq` and `| python3 -m json.tool` are allowed
  - `DROP DATABASE|SCHEMA|TABLE`, `TRUNCATE` and Mongo `dropDatabase()` when the same pipeline invokes psql, mysql, mariadb, sqlite3, sqlcmd or mongosh, including SQL passed in a heredoc
  - `mkfs*`, `dd of=/dev/…` (except `/dev/null`, stdout, stderr), `chmod -R` on `/`, fork bombs
  - any `config.blockedCommands` regex; the reason names the pattern

  Each reason has the form ``Blocked `<command>`: <why>. <safer alternative>``.
- `guard-paths` (PreToolUse, Edit/Write/MultiEdit/NotebookEdit): resolves the path against `cwd` (expanding a leading `~`), makes it relative to `config.root`, and matches it against `config.protectedPaths` with a private glob-to-RegExp compiler (`**`, `*`, `?`, wildcards match dot-files, case-insensitive because macOS and Windows filesystems are). For paths outside the root, only `**/` patterns apply, matched against the absolute path, so `~/.ssh/id_ed25519` is caught. The reason names the matched pattern.
- `hooks.json`: the PreToolUse matcher now includes `NotebookEdit`, so `guard-paths` sees notebook edits.

**Verified:** `npm test` gives 197/197 passing after review round 2 (141/141 at first push, 191/191 after round 1). That covers 83 must-block and 49 must-allow commands, 14 must-block and 8 must-allow paths, current-branch force-pushes against fixture repos (plain `.git` and a worktree `gitdir:`, plus detached and unreadable HEAD), a linear-time check on 200 KB commands, glob-semantics and outside-the-root cases, `blockedCommands`, and an end-to-end `run.mjs PreToolUse` deny for `rm -rf /`.

**Changes from the sketch**
- Dropped "`git reset --hard` on shared branches" from `guard-bash`. It only touches the local working tree and branch (the reflog can recover commits), it has no remote target to check, and it's a common, legitimate command for agents. A project can still add it to `blockedCommands`.
- Added `dd`, `mkfs`, `chmod -R /` and fork-bomb rules, and `--force-with-lease` to main counts as a force-push.
- The glob matcher is private to `guard-paths` instead of `lib/glob.mjs`, because nothing else needs it yet.
- `.envrc.example` is allowed on purpose: the default patterns are `.env` and `.env.*`, and `.envrc…` has no dot after `.env`.

**Review follow-ups (from the PR #1 review)**
- `hooks/run.mjs` sets `process.exitCode` instead of calling `process.exit()`, so stdout over 64 KB isn't cut off on macOS pipes. `mergeVerdicts` caps block reasons and context at 16 KB with a `…[truncated]` marker. A spawned-`run.mjs` test with a reason over 64 KB checks that stdout parses.
- `package.json` `engines.node` is `>=22` (the test glob needs Node 21+); `CLAUDE.md` and the rationale say Node ≥22.
- `normalize` rejects a `block` with an empty or whitespace-only reason (fails open as an invalid verdict).
- `loadConfig` rejects unknown `stopGate` keys.
- Added tests for context-only PreToolUse output and SessionStart blocks shown as context.

**Review round 1 (PR #2)**
- Heredoc bodies are attached to the command that reads them, so `psql <<EOF … DROP TABLE … EOF` and `psql "$DATABASE_URL" <<'SQL' … SQL` are blocked. A heredoc fed to a shell (`bash <<EOF`) is checked as a nested command.
- The download-into-shell check is now a segment rule on the parsed command. The shell is matched by basename (`/bin/bash`), `-c` may be part of a flag cluster (`-lc`), and `<(…)`, `$(…)` and backticks are recognised as substitutions. Raw-string regexes are gone, so quoted mentions (`echo "run: bash <(curl …)"`, commit messages) are allowed.
- A force-push with no refspec or a `HEAD` destination uses the current branch from `.git/HEAD`. The read is in a small `readCurrentBranch(root)` helper, happens lazily, and fails open.
- Deleting main/master (`:main`, `--delete`, `-d`) is blocked.
- The fork-bomb regex is anchored with a lookbehind, so it runs in linear time. A 200 KB single token took about 20 s before.
- `timeout <n>`, `nice`, `nohup`, `stdbuf` and `xargs` wrappers are stripped. `echo /` or `printf` piped into `xargs rm -rf` is checked. `../..`, `.*`, `../*`, `$PWD` and `$(pwd)` are dangerous rm targets.
- guard-paths matches case-insensitively (`.ENV`, `server.KEY`), and an in-root directory named `..foo/` counts as inside the root.

**Review round 2 (PR #2)**
- Fixed a round-1 regression. The parser read `<<<` (a here-string) as a heredoc and dropped the quoted SQL, so `mysql -u root <<< "DROP DATABASE prod"` got through. `<<<` is now one token and the word after it stays in the command. `mysql <<<`, `psql <<<` and `psql -c … <<<` are blocked; `grep foo <<< "DROP TABLE"` is still allowed. `npm test`: 197/197 passing.

**Known gaps**
- The guards are best-effort pattern matching, not a sandbox. Obfuscation gets past them: variables such as `$DIR` (only the literal `$PWD`/`$(pwd)` forms are caught), aliases, base64, and scripts written to a file and then run.
- SQL in files isn't visible: `psql -f drop.sql` and `psql < drop.sql` are allowed.
- The SQL rule treats a whole pipeline as one unit, so it can give false positives, e.g. `cat schema.sql | grep -v "DROP TABLE" | psql` is blocked.
- The current branch comes from `config.root`. A push after `cd` into another repo, or a `push.default` that targets a different upstream, can be judged against the wrong branch.
- `.git` inside submodules or other repos isn't protected, because the default is `.git/**`, not `**/.git/**`.
- The defaults block `.env.example` (it matches `.env.*`), and because project `protectedPaths` only extend the defaults, a project can't unblock it. Open question: a future `allowPaths` setting, or excluding `.env.example`/`.env.sample`/`.env.template` by default. `.envrc` isn't protected by default.
- Case-insensitive path matching also applies on case-sensitive Linux filesystems. That's slightly over-protective, but safe.
- A script piped or here-stringed into a shell isn't checked as a nested command: `echo 'rm -rf /' | bash` and `bash <<< "rm -rf /"` are allowed. Only heredocs fed to a shell, `bash -c`, `eval` and substitutions are re-parsed. (Raised in the PR #2 review.)

### Step 3: Quality loop (2026-11-21)

**Shipped**
- `lib/verify.mjs` (private helper): `runStage(name, config, files, { timeoutMs })` returns `{ ok, skipped, output, command, exitCode, timedOut }`. It owns the `{files}` placeholder: substitution with shell-quoted, root-relative paths (plain paths stay unquoted for readability), skipping a `{files}` stage when no files changed, and appending the path for `format`. Commands run through the shell in `config.root` with `CI=1`, in their own process group so a timeout SIGKILLs the whole tree. Output is kept as a 64 KB tail. It never throws.
- `lib/git.mjs` (private helper): `changedFiles(root)` parses `git status --porcelain=v1 -z --untracked-files=all -- .`. Renames use the new path, deleted files are flagged, and paths are relative to `config.root` even when it's a subdirectory of the repo. `currentBranch(root)` runs `git rev-parse --abbrev-ref HEAD`.
- `verify-gate` (Stop): allows when disabled, when no lint/typecheck/test is configured, or when nothing changed. Otherwise it fingerprints the changed files (path, mtime, size) plus the gate commands, and allows without running if that matches the last pass. It then runs lint → typecheck → test with `{files}` = changed, non-deleted files outside `.harness/`, and stops at the first failure with a `block` that names the stage, the exact command, why it failed (exit code or `timed out after Ns`), the last 8 KB of output, and "fix it, the gate will re-run (attempt n of max)". A full pass saves the fingerprint and resets the session's attempt count. After `stopGate.maxAttempts` consecutive blocks for one `session_id`, it allows, logs "gave up after N attempts" and resets the count, so the next turn gets a fresh budget. If git fails, it logs and allows.
- State: `<root>/.harness/state/verify-gate.json` (`{ fingerprint, attempts: { [sessionId]: n } }`), read and written only by `verify-gate`. Writes are atomic (temp file + rename), a corrupt file is treated as empty, and at most 20 sessions are kept. Creating `.harness/state/` also writes a `.gitignore` containing `*`.
- `format-on-edit` (PostToolUse): Edit/Write/MultiEdit on an existing file inside the root runs `runStage("format", config, [file], { timeoutMs: 30000 })`. Success is silent; failure returns context with a 1.5 KB tail. It never blocks.
- `session-context` (SessionStart): branch; `Dirty files (n)` with the first 10 (deleted ones marked) or "Working tree: clean"; the verify commands with the `{files}` note and a reminder about the Stop gate; the last 40 lines of `.harness/progress.md` (capped at 1.2 KB); and a `/harness:harness-init` hint when `.harness/config.json` is missing. Git lines are dropped when git fails. The whole block is capped at 2 KB.
- Config: `stopGate.timeoutSec` (integer ≥ 1, default 300) in `lib/config.mjs` and its typedef. `hooks.json`: Stop `timeout` 900, PostToolUse `timeout` 60.
- Docs: the `{files}` convention in the README config example (with a related-test command) and in `templates/CLAUDE.md`; `timeoutSec` in `templates/config.json`.

**Verified:** `npm test` gives 237/237 passing. New tests:
- `test/verify.test.mjs`: placeholder tables; quoting of spaces, quotes, `$`, backticks and `;`, checked by a command that echoes its argv; skips; format appending; non-zero exit; CI and cwd; timeout kill; output tail.
- `test/verify-gate.test.mjs`, against real temp git repos: clean tree; disabled; no commands; a failure reason with stage, command and tail; stage order; the 8 KB cap; a pass and then no re-run, proven with a counter file; re-runs after an edit, an add and a delete; a command change invalidating the fingerprint; the maxAttempts give-up and reset; `stop_hook_active` not bypassing; per-session counts; a pass resetting the count; `{files}` getting modified, added, renamed and untracked files but not deleted or `.harness/` ones; skipping on deletions only; `timeoutSec`; not a git repo; a corrupt state file.
- `test/format-on-edit.test.mjs`, `test/session-context.test.mjs`, `timeoutSec` config cases, and an end-to-end `run.mjs` SessionStart context plus Stop block.

**Changes from the sketch**
- **Related tests only.** The sketch ran the full lint, typecheck and test on Stop. The user decided the gate runs only tests related to the changed files, built as one mechanism: the `{files}` placeholder in any `verify.*` command. Commands without it run as written (right for typecheck), and `format` appends the path. This settles the rationale's open question.
- **`stopGate.timeoutSec`** (new config key, default 300) bounds each stage. A timed-out stage is a failure that says so.
- **"Tree changed" means the working tree vs HEAD**, from `git status`, not "changed this session". It's stateless and also sees changes made through Bash.
- **Fingerprint and state file.** So an unchanged tree doesn't re-run the checks on every stop, a pass stores a fingerprint in `.harness/state/verify-gate.json`. It's computed after the run, so files the checks touch don't force another run, and it includes the gate commands, so editing them re-runs the gate.
- **Loop guard.** The sketch said "respect `stop_hook_active`". The bound is the per-session attempt counter instead, and `stop_hook_active` alone doesn't bypass the gate. Giving up resets the counter, so the next turn is gated again.
- `.harness/` files aren't passed to `{files}`, because they're never lint or test input. They still count as changes for the fingerprint.
- Two small private helpers, `lib/verify.mjs` and `lib/git.mjs`, so format-on-edit, verify-gate and session-context share one way to run commands and one `git status` parser.

**Review round 1 (PR #3)**
- **Loop guard fails open when state can't be saved (blocking).** Before, a read-only `.harness/` or a directory at `.harness/state/verify-gate.json` kept the attempt count at 0, so the gate blocked forever. Now `writeState` reports failure, and a failing stage whose count can't be saved allows (logged). As a backstop, a continuation (`stop_hook_active: true`) with an unreadable state file allows without running. Tests cover both repros (the chmod case is skipped as root) and the backstop.
- **Leading `-` in file names (blocking).** `-rf`, `--x=1` or `--config=evil.js` reached `eslint {files}` as options. `pathArg` in `lib/verify.mjs` prefixes such paths with `./` before quoting, for both `{files}` and the format append. Table rows cover it alone and combined with spaces, quotes and `$(…)`, and an argv-echo run checks them end to end.
- **Overall deadline.** One Stop gets 840 s in total (below the 900 s hook timeout in `hooks.json`). Each stage runs with `min(stopGate.timeoutSec, remaining)`, and once the deadline passes the gate allows and logs. `runStage` also catches SIGTERM, SIGINT and SIGHUP while a stage runs, kills the stage's process group, and re-raises the signal. A test SIGTERMs a parent process running a stage with a background grandchild and checks that both are gone (and fails if the handler is removed).
- **`.gitignore` whenever missing.** `.harness/state/.gitignore` is written whenever it's missing, not only when the directory is created.
- **Defaults in `lib/config.mjs` only.** The duplicate `?? 300` in `lib/verify.mjs` is gone. The format limit is a new validated top-level key, `formatTimeoutSec` (integer ≥ 1, default 30), in the typedef, `templates/config.json` and the README. `runStage` defaults to `formatTimeoutSec` for `format` and `stopGate.timeoutSec` for the other stages.
- `npm test`: 246/246 passing.

**Known gaps**
- "Changed files" includes edits the user made before the session, and anything else uncommitted, so the gate can block on someone else's work in progress.
- A change committed mid-turn no longer counts as changed, so the gate doesn't check it.
- The fingerprint uses mtime and size, so a change that keeps both (rare, e.g. a tool that restores mtimes) isn't noticed, and a `touch` without a content change triggers a re-run.
- Related-test quality depends on the tool. `vitest related` and `jest --findRelatedTests` follow imports; other stacks need approximations (step 4). ~~`{files}` lists every changed file, including docs and config, so commands must tolerate non-source paths.~~ Resolved in step 4: a command's `files` filter keeps docs and config files away from strict tools, and `harness-init` proposes filters for every stack.
- The overall 840 s deadline keeps the gate inside the 900 s hook timeout, and SIGTERM/SIGINT/SIGHUP to the hook kill the running stage's process group. A SIGKILL to the hook can't be caught, though, so a stage would then outlive it.
- If the state file can't be written, the gate never blocks: it fails open rather than risk an unbounded loop. The checks still run and the failure is logged to stderr.
- Quoting is POSIX-shell quoting. On Windows (`cmd.exe`), file names with spaces or quotes may not survive.

### Step 4: Workflow skills (2026-11-21)

**Shipped**
- **File filters and `{dirs}`** (`lib/verify.mjs`, `lib/config.mjs`). A `verify.*` entry is a string or `{ "run", "files" }`. `lib/config.mjs` validates both (only `run` and `files` keys; `run` a string; `files` a non-empty array of non-empty globs) and normalizes every entry to `{ run, files? }`, so `runStage` and the policies see one form. `buildCommand` narrows the changed files to the filter, then substitutes `{files}` (quoted paths) and `{dirs}` (unique parent directories, `.` for the root and `./dir` otherwise, quoted) in one pass, so a file name containing `{dirs}` is never substituted twice. A placeholder command with no matches is skipped, as is `format` with no matches and a whole-project command whose filter matches nothing. `stageFiles(changed)` (drop deleted and `.harness/` files) and `CHECK_STAGES` moved here so the gate and the CLI share them. `session-context` prints each command's filter.
- **`lib/glob.mjs`**: the glob-to-RegExp compiler from `guard-paths`, unchanged in behaviour (`**`, `*`, `?`, dot-files, case-insensitive), plus a compiled-pattern cache and `matchGlob(path, globs)`.
- **`lib/detect.mjs`**: `detectProject(root) → { stacks, verify, notes }`. It reads root-level files only; no network, no commands.
  - Node: the package manager from the lockfile (pnpm → `pnpm exec`, yarn → `yarn`, bun → `bunx --no-install`, else `npx --no --`; see review round 1). Tools come from `dependencies`/`devDependencies`, config files and `scripts`. Test: vitest, then jest, then `node --test {files}` on node's default test-file patterns (with a note), else no test command and a note. Lint: eslint (`--no-warn-ignored` with a flat config; left out, with a note, for a legacy `.eslintrc` only), else biome. Format: prettier (`--write --ignore-unknown`), else biome. Typecheck: `tsc --noEmit` when `tsconfig.json` exists. Workspaces get a note.
  - Python: runner from `uv.lock`/`poetry.lock`. `pytest --testmon` when pytest-testmon is a dependency, else `pytest {files}` on `**/test_*.py`/`**/*_test.py` with a note. `ruff check --force-exclude {files}` and `ruff format --force-exclude`. mypy (`mypy .`) or pyright when configured. Dependencies are matched as whole names, so `pytest-cov` isn't `pytest-testmon`.
  - Go: `go test {dirs}`, `go vet {dirs}` (typecheck), `gofmt -w`, `golangci-lint run {dirs}` when `.golangci.*` exists, all filtered to `**/*.go`.
  - Rust: `rustfmt --edition <edition from Cargo.toml, default 2021>` (review round 1), `cargo clippy`, `cargo check`, filtered to `.rs`/`Cargo.toml`/`Cargo.lock`; no test command, and a note to ask the user.
  - **Several stacks:** the primary stack is the first, in the order node, python, go, rust, that yields any command. The others are listed in `notes` with the commands they would use. They aren't merged because one verify entry has one command and one filter, so it can't say "eslint on `.ts`, ruff on `.py`".
- **`bin/harness.mjs`** (new public surface; exports `COMMANDS`, `SUBCOMMANDS` and `main`):
  - `init`: prints `{ root, stacks, config, notes, changes }` as JSON and writes nothing. `init --write` creates `.harness/config.json` (`templates/config.json` with the detected `verify`). An existing config is left alone (`kept`), and the `CLAUDE.md` block then describes that config; `--force-config` replaces it. It creates `CLAUDE.md` from `templates/CLAUDE.md`, or inserts/replaces only the `<!-- harness:start -->`…`<!-- harness:end -->` block in an existing one, keeping everything outside byte for byte. It does the same for an `AGENTS.md` pointer to `CLAUDE.md`, and creates `.harness/progress.md` if it is missing. It plans every change first and writes nothing if any file is `refused` (broken markers, or an invalid existing config without `--force-config`). Re-running it reports `unchanged`.
  - `verify [--all]`: runs lint, typecheck and test through `runStage` on `stageFiles(changedFiles(root))`, or with `--all`, on every tracked file that still exists plus untracked new files. It prints `ok`, `FAILED` with a 4 KB tail, or `skipped` with the reason for each stage, then `passed`, `failed (…)` or `nothing ran`. Exit codes: 0, 1 on a failed check, 2 on a usage, config or git error.
- **Skills**: all six rewritten as real instructions (see the checklist). `harness-init`, `verify` and `ship` call `node "<skill base dir>/../../bin/harness.mjs" …` and say that the base directory is given at load time.
- **Templates**: `templates/CLAUDE.md` has the harness section between markers, with `{{verify.*}}` filled with each command and its filter, or "not configured".
- `PROGRESS_PATH` is now exported from `lib/config.mjs`, so session-context and the CLI share it.

**Verified:** `npm test` gives 306/306 passing (246 before this step), in about 7 s. New tests:
- `test/glob.test.mjs`: a semantics table.
- `test/detect.test.mjs`: 17 fixture projects built in temp dirs. They cover npm, pnpm, yarn and bun; vitest, jest and node:test; flat and legacy eslint; biome; prettier; tsc; uv, poetry and pip with pytest, testmon, ruff, mypy and pyright; go with and without golangci; rust; two multi-stack cases; an invalid `package.json`; and no stack. Every proposal must pass `validateConfig`, no test command may be full-suite, and the filters are checked.
- `test/cli.test.mjs`: spawns the CLI against temp git repos. Cases: the dry run writes nothing; `--write` is idempotent; marker-block merging into an existing CRLF `CLAUDE.md` with no trailing newline, keeping the bytes before and after the block; refusing broken markers; keeping or `--force-config`-replacing an existing config; an invalid existing config; `verify` exit codes 0, 1 and 2; filters; `nothing ran`; and `--all`.
- `test/skills.test.mjs`: every skill directory has a `SKILL.md` whose frontmatter `name` matches and whose `description` is real, and there's no stub text. Every `bin/harness.mjs <sub>` a skill mentions must be in the CLI's `SUBCOMMANDS`. `ship` must list every default protected path, taken from `defaultConfig`.
- Filter and `{dirs}` tables in `test/verify.test.mjs`; object-form accept and reject cases in `test/config.test.mjs`; a gate test showing that a docs-only change never reaches filtered stages; and session-context filter output.

**Changes from the sketch**
- **Object form of `verify` entries.** This wasn't in the step 3 sketch; it's what makes `{files}` safe in real projects. Strings still work and mean "no filter".
- **A filter on a whole-project command** (no placeholder) also gates it: `tsc --noEmit` with a `.ts` filter doesn't run when only docs changed. The brief only required skipping placeholder commands.
- **`{dirs}`** uses `.` for the root directory instead of `./`, which `go test` accepts reliably.
- **`lib/glob.mjs`**, `lib/detect.mjs` and `bin/harness.mjs` are new modules. `buildCommand` now takes the normalized entry instead of a string.
- **Monorepos**: first stack with commands, others in notes (not merged), for the reason above.
- **Small safety additions to the commands in the brief**: `npx --no --` (never download a missing tool from inside the gate; the `--` was added in review round 1), `--passWithNoTests`, `--ignore-unknown` for prettier, `--no-errors-on-unmatched` for biome, and `--force-exclude` for ruff (otherwise excluded files passed by name get linted).
- **`init --write` with an existing, different config keeps it** and still writes the other files, instead of failing. That makes "edit the config, re-run init to refresh the `CLAUDE.md` block" work, and keeps re-runs idempotent. It refuses (writing nothing) only when the existing config is invalid or the markers are broken.
- **`verify` runs every stage** and reports each one, rather than stopping at the first failure like the gate does. `--all` also includes untracked new files.
- `templates/CLAUDE.md` puts the harness section inside markers, so the same block can be merged into an existing `CLAUDE.md`.

**Known gaps**
- pytest without pytest-testmon runs only changed test files, not the tests of changed source files. The same applies to `node --test`. `go test {dirs}` doesn't test packages that import a changed package.
- Rust has no related-test mode, so no test command is proposed. The user has to choose one, and `cargo test` would run the whole suite on every stop.
- Detection reads the root directory only. In a monorepo it doesn't look into workspace packages, and only one stack's commands are proposed.
- `mypy .` checks the whole tree, which can be slow or pick up vendored code. The skill's "try each command" step is where that gets noticed.
- Skills can't be unit-tested beyond their structure (frontmatter, CLI subcommands, the protected-path list). Whether an agent follows them is checked only by dogfooding (step 6).
- `review` depends on the `reviewer` agent, which is still a stub until step 5. (Done in step 5.)
- `verify --all` passes every tracked file on one command line. A very large repo can hit the OS argument limit.
- File filters match case-insensitively, like `protectedPaths`, so `**/*.ts` also matches `A.TS`.
- `bunx --no-install` is taken from the Bun docs (`bunx [flags] <package> [args]`). It isn't executed in the tests, because Bun isn't installed where they run.
- rustfmt also formats the out-of-line modules that the edited file declares (`mod x;`), so editing `lib.rs` still reformats most of the crate. In a workspace, the edition comes from the root `Cargo.toml`, so a member with a different edition needs its own `rustfmt.toml`.
- A crate that uses `edition.workspace = true` was formatted with rustfmt edition 2021 instead of the workspace edition: the regex didn't match that key, and in a member crate the `[workspace.package]` table lives in a parent `Cargo.toml` that detection never read (raised in the PR #4 review). **Fixed in step 5**: see that entry.
- `ship` lists the default protected paths in its text. `test/skills.test.mjs` keeps that list in sync with `lib/config.mjs`, but the skill can't read the merged list from the CLI.

**Review round 1 (PR #4)**
- **npx swallowed the tools' flags (blocking).** npm reads `--no` as an option that takes a value, so `npx --no tsc --noEmit` passed `--noEmit` to npm. On npm 11.12.1 that meant:
  - `tsc` emitted `.js` files into the user's tree while the gate reported ok
  - `prettier --write` printed the result instead of writing it
  - `jest --findRelatedTests --passWithNoTests` became plain `jest <paths>`
  - eslint lost `--no-warn-ignored`

  Detection now generates `npx --no -- <tool> …`. A new test in `test/detect.test.mjs` puts stub `tsc`, `jest`, `vitest`, `eslint` and `prettier` binaries in a temp project's `node_modules/.bin` (each prints its argv as JSON). It generates the config with `detectProject`, runs typecheck, test, lint and format through `runStage` and real `npx`, and asserts that each stub got every flag. The test is skipped when `npx` isn't on PATH. It fails with the old `npx --no` form. The README example and the expected strings are updated.
- `init --write` output: the action column is padded to 10 characters, so `unchanged` no longer runs into the path (`unchanged.harness/config.json`). There's an assertion for it.
- Bun: `bunx --no-install` (from the Bun docs: flags go before the package name), so the gate never downloads a missing tool.
- Rust format: `rustfmt --edition <edition>` on the edited file instead of `cargo fmt -- <file>`, which reformatted the whole crate. The edition is read from `Cargo.toml` (default 2021), and a new fixture case covers that.
- `npm test`: 308/308 passing (306 before this round).

### Step 5: Agents (2026-11-21)

**Shipped**
- **`agents/reviewer.md`**. Frontmatter: `name`, `description` (when to use it, and that it never edits), `tools: Read, Grep, Glob, Bash`. The prompt covers:
  - **Inputs**: a diff or base ref, the changed files, the intent, focus areas and the plugin path. With none of these it finds the base itself, and it stops on an empty diff.
  - **Read-only rules**: no file changes and no git command that changes state, the index or the tree. Scratch files go only in a `mktemp -d` dir outside the repo. Checks that would modify the repo are described, not run.
  - **Process**: read `CLAUDE.md`/`AGENTS.md`, read each hunk in context (function, callers, tests), then the checklist (correctness, security, concurrency and resources, error handling, tests, project rules). Every candidate is verified: CONFIRMED if reproduced, PLAUSIBLE if reasoned from the code, dropped if unsupported. It runs `node "<plugin>/bin/harness.mjs" verify --base <base>` (review round 1) when given the plugin path, or else the project's test command for the affected files. No style nits unless the rules ask.
  - **Output contract**: numbered findings `[blocking|should-fix|nit] file:line — claim (CONFIRMED|PLAUSIBLE)` with why it matters, evidence and a fix; "Checked and fine"; "Checks run"; `Verdict: approve | request changes`; "No findings." when there are none.
- **`agents/test-writer.md`**. Frontmatter: `name`, `description`, `tools: Read, Grep, Glob, Edit, Write, Bash`. Process:
  - learn the conventions from `CLAUDE.md`, `.harness/config.json`, the manifest and the nearest existing test;
  - plan happy, edge, error and regression cases;
  - write table-driven or parameterized tests in the file the project would use;
  - change only tests and fixtures, never weaken existing tests, and use no network, sleeps or fixed temp paths;
  - run only the related tests (`verify.test` with the placeholder replaced, or else the runner on the written files);
  - fix wrong tests, but stop and report real bugs with the failing output.

  Output: files, command, exact result, bugs found, and what it couldn't cover.
- **`skills/review/SKILL.md`** now passes the reviewer the base ref and diff commands, the changed files and intent, the rules files (`CLAUDE.md`/`AGENTS.md`), the plugin path (for `verify`) and focus areas. It re-verifies each returned finding (keeping CONFIRMED only if its own check agrees), and reports blocking, then should-fix, then nit, with evidence, the checks run, the verdict and the raised/dropped counts. The severity names now match the agent's (`should-fix` replaced "important"/"minor"). It offers `harness:test-writer` for test-gap findings. `ship` (after verify) and `plan` (steps whose Verify is a new test) each got a one-line mention of `harness:test-writer`.
- **`lib/detect.mjs`** (step 4 follow-up from the PR #4 review): the Rust edition no longer comes from a regex over the whole `Cargo.toml`. A small table-aware reader (`cargoTables`) takes `[package] edition`. For `edition.workspace = true` or `edition = { workspace = true }`, it reads `[workspace.package] edition` from the workspace root: the same manifest, the `package.workspace` path, or else the nearest parent `Cargo.toml` with a `[workspace]` table, which is how Cargo finds it. A virtual manifest uses its own `[workspace.package]`. Keys in other tables (`[target.'cfg(..)'.dependencies]`, `[[bin]]`) are ignored. The note says where the edition came from, and the default stays 2021.
- README: an Agents section (what each does, its tools, and use through `/harness:review` or directly as `@agent-harness:reviewer`).

**Verified:** `npm test` gives 327/327 passing (308 before this step), in about 7 s. New tests:
- `test/agents.test.mjs` (8 tests):
  - the shipped agent set;
  - per agent: `name` equals the file name, a real `description`, only fields Claude Code documents for plugin agents, no stub text, and a non-trivial prompt;
  - the reviewer has an explicit `tools` list with none of Edit, Write, MultiEdit or NotebookEdit;
  - the test-writer has Read, Edit, Write and Bash;
  - the reviewer's prompt contains the output-contract markers;
  - every `harness:<name>` reference in any `skills/**/SKILL.md`, found by scanning, resolves to an `agents/<name>.md`. The test also asserts that the scan finds `harness:reviewer`, so it can't pass vacuously;
  - a unit case showing the scanner skips `/harness:<skill>` commands and `<!-- harness:start -->` markers.
- `test/detect.test.mjs`: an 11-case `RUST_EDITIONS` table:
  - no edition;
  - `[package]` edition, which wins over `[workspace.package]`;
  - a root package with `edition.workspace = true`;
  - a virtual workspace;
  - a member inheriting from a parent, in both key forms;
  - a non-workspace middle `Cargo.toml` being skipped;
  - `package.workspace` overriding the nearest parent;
  - an inheriting member with no workspace;
  - decoy `edition` keys in other tables.

  The member, inline-form and decoy cases fail on the old regex.
- The frontmatter parser moved from `test/skills.test.mjs` to `test/helpers.mjs` (now CRLF-tolerant), and both tests share it.

**Changes from the sketch**
- **Frontmatter checked against the docs** (code.claude.com/docs/en/sub-agents and plugins/components, fetched 2026-11-21). Only `name`, `description` and `tools` are used. The docs say an omitted `tools` "inherits every tool available to subagents", so:
  - the reviewer keeps an explicit read-only list;
  - the test-writer also gets an explicit list, rather than omitting `tools`, so it doesn't inherit WebFetch/WebSearch (its prompt forbids network access), the Agent tool or MCP tools. Least privilege costs nothing here.

  `model` is left unset so the user's subagent model order applies. `disallowedTools` would be redundant next to an allowlist. `permissionMode` and `hooks` are ignored for plugin agents, so they aren't used. The test pins the fields to the documented plugin-agent set, because Claude Code silently ignores unknown fields.
- **The step 4 sketch** said the test-writer runs tests "through `bin/harness.mjs verify`". It runs the `verify.test` command on the files it wrote instead. `verify` takes no file arguments, and it tests every changed file, which includes unrelated work in the tree. The reviewer runs `verify --base <base>` with the diff's base ref (added in review round 1). Plain `verify` sees only uncommitted work, so on a committed branch it checked nothing.
- **Severity names** in the `review` skill changed from blocking/important/minor to `blocking`/`should-fix`/`nit`, to match the agent's contract.
- **Detection now reads a parent `Cargo.toml`** for Rust workspace members. Until now it read root-level files only. The read is bounded: the walk stops at the first `[workspace]` manifest or the filesystem root, and files are only read.

**Known gaps**
- Agent prompts can only be tested for structure (frontmatter, fields, tools, contract markers, references), not behaviour. Whether the reviewer verifies findings or the test-writer leaves production code alone is checked only by dogfooding (step 6).
- The reviewer's "read-only" is partly enforced and partly instruction. The tool list removes Edit, Write and NotebookEdit, but `Bash` can still write files or run `git commit`. Only its prompt forbids that (plus the harness guards, which block destructive commands and protected paths but not ordinary writes). `disallowedTools` can't narrow Bash to read-only commands: per the docs, an entry like `Bash(git push *)` removes the whole tool.
- The test-writer's "only test files" rule is also instruction-only. Nothing stops an Edit to production code.
- `cargoTables` is a line-based subset of TOML: no multi-line strings or arrays. That's enough for `edition` and `workspace` keys, but it isn't a TOML parser. A package with no `edition` gets rustfmt 2021, as before, although Cargo's own default for a missing edition is 2015.
- A workspace member's edition is found only when `harness-init` runs in that member. Running it at the workspace root still proposes one edition for every member.

**Review round 1 (PR #5)**
- **The reviewer's checks ran on nothing (blocking).** The review skill passes the plugin path, so the reviewer ran `bin/harness.mjs verify`. But `verify` took its files from `git status` only. On a committed branch with a clean tree (the skill's main case, `git diff <base>...HEAD`) it checked 0 files, printed `verify: nothing ran` and exited 0, so the branch's lint, typecheck and related tests never ran. With unrelated uncommitted work, it checked that instead. Fixes:
  - **`verify --base <ref>`** (also `--base=<ref>`). `changedFiles(root, base?)` in `lib/git.mjs` is now the one changed-file source for the gate, `verify` and `verify --base`. With a base, it adds `git diff --name-status -z --relative <base>...HEAD` to the working-tree changes. Renames give the new path and deletions are marked deleted, so `stageFiles` drops them. The working tree wins for a path in both.
  - `<base>...HEAD` diffs from the merge base, so commits on the base after the branch point don't count.
  - Bad input exits 2 with a `verify --base: …` message: a ref starting with `-` (refused before git sees it), an unknown ref, a ref with no common ancestor, a missing or repeated value, and `--all` together with `--base`.
  - The CLI's flag parser now supports options that take a value (`COMMANDS[sub].options`).
  - **"nothing ran" can't pass for a pass.** The line now reads `verify: nothing ran (no check executed; not a pass)`. `--help`, the header comment, the README and the `verify` skill state the exit codes: 0 passed or nothing ran, 1 failed, 2 error.
  - The reviewer agent and the review skill must report "nothing ran" as "no checks executed", never as passing.
  - **Callers use `--base`.** The reviewer and the review skill run `verify --base <base>` with the diff's base ref, and plain `verify` only for staged or uncommitted-only reviews. The `verify` skill explains `--base` for committed branches. `ship` verifies before committing, so it now runs `verify --base <base branch>`, which checks the branch's earlier commits as well as the work about to be committed.
  - The sentence in "Changes from the sketch" that claimed the reviewer's `verify` covered the changed files is corrected.
- **TOML comments** (non-blocking): `stripComment` cuts at the first `#` outside a quoted string, instead of requiring whitespace before it. `edition = "2018"#old` now reads as 2018, and `name = "a#b"` keeps its `#`.
- Tests:
  - `test/cli.test.mjs` adds 4 tests:
    - committed branch, clean tree and a failing `verify.test`: `--base main` and `--base=main` exit 1 and name the stage, while plain `verify` prints nothing ran and exits 0;
    - `{files}` gets only the branch's files (rename to the new path, deleted file excluded, commits on `main` after the branch point excluded), then the union with working-tree edits, untracked files and an uncommitted deletion;
    - a project root in a repo subdirectory;
    - exit 2 for each bad-input case above, plus an orphan-branch base.
  - `test/skills.test.mjs` now checks every `--flag` that a skill or the reviewer passes to `bin/harness.mjs <sub>` against `COMMANDS`. It also asserts that `review` and `ship` use `verify --base` and explain "nothing ran". `test/detect.test.mjs` adds a `"2018"#old` row.
- `npm test`: 334/334 passing (327 before this round).

### Step 6: Dogfood and release (2026-11-21)

**Shipped**
- **Official validation.** `claude plugin validate .` (Claude Code 2.1.330) reported three warnings and one plugin-directory warning, no errors. Fixed:
  - marketplace: no description → `metadata.description` added. The entry has no `version` (review round 1 removed the one first added): the version lives in `plugin.json` only. `.claude-plugin/marketplace.json` now passes `--strict`;
  - "Hosts not declared" → `plugin.json` declares `"network": { "hosts": [] }`: nothing in the plugin makes network calls.

  Accepted: `CLAUDE.md at the plugin root is not loaded as project context` (it's this repo's development guide, which must stay at the root) and the informational `ICON_MISSING` directory check (the plugin isn't submitted to the public directory).
- **CI runs the validator.** `npm install @anthropic-ai/claude-code` plus `claude plugin validate` works with an empty `HOME` and no credentials (checked locally with `env -i`). A separate `validate` job pins `@anthropic-ai/claude-code@2.1.330` and runs `claude plugin validate .` (errors fail) and `claude plugin validate --strict .claude-plugin/marketplace.json`. The `test` job is a matrix of Node 22 and 24 on `ubuntu-latest` and `macos-latest`, running `npm test` only.
- **`test/e2e.test.mjs`** (4 tests, about 3.5 s). Each hook is fired as Claude Code fires it: the `hooks.json` entry whose matcher accepts the tool, its exact command through a shell with `CLAUDE_PLUGIN_ROOT` set, the hook's own timeout, and realistic input (`session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, `tool_name`, `tool_input`, `tool_use_id`, `tool_response`, `source`, `stop_hook_active`). The fixture is a real git repo whose verify commands are node stubs that log their arguments outside the repo. One session:
  1. SessionStart: the context names the branch, `Dirty files (1): docs/notes.md` and each verify command with its filter; the output is exactly `{ hookSpecificOutput: { hookEventName, additionalContext } }`.
  2. PreToolUse: `rm -rf /` and Write `.env` → `permissionDecision: "deny"` with the three expected keys; Edit `src/a.js` → `{}`; no stub runs.
  3. PostToolUse Edit `src/a.js` → `{}`, and the log is exactly `format ["src/a.js"]`.
  4. Stop with a failing related test → exactly `{ decision: "block", reason }`. The reason names the test stage, `Command: node stubs/test.mjs src/a.js`, the stub's output and `Attempt 1 of 2`. Lint and test each got `["src/a.js"]`: not `docs/notes.md` (filtered), not `src/b.js`/`src/c.js` (unchanged).
  5. Fix, continuation Stop → `{}`; Stop again → `{}` with no new stub run.

  Plus: `maxAttempts` (block, block, give up with `gave up after 2 attempts` on stderr and nothing run, then a fresh budget on the next turn); `stop_hook_active` with a corrupt state file (allow without running, then a non-continuation Stop blocks and rewrites the counter); and a project with no config (init hint, `.git/config` still protected, gate allows).
- **Live dogfood** (`docs/dogfood-v0.1.0.md`): three `claude -p --plugin-dir … --include-hook-events --output-format stream-json` sessions in a temp fixture repo with stub commands, $0.20 in total. All four hooks fired with the expected JSON; `/harness:verify` loaded and ran the CLI; the Stop gate blocked a real session, which then fixed the file.
- **Dogfood fix**: `guard-paths` reasons now say that a project config can add protected paths but can't remove the built-in ones. In session (a) the model told the user to remove `.env` from `protectedPaths`, which does nothing. `test/guard-paths.test.mjs` asserts the sentence for every blocked path.
- **Release files**: `CHANGELOG.md` (Keep a Changelog, `0.1.0 - 2026-11-21` covering steps 0–6). `test/release.test.mjs` (4 tests): the `plugin.json` and `package.json` versions are equal and the marketplace entry sets none; the changelog has a dated entry for that version; the README's `<!-- config-defaults -->` JSON block deep-equals `defaultConfig()` from `lib/config.mjs`; and the README config table lists exactly the config keys (verify stage names read from `validateConfig`'s own error, so `lib/config.mjs` stays the only owner of the schema).
- **README rewrite**: what it is, quickstart (marketplace install with git credentials for the private repo, or `claude --plugin-dir`), `/harness:harness-init`, config reference table and defaults, related-tests-only behaviour, a hook table, skills and agents, known limitations (linking this log) and development plus a release checklist.

**Verified**
- `npm test`: 342/342 passing (334 before this step: +4 e2e, +4 release; the guard-paths change adds assertions, not tests), in about 7 s.
- `claude plugin validate .`: `✔ Validation passed with warnings`, exit 0, with the one accepted `CLAUDE.md` warning and the informational icon check. `claude plugin validate --strict .claude-plugin/marketplace.json`: `✔ Validation passed`.
- Live sessions: (a) `.env` write denied by guard-paths, no file created; (b) `src/b.js` created, `format ["src/b.js"]` then `lint`/`test ["src/b.js"]`, Stop `{}`; (c) `/harness:verify` ran `bin/harness.mjs verify`, reported `verify: failed (test)` verbatim, the Stop gate blocked with the test command and output, the agent fixed `src/c.js` and re-ran `verify: passed`. The session then hit `--max-turns 4` before its final Stop.
- `claude --plugin-dir . plugin details harness`: 6 skills, 2 agents, 4 hooks, about 835 always-on tokens.
- `claude plugin tag --help`: it creates a `{name}--v{version}` tag, so this release is `harness--v0.1.0`.

**Changes from the sketch**
- The sketch said "tag `v0.1.0`". `claude plugin tag` creates `harness--v0.1.0` (the `{name}--v{version}` format), and it validates `plugin.json` against any version the marketplace entry declares, so that's the tag the checklist uses. Tagging and `gh release create` are done by the orchestrator after the merge, not in this branch.
- The sketch planned `/harness:review` with the real reviewer and a `harness:test-writer` run. They weren't run: the live run was capped at three sessions, and those went to the hooks and one skill. The agents are confirmed to load (`init.agents` lists both); their behaviour is the first follow-up.
- `plugin.json` gained `network.hosts: []`, and `marketplace.json` gained `metadata.description`, both from the validator. The task asked for `marketplace.json` to carry `0.1.0` too; the host-marketplace docs say not to set `version` in both places (plugin.json silently wins), so it doesn't (review round 1).

**Known gaps**
- Agents and five of the six skills are loaded but not exercised live (see above).
- The final "allow" after a live fix wasn't observed in session (c) because of `--max-turns 4`; `test/e2e.test.mjs` covers it.
- The marketplace install path (`/plugin marketplace add rajitharx/jj-harness`) wasn't tested; it needs git credentials for the private repo.
- `claude plugin validate .` can't run with `--strict` in CI while the dev `CLAUDE.md` sits at the plugin root. Moving the plugin into a subdirectory would fix it, but changes the marketplace `source` and every path.
- The CI validator is pinned to 2.1.330 and needs a manual bump.
- Windows remains untested; CI covers Ubuntu and macOS.

**Review round 1 (PR #6)**
- **Private-repo install notes (blocking).** The README claimed that background auto-updates need `GITHUB_TOKEN`/`GH_TOKEN` in the environment. The host-marketplace docs (code.claude.com/docs/en/plugins/host-marketplace) say a token alone doesn't authenticate the background check: it works only through a credential helper. They also say auto-update is off by default for a third-party marketplace. The Quickstart now says:
  - clones use the user's git credentials: an SSH key in `ssh-agent`, or `gh auth login` plus `gh auth setup-git`;
  - on machines without a GitHub SSH key, set `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` (documented on that page: `/plugin` installs and updates don't fall back to HTTPS without it);
  - auto-update is off by default and is turned on under `/plugin` → Marketplaces;
  - to update by hand, run `/plugin marketplace update jj-harness`, or `claude plugin marketplace update jj-harness` then `claude plugin update harness@jj-harness`.

  The claim appeared only in the README. The CHANGELOG records the correction.
- **No `version` on the marketplace entry.** The same page says "Don't set `version` in both `plugin.json` and the marketplace entry" (plugin.json wins without warning). The entry's `version` is removed. `claude plugin validate .` still passes, `--strict` on `marketplace.json` still passes, and `claude plugin tag --dry-run` still gives `harness--v0.1.0` from plugin.json. `test/release.test.mjs` now checks that `package.json` equals `plugin.json` and that the marketplace entry has no `version`.
- The release checklist uses `gh release create … --verify-tag`, so a missing tag fails instead of being created from `main`.
- `npm test`: 342/342 passing (342 before this round; one release test changed, none added).

### 0.1.1: Doc fixes and gate notices (2026-11-21)

**Shipped**
- **Doc fixes from the PR #6 review.**
  - README release checklist: `claude plugin tag` (2.1.330 `--help`: "validating that plugin.json and any enclosing marketplace entry agree") compares versions only when the marketplace entry sets one, and ours doesn't. The checklist now says the tag takes its version from `plugin.json`, `test/release.test.mjs` keeps `package.json` in step, and the tool refuses a dirty tree or an existing tag unless `--force`. `--dry-run` on the 0.1.0 tree reported `Tag "harness--v0.1.0" already exists locally`, and on this branch before committing it refused the uncommitted changes. The `gh release create` line uses `harness--v<version>` instead of a fixed version.
  - Step 6 checklist: `plugin.json` and `package.json` agree, and the marketplace entry carries no version.
  - Quickstart: the `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` note now follows the host-marketplace docs (code.claude.com/docs/en/plugins/host-marketplace, "Grant access to a private marketplace" and "Serve users who have no git-host account"). For `owner/repo`, Claude Code probes `ssh -T git@github.com`. Adding the marketplace falls back to HTTPS when the probe or the SSH clone fails, and so does `claude plugin install` from a shell. `/plugin` installs in a session and plugin updates don't fall back, and the variable skips the probe.
- **`notice` verdict.** `Verdict` gains `{ kind: "notice", text }`. `mergeVerdicts` adds the notices to whatever the event-specific mapping returns as the top-level `systemMessage`, on every event. Notices are trimmed, joined one per line in policy order and capped at 1,000 characters. A notice whose text is not a non-blank string is an invalid verdict and fails open. The Stop comment now says why context stays dropped: Stop's `additionalContext` would continue the turn.
- **The gate tells the user what it did.** When it ran its stages and allows, `verify-gate` returns a notice:
  - pass: `harness: lint ✓ (1 file) typecheck ✓ test skipped`. Only configured stages are listed, and skipped ones as `skipped`. The count (added in review round 1; the first version counted every changed file) is what that stage's command was given after its `files` filter, and a whole-project stage has none;
  - every stage skipped: `harness: no checks ran (lint skipped test skipped)`, so it never reads as a pass;
  - gave up after `maxAttempts`; ran out of the overall deadline (naming the stage, and the stages that passed before it); the attempt counter couldn't be saved after a failure; the counter was unreadable on a continuation. Each ends with "allowed this stop". The stderr log lines are unchanged.

  It stays silent on the fingerprint skip (nothing changed since the last pass: the run that saved the fingerprint already sent its notice, and repeating it every turn would be noise), and where it looked at nothing: gate disabled, no gate commands, a clean tree, or not a git repo (a notice there would fire on every turn of a non-git project).

**Verified**
- `npm test`: 349/349 passing (342 before: +4 in `test/harness.test.mjs`, +3 in `test/verify-gate.test.mjs`, and the existing gate and e2e tests now assert the notices), in about 11 s.
  - `harness.test.mjs`: a table of every event with a notice alone and with a block, context or both (Stop still drops context but keeps the notice); joining, trimming and keeping notices out of `additionalContext`; the 1,000-character cap on one and on joined notices; `""`, blank, missing and non-string text failing open while another policy's notice survives.
  - `verify-gate.test.mjs`: a table of pass notices (all ran, filtered stage skipped, only configured stages, all skipped, deletions only); the silent fingerprint skip; the give-up, deadline (with and without earlier passes), unsaved-counter and unreadable-counter notices; silence when disabled, unconfigured, clean or not a repo.
  - `e2e.test.mjs`: the passing continuation Stop outputs exactly `{ "systemMessage": "harness: lint ✓ (1 file) test ✓ (1 file)" }` and the next Stop `{}`; the give-up and unreadable-counter Stops output only a `systemMessage`.
- **Live check** (Claude Code 2.1.330, `claude -p --plugin-dir . --model haiku --output-format stream-json --verbose --include-hook-events`, a temp fixture with `true {files}` lint and test, $0.005): the session wrote `src/b.js`, the Stop hook returned `{"systemMessage":"harness: lint ✓ test ✓ (1 changed file)"}` (the wording of the first version; both stages had no filter and got that one file), and Claude Code emitted `{"type":"system","subtype":"informational","content":"Stop says: harness: lint ✓ test ✓ (1 changed file)","level":"notice"}`. A non-blocking Stop's `systemMessage` does reach the user; the hooks reference doesn't say so for Stop specifically.
- `claude plugin validate .`: `✔ Validation passed with warnings`, exit 0. The two known warnings only: `CLAUDE.md at the plugin root is not loaded as project context`, and the plugin-directory `ICON_MISSING` check. `claude plugin validate --strict .claude-plugin/marketplace.json`: `✔ Validation passed`.

**Changes from the sketch**
- The notice verdict is the suggested shape. The hooks reference (code.claude.com/docs/en/hooks) lists `systemMessage` among the common output fields ("Warning message shown to the user") that every event accepts, and lists none of our four events among those that discard it, so one top-level mapping works for all of them. `suppressOutput` is documented as "Has no effect", so it isn't used. Stop's `hookSpecificOutput.additionalContext` exists but continues the conversation, which is wrong for a pass.
- The cap is 1,000 characters rather than the 16 KB used for agent text: a notice is a status line, and Claude Code shows hook strings over 10,000 characters only as a 2,000-character preview.
- The pass notice shows a per-stage count rather than the sketch's "related files" total: each stage reports the files its command was given after its `files` filter (`lint ✓ (1 file)`), and a whole-project stage shows none. The first version printed the number of changed files, which overstated what a filtered stage checked.
- **format-on-edit gets no notice.** A failure already reaches the agent as context next to the tool result, and a broken formatter would add a user notice to every edit. Not worth the noise.

**Review round 1** (PR #7 review: the notice's count was wrong)
- The notice said `(3 changed files)` when `src/a.ts`, `README.md` and `docs/x.md` changed but each stage, filtered to `src/**/*.ts`, received only `src/a.ts`. It now reports what each stage actually received: `harness: lint ✓ (1 file) typecheck ✓ test ✓ (1 file)`. A whole-project stage (no `{files}` or `{dirs}`) has no count; skipped stages stay `skipped`; when every stage was skipped it still reads `no checks ran (...)`.
- The number comes from one place: `planStage` in `lib/verify.mjs` (which `buildCommand` now wraps) returns `{ command, fileCount? }`, and `runStage` puts `fileCount` in its result for stages that ran with paths. The gate passes it through and doesn't recompute it. The `no changed files to pass: only deletions or .harness/` wording is gone: with nothing to pass, the `{files}` stages show `skipped`.
- Tests: `verify-gate.test.mjs` pass-notice table now covers the dropped-files case, a whole-project stage with and without a filter, a `{dirs}` stage and skipped stages; `verify.test.mjs` checks `fileCount` on `runStage` (files, dirs, whole-project, format, skipped) and `planStage`; the e2e expectation is `(1 file)` for each stage. README, CHANGELOG, rationale and the dogfood note use the new wording.
- `npm test`: 350/350 passing (349 before: +1 `runStage` test; the gate table gained cases and the e2e and gate expectations changed). `claude plugin validate .`: see the PR comment for the output.

**Known gaps**
- The gate's notices aren't shown to the model, so the agent's own summary can still say it didn't run the checks. The user now sees the line right after it.
- The hooks reference caps `additionalContext` and `systemMessage` at 10,000 characters; `runHook` still caps context at 16 KB (follow-up in the rationale).
- The live check covers headless `stream-json`. How the interactive TUI renders a Stop `systemMessage` wasn't observed.

### 0.2.0: Monorepo and .NET support (2026-11-21)

**Shipped**
- **Package detection** (`lib/detect.mjs`): `detectProject(root, { only })` analyzes the root and every package directory the same way. Packages are the root's immediate subdirectories and the children of `apps/`, `packages/` and `services/` that hold a manifest; dot directories, symlinks, `node_modules`, `bin`, `obj`, `dist`, `build`, `out`, `target`, `vendor`, `coverage`, `venv` and `__pycache__` are skipped, and more than 40 packages are capped with a note. The result gained `packages: [{ path, stacks }]` (the root is `.`). A repo with one stack at the root gets the same `stacks`, `verify` and `notes` as before. A package inherits its lockfile and eslint/prettier/biome configs from the root, which is how a pnpm workspace's apps get `pnpm exec`. A package of the same stack as the root is left out with a note (the root's commands already see its files), so a single-stack repo with a nested `docs/`, `e2e/` or `fuzz/` project, or a root solution with `src/` and `tests/` projects, keeps its old proposal; `--packages` can still add it.
- **.NET**: `*.sln`, `*.slnx` or `*.csproj` yields `dotnet test` filtered to `.cs`, `.razor`, `.cshtml`, `.csproj`, `.props` and `.targets`. When a directory has more than one solution or project (which fails with MSB1011) the command names one. Notes say that it is a full-suite command to confirm with the user, that `dotnet build` and `dotnet format --verify-no-changes` are optional and left out, and, when `global.json` selects the Microsoft.Testing.Platform runner, that `dotnet test` then takes `--solution`/`--project`.
- **Schema** (`lib/config.mjs`): a verify entry may have `cwd` and a stage may be an array of entries. `cwd` is validated (relative, no `..`, no backslash or drive) and normalized (`./apps//web/` becomes `apps/web`, `.` means none); an array of one is unwrapped and empty commands are dropped, so single-stack configs read exactly as before. `stageEntries` is the one accessor.
- **Runtime** (`lib/verify.mjs`): `planStage` scopes the changed files to `cwd`, makes them relative to it, then applies the filter and the placeholders; nothing under `cwd` skips the entry, even a whole-project command. `runStage` runs the entries in order in their directories, stops at the first failure, and gives the stage one time limit. Results carry `cwd` and `commands`, and `describeRun` prints `(in apps/web) npx …` in the gate's block message, format-on-edit's context and `verify`'s output. `session-context` and the `CLAUDE.md` block list every entry with its directory.
- **CLI**: `init --packages a,b` keeps only those packages (the root is `.`); the dry-run JSON has `packages`; `init --write` ends with a `/reload-plugins` reminder.
- **Skill and README**: `harness-init` reports the packages, asks which the gate should check, runs each command once in its own directory and asks about the .NET full-suite note. The README quickstart explains the `Unknown skill: harness:harness-init` error after a mid-session install.

**Verified**
- `npm test`: 416/416 passing (350 on `main`), in about 11 s.
  - `test/monorepo.test.mjs` (new): a detection table with the OnLah layout (two npm apps and a .NET project, no root manifest), a single-stack repo, an empty repo, `services/` and `packages/` children, deeper directories ignored, skipped and symlinked directories, root lockfile inheritance, a nested package, Rust fuzz crate and root-solution projects left out as covered by the root, and five .NET layouts (solution, `.slnx`, lone project, sln plus project, `global.json` runner); `only` and the 40-package cap; a `planStage` table for `cwd` (relative files, filters, `{dirs}`, whole-project commands, skips); `runStage` in each directory, in order, skipping, first failure, one time limit across entries, root and package entries mixed; the verify gate blocking with the package named; session context; and the CLI (`init`, `--packages`, `--write`, CLAUDE.md, empty repo, `verify`).
  - `test/config.test.mjs`: arrays, `cwd` and `stageEntries` (nine new invalid configs, five normalization cases). The two cases that said an array and `cwd` were invalid now say the opposite.
- The README defaults block is unchanged (`verify` defaults to `{}`), and `test/release.test.mjs` still checks it against `lib/config.mjs`.

**Changes from the sketch**
- There was no sketch for this. The decision between a generated shell loop and a schema extension is in the rationale ("Monorepos (0.2.0)"): schema, because splitting `{files}` per package in `sh` is untestable generated text.
- `files` globs under a `cwd` match paths relative to the package, not to the repo root. The task text said "scoped to that package's path"; the `cwd` does the scoping, and the globs stay the same `**/*.ts` as a single-stack repo so detection reuses them.
- `init --packages` was added so that "ask which packages the gate should check" can be answered by re-running detection, not by hand-editing arrays.
- The reload hint is in `init --write`'s output only. The CLI can't know whether the failing `Unknown skill` came first, so it is a plain reminder.

**Known gaps**
- Packages are found by directory layout, not from `pnpm-workspace.yaml`, `package.json` `workspaces`, Cargo or Go workspaces, so a package three levels deep (`libs/js/foo`) is missed.
- A root's tool dependencies (eslint in the root `devDependencies` only) aren't inherited by packages; only lockfiles and tool configs are.
- A solution-style `tsconfig.json` (Vite's `references`) gets `tsc --noEmit`, which checks nothing there; `tsc -b` would. No note about it yet.
- `dotnet test` was not run: no .NET SDK here, so the command's behaviour (MSB1011, the Microsoft.Testing.Platform flags) comes from documentation, not from a run. The first real use should be OnLah's backend.
- Not dogfooded in a live Claude Code session or on OnLah itself; the fixtures only reproduce its layout.

**Review round 1** (PR #8: should-fix findings)
- A single-stack root with any nested manifest was proposed as a monorepo with doubled commands (root node plus `e2e/package.json` linted twice; Rust root plus `fuzz/Cargo.toml`; a root solution with `src/` and `tests/` gave three `dotnet test` entries). That contradicted "the same proposal as before". Packages of the root's stack are now left out by default with a note, and explicit `--packages` still includes them (with a "may run twice" note). Tests: the node-plus-e2e, Rust-plus-fuzz, root-solution and mixed-stack cases in `test/monorepo.test.mjs`, and `--packages` keeping a covered package.
- Nits fixed: the 40-package cap no longer applies to an explicit `--packages` (it said "No package found" for `p45`), and `--packages ./` means the root. Not changed: note volume for very large repos.

**Review round 2** (PR #8: blocking)
- The left-out rule dropped packages under a bare workspace root (`{"private":true}` plus `packages/*`), leaving an empty proposal and a false note. A package is now covered only when the root proposes every stage the package would add. Tests: the bare-root and lint-only-root cases. The test count in this log said 367 for `main`; it is 350.
