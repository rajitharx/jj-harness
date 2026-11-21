# Roadmap

Each step is a checklist. When a step is done, tick its boxes, set its status, and add an entry to the [completion log](#completion-log) with what shipped, how it was verified, and any changes from the sketch.

Status key: ⬜ not started · 🟡 in progress · ✅ done

| # | Step | Status |
| - | ---- | ------ |
| 0 | Scaffold and design sketch | ✅ |
| 1 | Core runtime: config and hook dispatch | ✅ |
| 2 | Guardrails | ✅ |
| 3 | Quality loop | ⬜ |
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

## 3. Quality loop ⬜

- [ ] `format-on-edit`: run `verify.format` on the edited file, report failures as context
- [ ] `verify-gate`: on Stop, if the tree changed, run lint, typecheck and test; block with the failure output; respect `stop_hook_active` and `stopGate.maxAttempts`
- [ ] `session-context`: branch, dirty files, verify commands, tail of `.harness/progress.md`
- [ ] Tests for each policy, including the loop guard

## 4. Workflow skills ⬜

- [ ] `harness-init`: detect the stack, propose verify commands and test that they run, write the config, `CLAUDE.md`, `AGENTS.md` and `progress.md`; never overwrite an existing `CLAUDE.md`
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
