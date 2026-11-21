# Design rationale

## Problem

I want one agent harness I can reuse across projects of any stack, without copying files between repos. It should make agents safer (no destructive commands, no secret edits), more correct (they can't stop with failing checks), and better at continuing work across sessions. It's a greenfield project, so the only constraint is Claude Code's own plugin and hook contract.

## Usage (caller's view)

```sh
/plugin install harness@jj-harness      # once per machine
/harness:harness-init                    # once per project → .harness/config.json + CLAUDE.md
```

After that the user does nothing different. The hooks run on their own. Skills are invoked by name (`/harness:verify`, `/harness:ship`) or picked up from their descriptions.

## Shape

- **The plugin is the unit of reuse.** It contains hooks, skills and agents. Updates happen through `/plugin update`, not by copying files.
- **One per-project file**: `.harness/config.json`, owned by `lib/config.mjs`. No other module knows its path or defaults (per *split ownership*).
- **One hook entry point**: `hooks/run.mjs <Event>`. `hooks.json` only routes events. `hooks/policies/index.mjs` is the single list of policies for each event. A test fails if the two disagree (per *hand-synced list*).
- **Deep runtime**: `runHook(event, input) → HookResult` is the whole hook-side public surface. Policies return a small `Verdict` union, and merging it into Claude Code's exit codes and JSON happens in one place, so the wire protocol doesn't leak into the policies.
- **Fail open**: if a policy crashes, it logs to stderr and allows. A broken harness must never brick a session. Guards are the exception: they are unit-tested and nearly pure. The only I/O is `guard-bash` reading `.git/HEAD` to find the current branch, and it allows the command if that read fails.
- **Zero dependencies**: Node ≥22 stdlib only, so installing the plugin never runs `npm install`.
- **Related tests only**: the Stop gate checks what changed, not the whole suite. Any `verify.*` command may contain `{files}` (the shell-quoted changed files, working tree vs HEAD) or `{dirs}` (their directories), which `lib/verify.mjs` substitutes; with nothing to pass, that stage is skipped. An entry may be `{ "run", "files": [globs] }`: only matching changed files reach the command, and it is skipped when none match, so docs and config changes never reach strict tools. Commands without a placeholder, such as typecheck, run as written, and `format` gets the edited path appended.
- **Detection is code, not prose**: `lib/detect.mjs` turns a project's manifests into proposed commands (`vitest related --run {files}`, `jest --findRelatedTests {files}`, `go test {dirs}`, `pytest --testmon`, …) and notes where a stack has no related-test mode. It reads files only, and table-driven fixture tests pin it down. Multiple stacks aren't merged (one entry has one filter); the first stack with commands wins and the rest are reported.
- **A small CLI for the skills**: `bin/harness.mjs init [--write] [--force-config]` and `verify [--all | --base <ref>]`. Skills reach it through their base directory (`<skill base dir>/../../bin/harness.mjs`), so the deterministic parts (detection, merging the `CLAUDE.md` marker block, running the checks) are tested code, and the skills keep only the judgement: confirming commands, asking the user, reporting. `verify` runs through the same `runStage` and changed-file source as the Stop gate: `changedFiles(root, base?)` in `lib/git.mjs`, where `--base` adds the branch's committed changes (`<base>...HEAD`) so committed work can be checked.

- **Agents are prompts with least-privilege tools**: `reviewer` gets `Read, Grep, Glob, Bash` and must verify each finding before reporting it, and `test-writer` gets an explicit list without network tools. Skills reference them as `harness:<name>`, and a test checks that every reference resolves.

## Public surface

Three things outside code can depend on, each kept small:
- `runHook(event, input)` for hooks (one entry point, `hooks/run.mjs`).
- The config file: per stage, a string or `{ run, files }`, with `{files}`/`{dirs}`, plus `protectedPaths`, `blockedCommands`, `stopGate` and `formatTimeoutSec`. Both entry forms normalize to one internal shape in `lib/config.mjs`, so the object form adds schema but no second code path.
- The CLI: two subcommands and three flags. The skills test reads the subcommand list from the CLI module, so a skill can't call one that doesn't exist.

The object form is the costliest addition, since every user config can now hold it. It's justified because without it `{files}` hands `README.md` to eslint, pytest or `go vet`, and the only alternative was asking every tool to tolerate arbitrary paths. The CLI is the cheapest way to keep detection and file merging testable instead of leaving them as instructions the model re-derives on each run.

## Synthesis decision

I compared two whole shapes (single-model synthesis; no multi-model arena runners were available here):

- **A. Copy-in template** (`npx create-harness` writes `.claude/` into each repo). It's simple, but every repo ends up with its own copy that drifts. That's a hand-synced list across repos, and fixes don't propagate.
- **B. Plugin plus a per-project config file** (chosen). The behavior lives in one place, and a project only states facts about itself (its commands and protected paths).

B is the base. From A I kept generating `CLAUDE.md` into the project, because project knowledge belongs to the project.

## Tradeoffs accepted

- We accept depending on Claude Code's plugin system in exchange for zero drift. `AGENTS.md` keeps the instructions readable by other agents, but hooks are Claude Code-only.
- We accept a Stop gate that slows the end of a turn in exchange for agents never claiming "done" with red checks. `maxAttempts` bounds the cost.
- We accept fail-open policies in exchange for never blocking a session because of a harness bug.

## Alternatives considered

- **Copy-in template**: see above. Shallow, because each repo has to understand and maintain the harness internals.
- **One script per hook in hooks.json**: hooks.json becomes a second policy list, and each script re-implements config loading and output formatting.

## Open questions and risks

- ~~Should the Stop gate run the full test suite, or only tests related to changed files?~~ Decided in step 3: only related files, through `{files}`.
- Should guard-bash also confirm `git push` to non-protected branches, or only deny force-push to main?
- Do we also want Cursor/Codex adapters for the skills, or is Claude Code the only target?

## Next implementation step

Agents done (see `docs/ROADMAP.md` step 5): `harness:reviewer` (read-only tools, verified and tagged findings, a verdict) and `harness:test-writer` (project-style tests, related tests only, tests and fixtures only). Next: step 6, dogfood and release. Add end-to-end hook tests against a fixture project, try the plugin locally with `claude --plugin-dir .` (including `/harness:review` with the real reviewer agent and a `harness:test-writer` run, since agent behaviour can only be checked by use), then polish the README and tag `v0.1.0`.
