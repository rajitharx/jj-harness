## 2026-11-22 rajiatha/harness-stats: harness stats (per-session metrics)
- Done: Steps 0–1 (branch, resume file, ROADMAP row). Plan: .harness/plans/harness-stats.md
- In progress: nothing half-done
- Next: Step 2, lib/metrics.mjs and recording from runHook, verify-gate, format-on-edit
- Open questions: launchd job at ~/Library/LaunchAgents/com.rajitha.jj-harness-stats.plist is written, not loaded; needs user's yes
- Gotchas: main checkout was empty at start (index of the initial commit was empty); pulled to restore
## 2026-11-22 rajiatha/harness-stats: stats step 2 (recording)
- Done: lib/metrics.mjs, lib/state.mjs, runHook records verdict.metrics, 5 policies emit metrics; 416 tests green
- In progress: nothing half-done; new tests for metrics are Step 4
- Next: Step 3, lib/stats.mjs + `stats` command + skills/stats
- Open questions: launchd job still not loaded (needs user's yes)
- Gotchas: policy tests use bare() from test/helpers.mjs to ignore `metrics`
## 2026-11-22 rajiatha/harness-stats: stats steps 3-4 (command, skill, tests)
- Done: lib/stats.mjs, `stats` CLI, skills/stats, tests (463 pass), e2e replays a session and checks `stats --json`
- In progress: nothing half-done
- Next: Step 5 docs (README, CHANGELOG, ROADMAP log, rationale), then Step 6 PR + separate review
- Open questions: launchd job still not loaded (needs user's yes)
- Gotchas: stats times are UTC; coverage is a lower bound (no paths stored)
## 2026-11-22 rajiatha/harness-stats: stats step 5 (docs)
- Done: README Stats section, CHANGELOG, ROADMAP log, rationale section + next step
- In progress: nothing half-done
- Next: Step 6, push, PR, separate review, merge
- Open questions: launchd job still not loaded (needs user's yes)
- Gotchas: none
## 2026-11-22 rajiatha/harness-stats: stats review round 1
- Done: fixed Hawkeye's should-fix items (checkedCount, gave-up coverage), nits; 468 tests green; PR #9
- In progress: awaiting re-review
- Next: re-review, merge, set Status DONE
- Open questions: launchd job never loaded (needs user's yes); can stay unloaded
- Gotchas: never write `**/` inside a JSDoc block comment: it ends the comment
