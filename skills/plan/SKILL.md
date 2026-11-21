---
name: plan
description: Turn a request into a written, checkable plan in .harness/plans/ before writing code. Use for non-trivial features, refactors or bug fixes that touch several files, or when the user says "plan", "make a plan" or "how would you do this".
---

# plan

## Steps

1. **Explore first.** Read the code the request touches before planning: the entry points, the modules that would change, their tests, and the project's `CLAUDE.md`. Find the existing patterns to follow and the tests that cover the area. Don't plan from file names alone.

2. **Write the plan** to `.harness/plans/<yyyy-mm-dd>-<slug>.md`, using today's date and a short kebab-case slug for the request (for example `.harness/plans/2026-11-21-rate-limit-login.md`). Create the directory if needed. Use exactly these sections:

   ```markdown
   # <title>

   ## Goal
   What will be true when this is done, in one or two sentences.

   ## Constraints
   Rules from CLAUDE.md, compatibility, performance or security limits, things that must not change.

   ## Steps
   1. <change> — files: `path/a`, `path/b`
      Verify: <the exact command or check that shows this step works>
   2. ...

   ## Risks
   What could go wrong, and how you'd notice.

   ## Out of scope
   Related work you will not do in this change.
   ```

   Every step has its own **Verify** line: a test to add or run, a command, or an observable behaviour. Keep steps small enough to verify one at a time.

3. **Stop for approval.** Show the user the plan's path and a short summary, then wait for them to approve or change it before you implement anything. Skip the wait only if the user already said to go ahead.

4. When implementing, follow the steps in order, run each step's verification, and update the plan file if the plan changes.
