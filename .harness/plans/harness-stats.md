# Plan: harness stats

Status: DONE
Branch: rajiatha/harness-stats
PR: https://github.com/rajitharx/jj-harness/pull/9
Last checkpoint: 2026-11-22 — Hawkeye re-review: approve (nits only); 468/468 tests; merging PR #9.
Next action: none. PR #9 squash-merged; launchd job was never loaded (still needs the user's yes only if wanted).

## Checklist
- [x] Step 0 — clean main, branch, resume file, auto-resume files written (launchd NOT loaded: needs user "yes")
- [x] Step 1 — plan (ROADMAP row + checklist, plan below)
- [x] Step 2 — recording metrics code (`lib/metrics.mjs`, `lib/state.mjs`, runHook, all 5 policies); its tests are in Step 4
- [x] Step 3 — `stats` command + `skills/stats/SKILL.md`
- [x] Step 4 — tests (468 passing)
- [x] Step 5 — docs (README, CHANGELOG, ROADMAP, rationale)
- [x] Step 6 — verify, commit, PR, separate review, merge, DONE

## Plan
- `lib/metrics.mjs`: sole owner of `.harness/state/metrics.jsonl`; `recordMetric`, `readMetrics`, rotation at 1 MiB; fail open; no paths/commands.
- `runHook` records the generic entry per policy (policy name from the registry function name); verify-gate / format-on-edit record their detail entries directly.
- `lib/stats.mjs` (pure aggregation) + `stats` command in `bin/harness.mjs`.
- Docs + tests per the spec below.

## Decisions
- ROADMAP row is labelled `stats` (not 0.3.0), because the spec says not to bump the version.
- Recording uses the optional `metrics` field on the Verdict (the spec's allowed alternative), not direct `recordMetric` calls from policies: `runHook` is the only writer, policies stay pure. `runHook` ignores a `metrics` that isn't a plain object (a policy bug must not change a verdict) and derives the `policy` id from the function name in kebab case.
- `lib/metrics.mjs` rebuilds every entry from a per-policy whitelist (privacy by construction, not by caller discipline).
- New `lib/state.mjs` (`ensureStateDir`) is the one place that creates `.harness/state/` + its self-ignoring .gitignore; verify-gate now uses it too.
- `changedFiles` in a verify-gate entry = files the stages can see (`stageFiles`: not deleted, not `.harness/`), so coverage's denominator isn't inflated by files no stage can check.
- verify-gate records: pass, nothing-ran, block, gave-up, deadline. Not recorded: `unchanged` (silent path) and the two fail-open paths (unreadable/unsaveable attempt counter).
- guard-bash rules got stable ids; `blockedCommands` hits use the id `blockedCommands`.
- Review round 1 (Hawkeye): coverage uses `checkedCount` (distinct files a stage covered, new in `runStage`/`planStage`), and ignores a `gave-up` entry when picking the entry for coverage/stages (departs from the spec's literal "LAST entry"). Allows stay recorded (spec); volume/state-dir side effects documented as known gaps.
- The launchd job is written but not loaded: this session is non-interactive so the user's "yes" could not be asked for.

## Original prompt

# Task: add `harness stats`, per-change metrics for jj-harness

## Context
jj-harness is a Claude Code plugin (Node ≥22, stdlib only). Read these first, fully:
`CLAUDE.md`, `docs/design/rationale.md`, `docs/ROADMAP.md`, `lib/harness.mjs`, `lib/config.mjs`,
`hooks/run.mjs`, `hooks/policies/*.mjs`, `bin/harness.mjs`, and the related tests in `test/`.

Goal: record what the harness did during each session and add a `stats` command that reports it.
The command answers "how much of this change did the harness actually check, and what did it catch?"
It must NOT invent a single "harness effectiveness %". The one percentage we report is
**verification coverage** (defined below). Everything else is a count or an outcome.

## use multiple agents if needed (use avengers superhero's name)

## Session limits and resuming (read before anything else)
This task may not finish in one session, because I'm on a usage-limited plan. Once the limit is hit
you can't act any more, so set up the resume mechanism NOW and save progress all the way through.

### A. Resume file (the source of truth for progress)
Create `.harness/plans/harness-stats.md` (`.harness/plans/` is the `plan` skill's folder). It holds:
- `Status: IN_PROGRESS | BLOCKED | DONE`
- the step checklist from this prompt (Steps 0–6), ticked as you go
- `Branch:`, `PR:` (URL once opened), `Last checkpoint:` (ISO time + one-line summary)
- `Next action:` one concrete sentence a fresh session can act on without this chat
- `Decisions:` any choice you made that departs from this prompt or the sketch
- this whole prompt, copied verbatim under `## Original prompt`, so a fresh session has the spec

If you can't commit this file (e.g. `.harness/plans/` is git-ignored), say so and keep it local.
It only needs to exist on this machine.

### B. Checkpoint after every step, and as soon as you see a usage-limit warning
1. Update the resume file (ticks, `Last checkpoint`, `Next action`).
2. Commit work in progress on the feature branch (`wip(stats): …` is fine; it's squash-merged later).
   Never commit to `main`.
3. Append a short dated note to `.harness/progress.md` (same format as the `handoff` skill).
If Claude Code shows a usage-limit or "approaching limit" notice, stop what you're doing,
checkpoint straight away, then carry on only if there's room.

### C. Auto-resume job (macOS launchd), set up in Step 0 but load it only after I approve
You can't schedule anything after you're cut off, and the reset time isn't known in advance, so use
an hourly retry that turns itself off when the work is done.

1. Write `~/.claude-resume/jj-harness-stats/resume.sh` (outside the repo, `chmod +x`):
   - `cd` to the repo root (absolute path).
   - Exit 0 if the resume file says `Status: DONE`, or `BLOCKED`, after unloading the launchd job
     (`launchctl bootout gui/$(id -u)/com.rajitha.jj-harness-stats`).
   - Lock: if `~/.claude-resume/jj-harness-stats/lock` exists and its PID is alive, exit 0 (a session
     is already running). Otherwise write `$$` to it and remove it on exit (`trap`).
   - Run headless:
     `claude -p "$(cat ~/.claude-resume/jj-harness-stats/prompt.txt)" --permission-mode acceptEdits --allowedTools "Bash,Read,Edit,Write,Glob,Grep" >> ~/.claude-resume/jj-harness-stats/run.log 2>&1`
     Check `claude --help` first and use the flag names your installed version actually has.
   - Log the start/end time and exit code to `run.log`. A non-zero exit, e.g. still rate-limited,
     just means "try again next hour".
2. Write `~/.claude-resume/jj-harness-stats/prompt.txt`:
   "Resume the jj-harness `harness stats` task. Read `.harness/plans/harness-stats.md` (the spec is
   under 'Original prompt'), `.harness/progress.md` and `git log` on the feature branch. Continue from
   'Next action', following the spec, including checkpointing. You are running unattended: don't ask
   questions; take the most reasonable reading, record it under 'Decisions', and continue. If a
   decision can't be undone and could reasonably go either way, set `Status: BLOCKED`, explain it
   under 'Next action', checkpoint and stop. When everything in 'Done when' is met and the PR is
   merged, set `Status: DONE`."
3. Write `~/Library/LaunchAgents/com.rajitha.jj-harness-stats.plist`: `StartInterval` 3600,
   `RunAtLoad` false, `ProgramArguments` = `/bin/bash -lc <path to resume.sh>` (login shell so `PATH`
   has `node`, `claude`, `gh`), stdout/stderr to the same log folder.
4. **Show me all three files and wait for my "yes" before loading.** Then:
   `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.rajitha.jj-harness-stats.plist`
   and confirm with `launchctl print gui/$(id -u)/com.rajitha.jj-harness-stats`.
5. Tell me the one-liner to stop it by hand:
   `launchctl bootout gui/$(id -u)/com.rajitha.jj-harness-stats`.
6. If Claude Code here offers its own scheduling tool that runs a fresh session in this repo on this
   machine, you may offer it as an alternative, but don't use a session-only cron (it disappears
   when this session ends).

## Step 0 — get a clean main, and set up resuming
The main checkout may be empty (only `.git/` and `.claude/`). Run `git status` and `git worktree list`.
Restore the working tree on `main` (`git checkout main && git pull`). Don't touch the
`.claude/worktrees/agent-*` folders. If `main` has open PRs, stop and tell me (CLAUDE.md: merge open PRs first).
If the resume file already exists, you're a resumed session: skip ahead to its `Next action`.
Otherwise: create branch `rajiatha/harness-stats`, create the resume file (A), and set up the
auto-resume job (C). Checkpoint.

## Step 1 — plan
Add a new step to `docs/ROADMAP.md` (status table row + checklist matching the items below).
Write the plan into the resume file before writing any code. If anything in the current code
contradicts this prompt, follow the code's existing patterns and record the departure under
'Decisions' and in the ROADMAP completion log. Checkpoint.

## Step 2 — recording metrics

### New module `lib/metrics.mjs`
- It is the ONLY module that knows the metrics file path, schema and rotation rules
  (same rule as `lib/config.mjs` for config).
- Path: `.harness/state/metrics.jsonl` (the state dir already ignores itself in git; reuse
  whatever helper creates it).
- API (adjust the names to match the code style):
  - `recordMetric(root, entry)`: appends one JSON line. Adds `v: 1` and `ts` (ISO 8601 UTC).
  - `readMetrics(root, { since, session })`: returns the parsed entries. Skips malformed lines and
    lines with an unknown `v`, without throwing.
  - Rotation: when the file is over 1 MiB before an append, keep the newest ~50% of lines (rewrite
    atomically: temp file + rename).
- **Fail open:** every function catches its own errors. A metrics failure must never change a verdict,
  block a session or write to stdout. At most one short stderr line.
- **Privacy:** never record command text, command output, file contents, env values or file paths.
  Only counts, policy/rule ids, stage names, outcomes, durations, session id and tree fingerprint.

### Entry schema (v1)
Common fields: `v`, `ts`, `session` (hook input `session_id`, or `null`), `event`, `policy`.

| policy | extra fields |
| --- | --- |
| `guard-bash` | `verdict` (`allow`\|`deny`), `rule` (rule id on deny, else omitted) |
| `guard-paths` | `verdict`, `rule: "protectedPaths"` on deny |
| `format-on-edit` | `result` (`ok`\|`failed`\|`skipped`\|`timeout`), `ms` |
| `verify-gate` | `fingerprint`, `changedFiles` (count), `stages`: `[{name, configured, ran, result: "pass"\|"fail"\|"skipped"\|"timeout", filesChecked, ms}]`, `outcome` (`pass`\|`block`\|`nothing-ran`\|`gave-up`\|`deadline`\|`unchanged`), `attempt` |
| `session-context` | no extra fields (marks the session start) |

`filesChecked` = how many changed files were passed to that stage after the `files` glob filter.
For a stage whose command has no placeholder and runs as written (whole project), set
`filesChecked = changedFiles` when it ran, 0 when skipped.

### Where to record
- Recording must not break the rule that "policies return a Verdict and never write hook JSON".
  Preferred design:
  - `runHook` in `lib/harness.mjs` records the generic entry (event, policy, verdict kind) for every
    policy run, in one place.
  - `verify-gate` and `format-on-edit` have the extra details, so they call `recordMetric`
    directly (they already write state). If you find a cleaner way, e.g. an optional `metrics` field
    on the verdict that `runHook` records, use it, keep the Verdict validation strict, and record
    the decision in the rationale.
- Don't record a `verify-gate` entry on the silent "no new changes since last pass" path
  (outcome `unchanged` is allowed but optional; pick one and document it).

Checkpoint.

## Step 3 — the `stats` command

`node bin/harness.mjs stats [--session <id> | --last | --since <ISO date or 7d/24h>] [--json]`
- Default scope: `--last` (the most recent session that has a verify-gate entry).
- Human output (one block, readable in a terminal and in a skill reply), for example:

```
harness stats — session 3f2a… (2026-11-22 07:40 → 08:05)
verification coverage   80%  (8/10 changed files checked by ≥1 stage)
stages                  lint ✓ 8/10 · typecheck skipped · test ✓ 6/10
gate                    3 stops · 2 blocks · final: pass after 2 blocks
caught                  2 failures fixed before stop (lint 1, test 1)
format-on-edit          12/12 ok
guards                  1 deny (bash: force-push-main) · 0 path denies
```

- Multi-session scopes (`--since`) show totals plus per-session lines.
- `--json` prints one object with the same numbers (stable keys, documented in the README).

### Definitions (put these in the README too)
- **Verification coverage** = changed files checked by at least one stage that *ran* (result
  `pass` or `fail`), divided by `changedFiles`, using the LAST verify-gate entry of the session.
  If `changedFiles` is 0 → print `n/a`, not 100%. If no stage ran → `0%` with the note `no checks ran`.
  Because the schema doesn't store paths, "checked by ≥1 stage" = max `filesChecked` over the stages
  that ran. Document that this is a lower bound.
- **Caught** = verify-gate entries with outcome `block` in a session where a later entry has outcome
  `pass`. Count by the stage that failed.
- **Gate final outcome** = outcome of the session's last verify-gate entry.
- **Escapes** (problems found after the harness passed: CI, reviewer, reverts) are OUT OF SCOPE.
  Mention them as a known gap / future step.

### Exit codes (match `verify`)
- 0: report printed, or `stats: no data` (also exit 0).
- 2: usage error or unreadable state dir.

### Skill
Add `skills/stats/SKILL.md` (`/harness:stats`): runs the CLI and quotes the output verbatim, never
paraphrasing the numbers. It explains coverage in one line, and says plainly that a high number means
"checked", not "bug-free". Follow the format of the existing skills, and update `test/skills.test.mjs`
if it lists the skills.

Checkpoint.

## Step 4 — tests (table-driven, stdlib `node:test`, same style as existing tests)
- `test/metrics.test.mjs`: append + read round trip; malformed / unknown-`v` lines skipped;
  rotation at the size threshold keeps the newest lines and stays valid JSONL; unwritable dir →
  no throw, verdict unchanged; no command text or paths ever written (check the guard-bash deny
  entry for a command containing a fake secret).
- `test/stats.test.mjs`: the aggregation is a pure function over entries. Cover: coverage maths incl.
  `n/a` and `no checks ran`; caught counting; gave-up / deadline outcomes; multi-session `--since`;
  `--json` shape.
- `test/cli.test.mjs`: `stats` with no data, with fixture data, bad flags (exit 2).
- `test/e2e.test.mjs`: extend the replayed session so it ends with `stats --json` and assert the
  numbers.
- `test/harness.test.mjs`: a metrics write failure doesn't change hook output.
- Keep `test/registry.test.mjs` and `test/release.test.mjs` green. If you add a config key (avoid it
  unless needed; a `metrics.enabled` boolean, default `true`, is the only acceptable one), update
  `lib/config.mjs` and the README's `<!-- config-defaults -->` block, which a test keeps in sync.

Checkpoint.

## Step 5 — docs
- README: new "Stats" section (command, flags, example output, definitions, privacy note: local only,
  in `.harness/state/`, never committed, no command text or paths). Add `/harness:stats` to the skills
  table, `stats` to the CLI paragraph, and the known gaps (coverage is a lower bound, escapes not
  measured).
- `CHANGELOG.md`: entry under `[Unreleased]` → Added. Don't bump the version.
- `docs/ROADMAP.md`: tick the checklist, set the status, and add a completion-log entry (what shipped,
  how it was verified, changes from this prompt, known gaps).
- `docs/design/rationale.md`: short section on why there's no single "effectiveness %" and what
  coverage means. Update "Next implementation step" (suggest escape tracking).

Checkpoint.

## Step 6 — verify, commit, PR (CLAUDE.md workflow)
1. `npm test` and `claude plugin validate .` must pass. Paste the real output; never claim a pass you
   didn't see.
2. Conventional commits, e.g. `feat(metrics): record per-session harness metrics`,
   `feat(cli): add harness stats command`, `docs: stats`, each with the Co-Authored-By trailer.
   (WIP commits get squashed at merge.)
3. Push and open a PR to `main` with `gh pr create`: summary, checklist items done, test output,
   departures from this prompt. Put the PR URL in the resume file. Checkpoint.
4. A SEPARATE reviewer agent (`@agent-harness:reviewer` or a fresh subagent, not you) reviews the
   diff for correctness, privacy (nothing sensitive logged), fail-open behaviour, test gaps and the
   CLAUDE.md code rules. Fix blocking findings and get it reviewed again. When it's clean: check out the
   PR branch, run `npm test`, then `gh pr merge --squash --delete-branch`.
5. `git checkout main && git pull`.
6. Set `Status: DONE` in the resume file, unload the launchd job
   (`launchctl bootout gui/$(id -u)/com.rajitha.jj-harness-stats`), and confirm it's gone.

## Done when
- A real session in a fixture repo produces `.harness/state/metrics.jsonl`, and `stats` prints the
  block above with correct numbers.
- Every hook still exits 0, and hook output is identical with metrics broken.
- All tests and plugin validation pass, the docs are updated, and the PR is merged after a separate
  review.
- The resume file says `Status: DONE` and the launchd job is unloaded.
