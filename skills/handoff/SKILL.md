---
name: handoff
description: Append a short, dated progress note to .harness/progress.md so the next session or agent can pick up where this one stopped. Use at the end of a session, before the context gets long, or when the user says "handoff", "write a progress note" or "wrap up".
---

# handoff

1. Gather the facts: `git rev-parse --abbrev-ref HEAD`, `git status --short`, the last few commits (`git log --oneline -5`), and what was done in this session. If a plan in `.harness/plans/` drove the work, note its path.

2. **Append** (never rewrite earlier entries) one entry to `.harness/progress.md`, creating the file if it is missing:

   ```markdown
   ## <yyyy-mm-dd> <branch>: <one-line topic>
   - Done: <what is finished and committed, with commit or PR refs>
   - In progress: <half-done work: files, and what state they are in>
   - Next: <the next concrete step, first>
   - Open questions: <decisions waiting on the user>
   - Gotchas: <traps the next session should know: flaky tests, odd setup, things that look wrong but aren't>
   ```

   Write "none" for an empty part rather than dropping it.

3. **Keep it short**: about 10 lines, at most 15. Session start shows only the last 40 lines of this file (and at most about 1.2 KB), so a long entry pushes the useful parts out. Link to plans, PRs or files instead of copying them in.

4. Tell the user the entry was added, and remind them that `.harness/progress.md` is meant to be committed.
