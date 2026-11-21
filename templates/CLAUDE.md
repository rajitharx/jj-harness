# {{project_name}}

## Commands
- Format: `{{verify.format}}`
- Lint: `{{verify.lint}}`
- Typecheck: `{{verify.typecheck}}`
- Test: `{{verify.test}}`

`{files}` in a command stands for the files changed since HEAD, so the harness checks only related files (format runs on each edited file). A command without `{files}` checks the whole project.

## Working rules
- Run the `verify` skill before saying a task is done.
- Keep changes scoped to the request; surface anything else as a note.
- Update `.harness/progress.md` via the `handoff` skill at the end of a session.

## Project notes
<!-- architecture, conventions, gotchas -->
