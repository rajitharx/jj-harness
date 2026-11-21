# {{project_name}}

<!-- harness:start -->
## Harness

Verify commands (from `.harness/config.json`):
- Format: {{verify.format}}
- Lint: {{verify.lint}}
- Typecheck: {{verify.typecheck}}
- Test: {{verify.test}}

`{files}` in a command stands for the files changed since HEAD and `{dirs}` for their directories, so the harness checks only related files (format runs on each edited file). A command with a file filter only sees, and only runs for, matching files. A command without a placeholder checks the whole project.

Working rules:
- Run the `verify` skill before saying a task is done. The Stop gate re-runs lint, typecheck and test on changed files anyway.
- Keep changes scoped to the request; surface anything else as a note.
- Plan non-trivial work with the `plan` skill; ship with the `ship` skill.
- Update `.harness/progress.md` with the `handoff` skill at the end of a session.

This block is managed by `harness-init`; edit outside the markers.
<!-- harness:end -->

## Project notes
<!-- architecture, conventions, gotchas -->
