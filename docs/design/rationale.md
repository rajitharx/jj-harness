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
- **Two audiences, two channels**: `block` and `context` verdicts are for the agent. A `notice` verdict is for the user: `runHook` puts it in the common `systemMessage` field on every event, next to any block or context. The Stop gate uses it to report what it did (`harness: lint ✓ (1 file) test ✓ (1 file)`, each count being the files that stage's command was given), because the agent's last message is written before Stop fires and can't know. Stop's own `additionalContext` would continue the turn, so it isn't used for this.
- **Fail open**: if a policy crashes, it logs to stderr and allows. A broken harness must never brick a session. Guards are the exception: they are unit-tested and nearly pure. The only I/O is `guard-bash` reading `.git/HEAD` to find the current branch, and it allows the command if that read fails.
- **Zero dependencies**: Node ≥22 stdlib only, so installing the plugin never runs `npm install`.
- **Related tests only**: the Stop gate checks what changed, not the whole suite. Any `verify.*` command may contain `{files}` (the shell-quoted changed files, working tree vs HEAD) or `{dirs}` (their directories), which `lib/verify.mjs` substitutes; with nothing to pass, that stage is skipped. An entry may be `{ "run", "files": [globs] }`: only matching changed files reach the command, and it is skipped when none match, so docs and config changes never reach strict tools. Commands without a placeholder, such as typecheck, run as written, and `format` gets the edited path appended.
- **Detection is code, not prose**: `lib/detect.mjs` turns a project's manifests into proposed commands (`vitest related --run {files}`, `jest --findRelatedTests {files}`, `go test {dirs}`, `pytest --testmon`, …) and notes where a stack has no related-test mode. It reads files only, and table-driven fixture tests pin it down. Within one directory, multiple stacks aren't merged (one entry has one filter); the first stack with commands wins and the rest are reported. Across directories they are: the root and each package (an immediate subdirectory, or a child of `apps/`, `packages/` or `services/`, holding a manifest) contribute their own commands, and a package's commands carry its path as `cwd`. .NET (`*.sln`, `*.slnx`, `*.csproj`) is a stack like the others.
- **A small CLI for the skills**: `bin/harness.mjs init [--write] [--force-config] [--packages <paths>]` and `verify [--all | --base <ref>]`. Skills reach it through their base directory (`<skill base dir>/../../bin/harness.mjs`), so the deterministic parts (detection, merging the `CLAUDE.md` marker block, running the checks) are tested code, and the skills keep only the judgement: confirming commands, asking the user, reporting. `verify` runs through the same `runStage` and changed-file source as the Stop gate: `changedFiles(root, base?)` in `lib/git.mjs`, where `--base` adds the branch's committed changes (`<base>...HEAD`) so committed work can be checked.

- **Agents are prompts with least-privilege tools**: `reviewer` gets `Read, Grep, Glob, Bash` and must verify each finding before reporting it, and `test-writer` gets an explicit list without network tools. Skills reference them as `harness:<name>`, and a test checks that every reference resolves.

## Public surface

Three things outside code can depend on, each kept small:
- `runHook(event, input)` for hooks (one entry point, `hooks/run.mjs`).
- The config file: per stage, a string or `{ run, files, cwd }` (or an array of them), with `{files}`/`{dirs}`, plus `protectedPaths`, `blockedCommands`, `stopGate` and `formatTimeoutSec`. Both entry forms normalize to one internal shape in `lib/config.mjs`, so the object form adds schema but no second code path.
- The CLI: two subcommands and three flags. The skills test reads the subcommand list from the CLI module, so a skill can't call one that doesn't exist.

**Monorepos (0.2.0).** One command per stage can't express "each package's own tests in its own directory". The two ways out were a single generated shell command that loops over the packages, or extending the schema; I extended the schema: an entry may have a `cwd`, and a stage may be an array of entries.

- *Why not a shell loop.* `{files}` is substituted with every changed file, root-relative. A loop would have to split that list per package, strip each package's prefix and `cd` in POSIX `sh`, inside a string that also has to survive JSON, the shell's quoting and `files` filters written against root-relative paths. That logic is the part most likely to be wrong, it would be generated text nobody can unit-test, and the user would have to read and edit it. A `cwd` field is the same logic written once, in `planStage`, with table-driven tests.
- *Why it stays small.* `cwd` is one more key on the object form, and the array form is the same entry repeated. `lib/config.mjs` is still the only module that knows the schema: it validates (`cwd` must be relative with no `..`, so a config can't point outside the project) and normalizes (one entry stays an object, so every single-stack config and every consumer that reads `config.verify.<stage>` is unchanged; several become an array, read through `stageEntries`). `runStage` runs the entries in order, stops at the first failure and gives the whole stage one time limit, so the gate's existing deadline arithmetic still holds and its callers see one result per stage.
- *Semantics.* With `cwd`, only changed files below it count, and they are made relative to it before the `files` globs, `{files}` and `{dirs}` are applied. The filter is therefore written as if the package were the repo (`**/*.ts`), which is what detection reuses per stack and what a human editing the config expects. A command with a `cwd` and no placeholder (`dotnet test`) runs only when something below it changed, which a bare `dotnet test` in a shell loop could not do.
- *.NET has no related-test mode.* `dotnet test` is proposed (it is what the project runs), but the note says it runs the whole suite when any `.cs`, `.csproj`, `.razor` or props/targets file changes, and the skill asks before keeping it. This is the same rule as for Rust, with the opposite default: the user named `dotnet test` as the command, so it is proposed and flagged, not silently decided and not silently omitted.
- *`init --packages`.* The skill has to ask which packages the gate should check. Removing entries from several arrays in `config.json` by hand is easy to get wrong, so `init` takes `--packages a,b` and detection filters instead. The package list is also printed (`packages`) so the question has something to ask about.
- *Root and packages together.* A root project's commands have no `cwd` and see every file. So a package whose primary stack is the root's, and whose stages the root also proposes (a nested `e2e/` or `fuzz/` project, the `src/` and `tests/` projects of a root solution) is left out by default, with a note saying so: proposing it would run the same checks twice, and for `dotnet test` that means the whole suite once per project. This also keeps a single-stack repo's proposal what it was before packages existed. An explicit `--packages` is taken as given, so the user can still add such a package, and then gets a "may run twice" note. A package inherits only its lockfile and tool configs (eslint, prettier, biome) from the root, because those are found by walking up.

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

After 0.2.0: see the ROADMAP known gaps. 0.2.0 added monorepo and .NET detection (`cwd` and array entries); the `harness--v0.2.0` tag is created after the merge. Top follow-ups:

1. **Dogfood the agents and the remaining skills.** `harness:reviewer`, `harness:test-writer`, `/harness:review`, `/harness:ship`, `/harness:plan`, `/harness:handoff` and `/harness:harness-init` loaded in the live run but weren't invoked. Agent behaviour (verified findings, tests-only edits) can only be checked by use. `harness-init` in a real monorepo (OnLah) is the first to try.
2. **Scope the Stop gate to the session's own changes.** It checks everything uncommitted, including work from before the session, and misses work committed mid-turn. A SessionStart snapshot of the dirty set and `HEAD` would fix both.
3. **Close the cheapest guard gaps**: scripts piped or here-stringed into a shell (`echo '…' | bash`), `.env.example` being unprotectable (an `allowPaths` setting or default exclusions), and `**/.git/**`.
4. **Fit Claude Code's 10,000-character hook-string cap.** The hooks reference caps `additionalContext` and `systemMessage` at 10,000 characters and replaces longer text with a file path and a 2,000-character preview the model isn't asked to read. `runHook` caps context at 16 KB, so context between 10,000 characters and 16 KB reaches the model only as that preview. The reference doesn't say whether `reason` and `permissionDecisionReason` share the cap. Notices are already capped at 1,000. A monorepo's session context lists every entry, so it is the likeliest to approach the cap.
5. **Monorepo gaps**: packages are found one or two levels down only, and not from workspace globs (`pnpm-workspace.yaml`, `workspaces`, Cargo or Go workspaces); the root's tool dependencies aren't inherited by packages (only lockfiles and tool configs are); and there is no per-package `tsc -b` for solution-style `tsconfig.json`.
6. **Plugin icon** (`ICON_MISSING`) if the plugin is ever submitted to the public directory.
