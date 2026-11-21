---
name: harness-init
description: Set up the harness in the current project. Detects the stack, proposes related-tests-only verify commands, checks they run, then writes .harness/config.json, a CLAUDE.md/AGENTS.md harness block and .harness/progress.md. Use when the user says "init harness", "set up the harness", or when session context says there is no .harness/config.json.
---

# harness-init

The CLI lives in this plugin, two levels above this skill. You were told this skill's base directory when it loaded; call the CLI as:

```sh
node "<skill base dir>/../../bin/harness.mjs" init            # dry run: prints JSON, writes nothing
node "<skill base dir>/../../bin/harness.mjs" init --write    # writes the files
```

Replace `<skill base dir>` with that absolute path. Run it from the project root (or any directory inside it).

## Steps

1. **Propose.** Run `init` (dry run). It prints JSON with `stacks`, the proposed `config`, `notes` and `changes` (what `--write` would create, update or keep). Show the user the stacks, each verify command with its `files` filter, and the planned changes.

2. **Check that each command runs.** For every proposed command, try it once on one real file of the project:
   - replace `{files}` with one matching file (for example a test file or a source file the filter allows), and `{dirs}` with that file's directory (`./pkg/x`, or `.` for the root);
   - for `format`, append the file path, but **only** if you are fine with that file being reformatted; otherwise run the formatter's check mode (`prettier --check`, `ruff format --check`, `gofmt -l`) instead;
   - run whole-project commands (no placeholder, like `tsc --noEmit` or `cargo check`) as written.

   A failure because the tool is missing ("command not found", `npx --no` refusing to download, a missing module) is not an error to report and stop on. It is a fix to propose: install the tool as a dev dependency, use another tool the project already has, or drop that stage. A failure that comes from the project's code (real lint errors, failing tests) means the command works; say so and move on.

3. **Ask about the notes.** Go through every entry in `notes` with the user. In particular:
   - no test command (Rust, or no runner found): ask which command to use. Prefer one that takes `{files}` or `{dirs}`. Never add a full-suite command silently: the Stop gate would run it on every stop.
   - pytest without pytest-testmon, or `node --test`: only changed test files run. Offer pytest-testmon for Python.
   - several stacks: only the first stack's commands are proposed. Ask which stack the gate should check.

4. **Write.** Run `init --write`. It:
   - creates `.harness/config.json`, or keeps an existing one (it says `kept`); pass `--force-config` only if the user agrees to replace it;
   - creates `CLAUDE.md`, or, if it exists, inserts or replaces only the block between `<!-- harness:start -->` and `<!-- harness:end -->` (everything else stays byte for byte);
   - creates `AGENTS.md` as a pointer to `CLAUDE.md`, or merges the same marker block into it;
   - creates `.harness/progress.md` if it is missing.

   If the user changed commands in steps 2–3, edit `.harness/config.json` after the first `--write` (string, or `{ "run": "...", "files": ["**/*.ts"] }`), then run `init --write` again: it keeps your edited config and refreshes the `CLAUDE.md` block from it. It is safe to re-run; unchanged files say `unchanged`. If it prints `refused`, nothing was written: fix what it names (usually broken markers) and re-run.

5. **Report.** Show the CLI's list of what it created, updated or kept. Remind the user to commit `.harness/config.json`, `CLAUDE.md`, `AGENTS.md` and `.harness/progress.md`. `.harness/state/` ignores itself in git, so it needs nothing.

## Config reference

- `{files}`: the changed files (vs HEAD), shell-quoted and root-relative; `{dirs}`: their unique directories. A stage using either is skipped when nothing matches.
- `files`: globs (`**`, `*`, `?`). Only changed files that match reach the command, and a command with a filter is skipped when none match.
- `format` without a placeholder gets the edited file appended.
