# Roadmap

Each step is a checklist. When a step is done, tick its boxes, set its status, and add an entry to the [completion log](#completion-log) with what shipped, how it was verified, and any changes from the sketch.

Status key: ⬜ not started · 🟡 in progress · ✅ done

| # | Step | Status |
| - | ---- | ------ |
| 0 | Scaffold and design sketch | ✅ |
| 1 | Core runtime: config and hook dispatch | ✅ |
| 2 | Guardrails | ✅ |
| 3 | Quality loop | ✅ |
| 4 | Workflow skills | ⬜ |
| 5 | Agents | ⬜ |
| 6 | Dogfood and release | ⬜ |

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

## 4. Workflow skills ⬜

- [ ] `harness-init`: detect the stack, propose verify commands and test that they run, write the config, `CLAUDE.md`, `AGENTS.md` and `progress.md`; never overwrite an existing `CLAUDE.md`
- [ ] `harness-init` generates `{files}`-based related-test commands per stack, so the Stop gate checks only related tests: `jest --findRelatedTests {files}`, `vitest related --run {files}`, `go test` on the changed packages, pytest on matching test files, plus per-file lint (`eslint {files}`, `ruff check {files}`). Commands must tolerate non-source paths in `{files}` (e.g. eslint's `--no-warn-ignored`)
- [ ] `plan`: write `.harness/plans/<slug>.md`
- [ ] `verify`: run the checks and report the output exactly
- [ ] `review`: send the diff to the `reviewer` agent and check each finding
- [ ] `ship`: refuse on main, verify, write a conventional commit, open a PR
- [ ] `handoff`: append a progress note

## 5. Agents ⬜

- [ ] `reviewer`: read-only, reports only verified correctness, security and test-gap findings
- [ ] `test-writer`: follows the project's test conventions and runs the tests

## 6. Dogfood and release ⬜

- [ ] End-to-end hook tests against a fixture project
- [ ] Try the plugin locally with `claude --plugin-dir .`
- [ ] README polish, tag `v0.1.0`, PR to `main`

---

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
- Related-test quality depends on the tool. `vitest related` and `jest --findRelatedTests` follow imports; other stacks need approximations (step 4). `{files}` lists every changed file, including docs and config, so commands must tolerate non-source paths.
- The overall 840 s deadline keeps the gate inside the 900 s hook timeout, and SIGTERM/SIGINT/SIGHUP to the hook kill the running stage's process group. A SIGKILL to the hook can't be caught, though, so a stage would then outlive it.
- If the state file can't be written, the gate never blocks: it fails open rather than risk an unbounded loop. The checks still run and the failure is logged to stderr.
- Quoting is POSIX-shell quoting. On Windows (`cmd.exe`), file names with spaces or quotes may not survive.
