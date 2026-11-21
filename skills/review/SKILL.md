---
name: review
description: Review the current change (branch diff or staged diff) for correctness bugs, security issues and test gaps, using the read-only reviewer agent, and report only verified findings ranked by severity. Use before committing or opening a PR, or when the user says "review", "review my changes" or "check this diff".
---

# review

## Steps

1. **Collect the diff.**
   - Find the base branch: `git symbolic-ref --short refs/remotes/origin/HEAD` (strip `origin/`), falling back to `main`, then `master`.
   - On a feature branch: `git diff <base>...HEAD`, plus `git diff HEAD` for uncommitted work.
   - If the user asks for the staged change, or you're on the base branch: `git diff --staged`.
   - If the diff is empty, say so and stop. Also note the list of changed files (`git diff --stat`).

2. **Send it to the reviewer.** Use the Agent tool with `subagent_type: "harness:reviewer"`. In the prompt, give it:
   - the base ref and the exact diff commands you used (and the diff itself, unless it is very large);
   - the list of changed files and the intent of the change in one or two sentences;
   - the project's rules files: `CLAUDE.md` and `AGENTS.md` at the root (and any in the changed directories), which it must read and check the change against;
   - the plugin path (two levels above this skill's base directory, which you were told when the skill loaded), and the check command to run: `node "<plugin>/bin/harness.mjs" verify --base <base>` with the same base ref as the diff (plain `verify` only for a staged or uncommitted-only review, since without `--base` it sees only uncommitted work). Tell it that `verify: nothing ran` (exit 0) means no checks executed, not a pass;
   - any focus areas the user named.

   The agent is read-only and returns findings tagged `blocking`, `should-fix` or `nit`, each with file:line, evidence, a fix and CONFIRMED or PLAUSIBLE, plus a "Checked and fine" list and a verdict.

3. **Re-verify every finding yourself** before reporting it. Open the code at the cited lines and check that the problem is real in this diff: trace the inputs, read the callers, and re-run the agent's repro or a small command where you can. Drop findings that don't hold up, and findings about code the diff didn't touch (mention those separately only if serious). Keep the agent's CONFIRMED/PLAUSIBLE tag only if your own check agrees; downgrade it otherwise.

4. **Report, ranked by severity**: blocking, then should-fix, then nit. For each finding give the file and line, what goes wrong and when, the evidence, the suggested fix and the verdict tag. Then the checks the agent ran and their results, reporting `verify: nothing ran` as "no checks executed", never as passing, and the verdict (approve, or request changes if any blocking finding remains). Say how many findings the reviewer raised and how many you dropped. If nothing survives, say the review found no verified issues.

   If a finding is a missing test for changed behaviour, offer to run the `harness:test-writer` agent on it.

Don't edit files during the review unless the user asks for the fixes.
