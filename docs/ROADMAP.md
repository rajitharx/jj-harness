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

- [x] `guard-bash`: deny `rm -rf` on root, home, `.`/`..` or bare globs; force-push (`--force`, `-f`, `--force-with-lease`, `+refspec`) to main/master; piping a download into a shell (`curl … | sh`, `bash <(curl …)`, `sh -c "$(curl …)"`); `DROP`/`TRUNCATE` sent to a database client; `mkfs`, `dd of=/dev/…`, `chmod -R … /` and fork bombs; plus `config.blockedCommands`. Rules are one table, checked per segment of a quote-aware command split, including nested `bash -c`/`eval` strings
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
- `guard-bash` (PreToolUse, Bash only): one `RULES` table of `{ scope, test, reason }`. A small quote-aware parser splits the command into pipelines (on `&&`, `||`, `;`, `&`, newlines, parentheses, backticks) and segments (on `|`), and strips wrappers (`sudo`, `env`, `VAR=x`, `nohup`, …). Rules run on the raw command, on each pipeline or on each segment, whichever the check needs. `bash -c "…"` and `eval "…"` strings are checked recursively. It blocks:
  - `rm` with recursive and force flags in any spelling, on `/`, `/*`, `~`, `~/`, `$HOME`, `*`, `.`, `..`, `./*` (`rm -rf node_modules dist` is allowed)
  - `git push` with `--force`, `-f`, `--force-with-lease` or `+refspec` to `main`/`master` (including `HEAD:main` and `refs/heads/main`); force-pushes to other branches are allowed
  - downloads piped or substituted into a shell (`curl … | sh`, `| sudo bash`, `bash <(curl …)`, `sh -c "$(curl …)"`); `curl … | jq` and `| python3 -m json.tool` are allowed
  - `DROP DATABASE|SCHEMA|TABLE`, `TRUNCATE` and Mongo `dropDatabase()` when the same pipeline invokes psql, mysql, mariadb, sqlite3, sqlcmd or mongosh
  - `mkfs*`, `dd of=/dev/…` (except `/dev/null`, stdout, stderr), `chmod -R` on `/`, fork bombs
  - any `config.blockedCommands` regex; the reason names the pattern

  Each reason has the form ``Blocked `<command>`: <why>. <safer alternative>``.
- `guard-paths` (PreToolUse, Edit/Write/MultiEdit/NotebookEdit): resolves the path against `cwd` (expanding a leading `~`), makes it relative to `config.root`, and matches it against `config.protectedPaths` with a private glob-to-RegExp compiler (`**`, `*`, `?`, wildcards match dot-files). For paths outside the root, only `**/` patterns apply, matched against the absolute path, so `~/.ssh/id_ed25519` is caught. The reason names the matched pattern.
- `hooks.json`: the PreToolUse matcher now includes `NotebookEdit`, so `guard-paths` sees notebook edits.

**Verified:** `npm test` gives 141/141 passing: 53 must-block and 30 must-allow commands, 11 must-block and 8 must-allow paths, glob-semantics and outside-the-root cases, `blockedCommands`, and an end-to-end `run.mjs PreToolUse` deny for `rm -rf /`.

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

**Known gaps**
- The guards are best-effort pattern matching, not a sandbox. Obfuscation gets past them (variables such as `rm -rf $(pwd)` or `$DIR`, aliases, base64, scripts written to a file and then run, SQL files fed through `psql < drop.sql`).
- A bare `git push --force` (no refspec) while on main is allowed, because the policy is pure and doesn't read the current branch. Deleting main (`git push origin :main`, `--delete main`) isn't blocked either.
- The SQL rule can give false positives when one pipeline mixes a database client with unrelated text that contains `DROP TABLE`.
- The defaults block `.env.example` (it matches `.env.*`), and because project `protectedPaths` only extend the defaults, a project can't unblock it. `.envrc` isn't protected by default.
