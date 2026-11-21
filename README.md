# jj-harness

A reusable agent harness for Claude Code, shipped as a plugin. Install it once and every project gets:

- **Guardrails**: blocks destructive shell commands and edits to secrets, keys and `.git/`.
- **Verification loop**: formats each edited file, and runs lint, typecheck and the tests related to the changed files before the agent can stop.
- **Session memory**: injects the branch, dirty files, verify commands and the last progress note at session start.
- **Workflow skills**: `harness-init`, `plan`, `verify`, `review`, `ship`, `handoff`.
- **Agents**: `reviewer` (read-only, verified findings only) and `test-writer` (tests in the project's style, related tests only).

Version 0.1.1. See [`CHANGELOG.md`](CHANGELOG.md), the per-step log in [`docs/ROADMAP.md`](docs/ROADMAP.md) and the design in [`docs/design/rationale.md`](docs/design/rationale.md). Needs Node ≥22 on `PATH`; there are no dependencies to install.

## Quickstart

From the marketplace:

```sh
/plugin marketplace add rajitharx/jj-harness
/plugin install harness@jj-harness
```

The repository is private, so Claude Code clones it with your normal git credentials: an SSH key loaded in `ssh-agent`, or for HTTPS, `gh auth login` plus `gh auth setup-git` (or another credential helper that doesn't prompt). A `GITHUB_TOKEN` in the environment isn't enough on its own; it only works through a credential helper. For `owner/repo` sources, Claude Code probes `ssh -T git@github.com` and clones over SSH when that works. When the probe or the SSH clone fails, adding the marketplace falls back to HTTPS, and so does `claude plugin install` from a shell. Installs from `/plugin` inside a session and plugin updates don't fall back, so on a machine with no GitHub SSH key, set `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1`. It skips the probe and always clones over HTTPS.

Background auto-update is off by default for this marketplace. Turn it on under `/plugin` → **Marketplaces** → `jj-harness`. It uses the same credentials and never prompts. Without it, update by hand: `/plugin marketplace update jj-harness` in a session, or `claude plugin marketplace update jj-harness` and then `claude plugin update harness@jj-harness` in a shell (restart Claude Code to apply).

Or run it straight from a checkout, without installing:

```sh
git clone git@github.com:rajitharx/jj-harness.git
claude --plugin-dir ./jj-harness
```

A plugin installed in the middle of a session isn't loaded until you run `/reload-plugins` (or restart Claude Code). Until then `/harness:harness-init` fails with just `Unknown skill: harness:harness-init`.

Then, once per project:

```
/harness:harness-init
```

`harness-init` detects the stacks (Node with npm/pnpm/yarn/bun, Python with uv/poetry/pip, Go, Rust, .NET) and proposes verify commands that check only the changed files. It looks at the root, at its subdirectories, and one level deeper in `apps/`, `packages/` and `services/`, so a monorepo with no root manifest works: each package gets its own commands, run in its own directory. It lists the packages it found, asks which ones the Stop gate should check, tries each command once, asks about anything it can't decide (Rust has no related-test mode, and `dotnet test` runs the whole suite, for example), and then writes:

- `.harness/config.json`, the only file the harness reads per project. An existing one is kept unless you agree to replace it.
- `CLAUDE.md` and `AGENTS.md`. If they exist, only the block between `<!-- harness:start -->` and `<!-- harness:end -->` is inserted or updated.
- `.harness/progress.md`, for the `handoff` skill's notes.

Commit those four files. Without a config the guards still run with their defaults, the Stop gate has nothing to run, and the session context suggests `/harness:harness-init`.

## Config reference

`.harness/config.json`. Every key is optional. `lib/config.mjs` owns the schema and rejects unknown keys; if the file is invalid, the harness logs why and runs with the defaults, which keeps secret protection on.

| Key | Type | Default | Meaning |
| --- | ---- | ------- | ------- |
| `verify.format` | command or array | none | Runs after each Edit/Write/MultiEdit on the edited file. Without a placeholder, the path is appended. Never blocks; a failure is shown to the agent. |
| `verify.lint` | command or array | none | Stop gate stage 1. |
| `verify.typecheck` | command or array | none | Stop gate stage 2. |
| `verify.test` | command or array | none | Stop gate stage 3. |
| `protectedPaths` | globs | see below | Paths the agent may not Edit, Write, MultiEdit or NotebookEdit. Your entries **add to** the defaults; they can't remove them. |
| `blockedCommands` | regexes | `[]` | Extra Bash commands to deny, on top of the built-in rules. |
| `stopGate.enabled` | boolean | `true` | Turn the Stop gate off. |
| `stopGate.maxAttempts` | integer ≥1 | `3` | Blocks in a row before the gate gives up for the turn. |
| `stopGate.timeoutSec` | integer ≥1 | `300` | Time limit for each gate stage. |
| `formatTimeoutSec` | integer ≥1 | `30` | Time limit for `verify.format`. |

A command is a string, or `{ "run": "<command>", "files": ["<glob>", …], "cwd": "<directory>" }`. An empty string means "not configured". A stage may also be an array of commands (one per package in a monorepo), run in order; the first failure stops the stage, and the stage's time limit covers the whole array. The defaults, as `lib/config.mjs` resolves them (a test keeps this block in sync):

<!-- config-defaults -->
```json
{
  "verify": {},
  "protectedPaths": [".env", ".env.*", "**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/id_rsa*", "**/id_ed25519*", ".git/**"],
  "blockedCommands": [],
  "stopGate": { "enabled": true, "maxAttempts": 3, "timeoutSec": 300 },
  "formatTimeoutSec": 30
}
```

A TypeScript project's config might look like this:

```json
{
  "verify": {
    "format": "npx --no -- prettier --write --ignore-unknown",
    "lint": { "run": "npx --no -- eslint --no-warn-ignored {files}", "files": ["**/*.ts", "**/*.tsx"] },
    "typecheck": { "run": "npx --no -- tsc --noEmit", "files": ["**/*.ts", "**/*.tsx", "**/tsconfig*.json"] },
    "test": { "run": "npx --no -- vitest related --run --passWithNoTests {files}", "files": ["**/*.ts", "**/*.tsx"] }
  },
  "protectedPaths": ["secrets/**"],
  "blockedCommands": ["terraform destroy"]
}
```

A monorepo's config, as `harness-init` writes it for a Vite app plus a .NET backend:

```json
{
  "verify": {
    "typecheck": { "run": "npx --no -- tsc --noEmit", "files": ["**/*.ts", "**/*.tsx", "**/tsconfig*.json"], "cwd": "apps/web" },
    "test": [
      { "run": "npx --no -- vitest related --run --passWithNoTests {files}", "files": ["**/*.ts", "**/*.tsx"], "cwd": "apps/web" },
      { "run": "dotnet test", "files": ["**/*.cs", "**/*.csproj"], "cwd": "apps/backend" }
    ]
  }
}
```

## Related tests only

The Stop gate checks what changed, never the whole suite:

- **`{files}`** is replaced with the shell-quoted, root-relative paths of the files that differ from `HEAD`: modified, added, renamed and untracked. Deleted files and `.harness/` are left out. Use it for related-test and per-file lint commands, such as `vitest related --run {files}` or `jest --findRelatedTests {files}`.
- **`{dirs}`** is replaced with the unique directories of those files (`.` or `./pkg/x`), for per-package tools such as `go test {dirs}`.
- **`files`** narrows the changed files to the matching globs (`**`, `*`, `?`) before substitution. If none match, the stage is skipped, so a docs-only change never reaches eslint or pytest. A command with a filter but no placeholder (like `tsc --noEmit` above) runs only when a matching file changed.
- **`cwd`** (a directory inside the project, no `..`) makes a command a package's own: it runs in that directory and only sees changed files below it. `{files}`, `{dirs}` and the `files` globs are then relative to it (`**/*.ts` means the package's TypeScript), and the stage is skipped when nothing under it changed, even for a command like `dotnet test` that takes no placeholder.
- A command with neither runs as written. That suits `typecheck`, which needs the whole project.
- A path starting with `-` is passed as `./-name`, so it can't be read as an option.

How much "related" means depends on the tool: `vitest related` and `jest --findRelatedTests` follow imports, while `pytest` without testmon or `node --test` only run the changed test files.

## Hooks

All four events go through one entry point, `hooks/run.mjs <Event>`. It always exits 0 and answers in JSON. A policy that crashes is logged to stderr and treated as "allow". Status lines meant for you rather than the agent go in the hook's `systemMessage`; in headless `stream-json` output they arrive as `informational` messages such as `Stop says: harness: …`.

| Event | Policy | What it does |
| ----- | ------ | ------------ |
| SessionStart | `session-context` | Adds the branch, dirty files, verify commands and the tail of `.harness/progress.md` (about 2 KB) as context. |
| PreToolUse (Bash) | `guard-bash` | Denies `rm -rf` on `/`, `~`, `.` and similar; force-push to or deletion of `main`/`master`; downloads piped into a shell; `DROP`/`TRUNCATE` sent to a database client; `mkfs`, `dd of=/dev/…`, `chmod -R /`, fork bombs; and your `blockedCommands`. The reason names a safer alternative. |
| PreToolUse (Edit, Write, MultiEdit, NotebookEdit) | `guard-paths` | Denies edits matching `protectedPaths`, including `**/` patterns outside the project such as `~/.ssh/id_ed25519`. |
| PostToolUse (Edit, Write, MultiEdit) | `format-on-edit` | Runs `verify.format` on the edited file. Silent on success. |
| Stop | `verify-gate` | If the tree differs from `HEAD`, runs lint, typecheck and test in order. The first failure blocks the stop with the command and its output tail. A pass shows you a line such as `harness: lint ✓ (1 file) typecheck ✓ test skipped`, where a count is the files the stage's command was given after its `files` filter and a whole-project stage has none,, or `no checks ran` when every stage was skipped. A passing tree is fingerprinted, so stopping again with no new changes runs nothing and shows nothing. When the gate allows a stop without a pass (it gave up, ran out of time, or couldn't save its state), it shows you why. After `maxAttempts` blocks the gate gives up for that turn. The whole run has an 840 s budget, below the hook's 900 s timeout. State lives in `.harness/state/`, which ignores itself in git. |

## Skills and agents

Plugin skills and agents are named `harness:<name>`.

| Skill | Use it to |
| ----- | --------- |
| `/harness:harness-init` | Detect the stack and write the config, `CLAUDE.md`/`AGENTS.md` block and progress file. |
| `/harness:plan` | Write a checkable plan to `.harness/plans/` before changing code. |
| `/harness:verify` | Run lint, typecheck and test on the changed files and quote the result. `--base <ref>` adds the branch's committed changes. |
| `/harness:review` | Send the diff to `harness:reviewer`, re-check its findings and report them by severity. |
| `/harness:ship` | Refuse on `main`/`master`, verify, commit without protected files, push and open a PR with `gh pr create`. |
| `/harness:handoff` | Append a dated progress note to `.harness/progress.md` for the next session. |

- **`harness:reviewer`** reviews a diff or a branch against a base ref for correctness, security, concurrency, error handling, test gaps and the project's rules. It checks each finding against the code (CONFIRMED if reproduced, PLAUSIBLE if reasoned) and ends with `Verdict: approve | request changes`. Its tools are `Read, Grep, Glob, Bash`, with no editing tools.
- **`harness:test-writer`** writes tests in the project's style, changes only tests and fixtures, runs only the related tests, and reports real bugs instead of fixing production code.

Use them through `/harness:review` (and the test-writer offers in `review`, `ship` and `plan`), or directly: `@agent-harness:reviewer review my branch against main`.

The skills call the plugin's CLI, which you can run yourself: `node <plugin>/bin/harness.mjs init` (a dry run that prints JSON), `init --write [--force-config] [--packages <paths>]` (`--packages apps/web,apps/backend` keeps only those packages of a monorepo) and `verify [--all | --base <ref>]`. `verify` exits 0 on `verify: passed` and also on `verify: nothing ran` (no check executed, which is not a pass), 1 when a check fails and 2 on a usage, config or git error.

## Known limitations

The full lists are the "Known gaps" of each step in [`docs/ROADMAP.md`](docs/ROADMAP.md#completion-log). The main ones:

- The guards are pattern matching, not a sandbox. Variables, aliases, encoded commands, scripts written to a file and then run, and `echo '…' | bash` get past `guard-bash`.
- "Changed files" means everything uncommitted, including work from before the session, so the gate can block on someone else's in-progress change. Work committed mid-turn isn't checked by the gate.
- Related-test quality depends on the tool (see above). Rust has no related-test mode, so `harness-init` proposes no test command for it.
- `harness-init` reads the project root only. In a monorepo it proposes one stack's commands.
- `.env.example` is protected by the defaults, and a project can't unprotect it.
- Agent and skill behaviour can only be checked by use; the tests cover their structure. The reviewer's read-only rule is enforced by its tool list plus instructions (Bash can still write).
- Quoting is POSIX-shell. Windows is untested.

## Development

```sh
npm test                 # node --test, stdlib only
claude --plugin-dir .    # try the plugin locally
claude plugin validate . # official manifest, skill, agent and hook checks
```

`test/e2e.test.mjs` replays a whole session through `hooks/run.mjs` against a fixture repo. `docs/dogfood-v0.1.0.md` records a live headless run. The repo's own workflow (branch, PR, separate reviewer, squash-merge) is in [`CLAUDE.md`](CLAUDE.md).

### Release checklist

1. Bump `version` in `.claude-plugin/plugin.json` and `package.json` together. The marketplace entry deliberately has no `version` (Claude Code would silently prefer `plugin.json`'s). `test/release.test.mjs` fails if the two differ, if the marketplace entry sets one, or if `CHANGELOG.md` has no entry for the version. Users get only commits that bump the version.
2. Add the `CHANGELOG.md` entry and tick the step in `docs/ROADMAP.md`.
3. `npm test` and `claude plugin validate .` pass. CI runs both, on Node 22 and 24, on Ubuntu and macOS. The one expected warning is that the root `CLAUDE.md` isn't loaded as plugin context; it's this repo's development guide, not plugin content.
4. Merge the release PR to `main`, then from an up-to-date `main`:

   ```sh
   claude plugin tag . --dry-run   # prints the tag: harness--v<version>
   claude plugin tag . --push      # creates and pushes it
   gh release create harness--v<version> --verify-tag --title "harness v<version>" --notes-file <changelog excerpt>
   ```

   `claude plugin tag` takes the version from `plugin.json`. It compares it with the marketplace entry's version only when the entry sets one, and ours deliberately doesn't, so `test/release.test.mjs` is what keeps `plugin.json` and `package.json` in step. It refuses a dirty working tree or a tag that already exists (unless `--force`), then creates the `{name}--v{version}` tag (`harness--v0.1.1`).
5. Users with auto-update on get it in the background. Others run `/plugin marketplace update jj-harness`, or `claude plugin marketplace update jj-harness` and then `claude plugin update harness@jj-harness` (see [Quickstart](#quickstart)).
