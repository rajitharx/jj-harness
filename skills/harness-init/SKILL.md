---
name: harness-init
description: Set up the harness in the current project, including monorepos and .NET. Detects the stacks and packages, proposes related-tests-only verify commands, checks they run, then writes .harness/config.json, a CLAUDE.md/AGENTS.md harness block and .harness/progress.md. Use when the user says "init harness", "set up the harness", or when session context says there is no .harness/config.json.
---

# harness-init

The CLI lives in this plugin, two levels above this skill. You were told this skill's base directory when it loaded; call the CLI as:

```sh
node "<skill base dir>/../../bin/harness.mjs" init            # dry run: prints JSON, writes nothing
node "<skill base dir>/../../bin/harness.mjs" init --write    # writes the files
node "<skill base dir>/../../bin/harness.mjs" init --packages apps/web,apps/backend   # monorepo: only these packages
```

Replace `<skill base dir>` with that absolute path. Run it from the project root (or any directory inside it).

## Steps

1. **Propose.** Run `init` (dry run). It prints JSON with `stacks`, `packages`, the proposed `config`, `notes` and `changes` (what `--write` would create, update or keep). It looks at the root, its subdirectories, and `apps/*`, `packages/*` and `services/*`. Report to the user:
   - **the detected packages**: each `packages[].path` with its stacks (`.` is the root). A repo with one stack has one package, `.`;
   - each verify command with its `files` filter. In a monorepo a stage can hold several commands, one per package, each with a `cwd`: it runs in that directory, sees only that package's changed files (`{files}`, `{dirs}` and the `files` globs are relative to it), and is skipped when nothing under it changed;
   - the planned changes.

   If there is more than one package, **ask which packages the Stop gate should check**: a package's tests and typecheck run on every stop that touched it, so a slow or flaky package is better left out. Then re-run the dry run with `--packages <comma-separated paths>` for the chosen ones, and use that command (with `--write`) in step 4. If the user wants every package, no `--packages` is needed.

2. **Check that each command runs, once.** For every proposed command (in a monorepo, every command of every chosen package), try it once on one real file of that package:
   - run it in its `cwd` (or the project root without one);
   - replace `{files}` with one matching file, relative to that directory (for example a test file or a source file the filter allows), and `{dirs}` with that file's directory (`./pkg/x`, or `.` for the directory itself);
   - for `format`, append the file path, but **only** if you are fine with that file being reformatted; otherwise run the formatter's check mode (`prettier --check`, `ruff format --check`, `gofmt -l`) instead;
   - run whole-project commands (no placeholder, like `tsc --noEmit`, `cargo check` or `dotnet test`) as written. If one is slow, say how long it took.

   A failure because the tool is missing ("command not found", `npx --no` refusing to download, a missing module, no .NET SDK) is not an error to report and stop on. It is a fix to propose: install the tool as a dev dependency, use another tool the project already has, or drop that stage. A failure that comes from the project's code (real lint errors, failing tests) means the command works; say so and move on.

3. **Ask about the notes.** Go through every entry in `notes` with the user. In particular:
   - no test command (Rust, or no runner found): ask which command to use. Prefer one that takes `{files}` or `{dirs}`. Never add a full-suite command silently: the Stop gate would run it on every stop.
   - .NET: `dotnet test` has no related-test mode, so it runs the whole solution's tests whenever a `.cs`, `.csproj`, `.razor` or props/targets file under the package changed. It is proposed, but only the user can say whether that is affordable; ask, and offer a `--filter` expression or dropping the stage. `dotnet build` and `dotnet format --verify-no-changes` are optional extras that the notes mention and the proposal leaves out.
   - pytest without pytest-testmon, or `node --test`: only changed test files run. Offer pytest-testmon for Python.
   - several stacks: only the first stack's commands are proposed. Ask which stack the gate should check.

4. **Write.** Run `init --write`. It:
   - creates `.harness/config.json`, or keeps an existing one (it says `kept`); pass `--force-config` only if the user agrees to replace it;
   - creates `CLAUDE.md`, or, if it exists, inserts or replaces only the block between `<!-- harness:start -->` and `<!-- harness:end -->` (everything else stays byte for byte);
   - creates `AGENTS.md` as a pointer to `CLAUDE.md`, or merges the same marker block into it;
   - creates `.harness/progress.md` if it is missing.

   In a monorepo, pass the same `--packages` as the dry run. If the user changed commands in steps 2–3, edit `.harness/config.json` after the first `--write` (string, or `{ "run": "...", "files": ["**/*.ts"] }`), then run `init --write` again: it keeps your edited config and refreshes the `CLAUDE.md` block from it. It is safe to re-run; unchanged files say `unchanged`. If it prints `refused`, nothing was written: fix what it names (usually broken markers) and re-run.

5. **Report.** Show the CLI's list of what it created, updated or kept. Remind the user to commit `.harness/config.json`, `CLAUDE.md`, `AGENTS.md` and `.harness/progress.md`. `.harness/state/` ignores itself in git, so it needs nothing.

## Config reference

- `{files}`: the changed files (vs HEAD), shell-quoted and root-relative; `{dirs}`: their unique directories. A stage using either is skipped when nothing matches.
- `files`: globs (`**`, `*`, `?`). Only changed files that match reach the command, and a command with a filter is skipped when none match.
- `cwd`: a directory under the project root. The command runs there and only sees changed files below it, with paths (and `files` globs) relative to it.
- A stage may be an array of commands, run in order; the first failure stops the stage.
- `format` without a placeholder gets the edited file appended.
