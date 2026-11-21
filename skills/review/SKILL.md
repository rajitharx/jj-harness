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

2. **Send it to the reviewer.** Use the Agent tool with `subagent_type: "harness:reviewer"`. In the prompt, give it the base branch, the list of changed files, the diff (or the command to produce it, if it is very large), and the intent of the change in one or two sentences. Ask for correctness, security and test-gap findings, each with a file, a line, and a concrete failure scenario.

3. **Verify every finding yourself** before reporting it. Open the code at the cited lines and check that the problem is real in this diff: trace the inputs, read the callers, and run a test or a small command where you can. Drop findings that don't hold up, and findings about code the diff didn't touch (mention those separately only if serious).

4. **Report, ranked by severity**: blocking (bugs, security holes, data loss), then important (missing tests for new behaviour, error-handling gaps), then minor. For each finding give the file and line, what goes wrong and when, and a suggested fix. Say how many findings the reviewer raised and how many you dropped. If nothing survives, say the review found no verified issues.

Don't edit files during the review unless the user asks for the fixes.
