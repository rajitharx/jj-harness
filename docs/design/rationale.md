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
- **Deep runtime**: `runHook(event, input) → HookResult` is the whole public surface. Policies return a small `Verdict` union, and merging it into Claude Code's exit codes and JSON happens in one place, so the wire protocol doesn't leak into the policies.
- **Fail open**: if a policy crashes, it logs to stderr and allows. A broken harness must never brick a session. Guards are the exception: they are pure and unit-tested.
- **Zero dependencies**: Node ≥20 stdlib only, so installing the plugin never runs `npm install`.

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

- Should the Stop gate run the full test suite, or only tests related to changed files?
- Should guard-bash also confirm `git push` to non-protected branches, or only deny force-push to main?
- Do we also want Cursor/Codex adapters for the skills, or is Claude Code the only target?

## Next implementation step

Core runtime done (see `docs/ROADMAP.md` step 1). Next: `guard-bash` and `guard-paths`.
