---
name: stats
description: Report what the harness did in a session, how much of the change its checks covered, and what they caught. Use when the user asks "what did the harness check", "how much was verified", "harness stats" or "what did the gate catch".
---

# stats

The CLI lives in this plugin, two levels above this skill. You were told this skill's base directory when it loaded; run, from the project:

```sh
node "<skill base dir>/../../bin/harness.mjs" stats
```

Replace `<skill base dir>` with that absolute path.

- With no flags it reports the most recent session that has a gate run (`--last`). `--session <id>` picks one session; `--since 7d` (or `24h`, or a date like `2026-11-20`) reports every session since then, with totals and one line per session; add `--json` only if the user asks for machine-readable output.
- Exit codes: 0 a report, or `stats: no data` (the harness hasn't recorded a session here yet); 2 a usage error or an unreadable `.harness/state/`.

## Reporting

- Quote the CLI's output exactly, in a code block. **Never paraphrase or recompute the numbers**, and don't add a score of your own.
- Explain verification coverage in one line: it is the share of changed files that at least one check (lint, typecheck or test) actually ran on, taken from the last Stop-gate run, and a lower bound.
- Say plainly that a high number means "checked", not "bug-free": coverage says nothing about whether the checks are good, and problems found after the gate passed (CI, review, reverts) aren't measured.
- `n/a` means nothing the checks could see had changed. `0%` with "no checks ran" means every stage was skipped or unconfigured; suggest `harness-init` if no commands are configured.
- If it says `stats: no data`, say so; don't guess at numbers.
