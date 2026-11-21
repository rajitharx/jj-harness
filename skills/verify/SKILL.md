---
name: verify
description: Run the project's lint, typecheck and test commands from .harness/config.json on the changed files and report the exact result. Use before saying a task is done, before committing, or when the user says "verify", "run the checks" or "do the tests pass".
---

# verify

The CLI lives in this plugin, two levels above this skill. You were told this skill's base directory when it loaded; run, from the project:

```sh
node "<skill base dir>/../../bin/harness.mjs" verify
```

Replace `<skill base dir>` with that absolute path.

- It runs lint, typecheck and test through the same runner as the Stop gate, on the files that differ from HEAD (each command's `files` filter applies). It prints one line per stage, `ok`, `FAILED` with the output tail, or `skipped` with the reason, then `verify: passed`, `verify: failed (...)` or `verify: nothing ran`.
- Exit codes: 0 passed or nothing to run, 1 a check failed, 2 the config or git couldn't be read.
- Add `--all` (checks run as if every tracked file had changed) **only** when the user asks for a full check. It can be slow.

## Reporting

- Quote the CLI's output exactly: the stage lines, the failing command and its output tail. Don't paraphrase errors.
- Never claim a pass you didn't see. If the run timed out, was interrupted, or every stage was skipped, say that instead of "passed".
- If a stage failed, say which one and what the output shows. Fix it only if the user asked you to, then run `verify` again and report the new result.
- If there's no `.harness/config.json`, say so and suggest the `harness-init` skill.
