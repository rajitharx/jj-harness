# Roadmap

Each step is a checklist. When a step is done, tick its boxes, set its status, and add an entry to the [completion log](#completion-log) with what shipped, how it was verified, and any changes from the sketch.

Status key: ⬜ not started · 🟡 in progress · ✅ done

| # | Step | Status |
| - | ---- | ------ |
| 0 | Scaffold and design sketch | ✅ |
| 1 | Core runtime: config and hook dispatch | ✅ |
| 2 | Guardrails | ⬜ |
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

## 1. Core runtime: config and hook dispatch ✅

- [x] `lib/config.mjs`: find the project root, read `.harness/config.json`, validate it, merge it over the defaults, freeze the result
- [x] `lib/harness.mjs`: `runHook` runs each policy and fails open on crashes or bad verdicts; `mergeVerdicts` turns verdicts into Claude Code's hook JSON for each event
- [x] `hooks/run.mjs`: survives bad stdin and unexpected errors, and always exits 0
- [x] Tests: `test/config.test.mjs`, `test/harness.test.mjs`, `test/run.test.mjs`

## 2. Guardrails ⬜

- [ ] `guard-bash`: deny `rm -rf` on root, home or `*`, force-push to main/master, `git reset --hard` on shared branches, `curl … | sh`, `DROP`/`TRUNCATE`, plus `config.blockedCommands`
- [ ] `guard-paths`: deny Edit/Write/MultiEdit on `config.protectedPaths` (glob matching relative to `config.root`)
- [ ] Tests: tables of commands and paths that must be denied, and ones that must be allowed

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

**Known gap:** the five policies are still stubs that throw. Until steps 2 and 3 land, every hook logs a "not implemented" line to stderr and allows the action.
