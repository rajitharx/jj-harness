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
