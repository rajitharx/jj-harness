# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The per-step details, verification and known gaps are in the [completion log](docs/ROADMAP.md#completion-log).

## [Unreleased]

### Added

- **`harness-init` warns about a second JavaScript test runner.** When a `test` or `test:*` script starts a runner other than the one in the proposed command (say `node --test` beside `jest`), a note names it and suggests running the script, since the proposed command can pass without running those tests. The proposal is unchanged.
- **`harness-init` warns about .NET tests that need Docker.** When a test project that `dotnet test` would run (listed in the solution, or the lone project) references a Testcontainers package, a note names it, says the gate would block while Docker is down, and offers the test projects without that reference. The proposed command is unchanged.

## [0.3.0] - 2026-11-24

### Added

- **`harness stats`** reports what the harness did in a session: **verification coverage** (the share of changed files that at least one lint, typecheck or test stage ran on, a lower bound), the stage results, gate stops, blocks and final outcome, the failures it caught (blocks followed by a pass, by stage), formatter results and guard denies. `stats [--session <id> | --last | --since <7d|24h|date>] [--json]` exits 0 (also for `stats: no data`) or 2; `/harness:stats` runs it and quotes it. There is deliberately no single effectiveness percentage, and problems found after the gate passed (CI, review, reverts) aren't measured.
- **Metrics log.** Hooks record counts and outcomes to `.harness/state/metrics.jsonl` (local, self-ignoring, trimmed to its newest half at 1 MiB). It never holds command text, output, file contents, environment values or paths. A failure to record can't change a hook's output.
- `guard-bash` rules have stable ids (`force-push-main`, …), used by the log.
- **`allowPaths`** exempts exact paths from `protectedPaths`, e.g. `"allowPaths": [".env.example"]`, so a template env file can be edited while `.env` stays protected. The built-in patterns still can't be removed.

### Fixed

- **The README's known-limitations line about monorepos was stale.** It said `harness-init` reads only the project root; since 0.2.0 it finds packages. Found while dogfooding 0.2.0 on a real monorepo, where `init` detected .NET and three packages as documented.
- **A script piped or here-stringed into a shell is now checked.** `echo 'rm -rf /' | bash`, `printf … | sudo bash` and `bash <<< 'rm -rf /'` were allowed; the text is now parsed as a command of its own. The text is also followed through `cat`/`tee` stages, and `bash -s`, `-o pipefail` and the like are understood, and `printf` formats are filled in. A shell given a script file, `-c` or `-n` doesn't read stdin, so those stay allowed.
- **Nested `.git` directories are protected.** `**/.git/**` joins the defaults, so submodules and vendored repos' `.git` internals can't be edited.
- **Hook text over 10,000 characters reached the model only as a preview.** Claude Code replaces longer `additionalContext` and `systemMessage` strings with a file path and a 2,000-character preview. `runHook` capped at 16 KB, so context between 10,000 characters and 16 KB was silently cut that way. Reasons and context are now capped at 9,500 characters, with the `…[truncated]` marker.

## [0.2.0] - 2026-11-21

### Added

- **`harness-init` finds packages in monorepos.** Running it in a repo with no root manifest used to print `stacks: []`. It now also looks in the root's subdirectories and in `apps/*`, `packages/*` and `services/*`, and proposes each package's commands, run in its own directory. The dry-run JSON has a new `packages` list, and `init --packages a,b` keeps only the named ones. A repo with one stack at the root gets the same proposal as before: a nested project of the root's own stack (`e2e/`, `fuzz/`, the projects of a root solution) is left out with a note, because the root's commands already see its files.
- **.NET.** A `*.sln`, `*.slnx` or `*.csproj` gives `dotnet test` (filtered to `.cs`, `.razor`, `.cshtml`, `.csproj`, `.props` and `.targets`). It has no related-test mode, so a note says it runs the whole suite on a matching change and asks the user to confirm it. `dotnet build` and `dotnet format` are mentioned as optional and not proposed.
- **Config: `cwd` and arrays.** A verify entry may have `"cwd": "apps/web"`: the command runs there, sees only that package's changed files, `{files}`, `{dirs}` and the `files` globs are relative to it, and it is skipped when nothing under it changed. A stage may be an array of entries, run in order until one fails, under one time limit. Single-command configs are unchanged. Why a schema change and not a generated shell loop is in `docs/design/rationale.md`.
- The `init --write` output and the README quickstart say that a plugin installed mid-session needs `/reload-plugins` (or a restart); until then `/harness:harness-init` fails with `Unknown skill`.

### Changed

- `harness-init`'s steps: it reports the detected packages, asks which ones the Stop gate should check, checks every command once in its own directory, and asks about the .NET full-suite note.
- A failing or passing check in a package shows where it ran: `Command: (in apps/web) npx …` in the gate's block message, in `verify`'s output and in the formatter's failure context. Session context and the generated `CLAUDE.md` block list every command with its directory.

## [0.1.1] - 2026-11-21

### Fixed

- **A passing Stop gate was silent.** In the v0.1.0 dogfood run the agent told the user it hadn't run the checks, though the gate had run and passed. The agent's last message is written before Stop fires, so the gate now tells the user directly: a pass shows `harness: lint ✓ (1 file) typecheck ✓ test skipped`. The count is what that stage's command was given after its `files` filter, and a whole-project stage has none, and a run where every stage was skipped shows `harness: no checks ran (…)`, never a pass. A Stop with no new changes since the last pass stays silent.
- The gate also tells the user when it allows a stop without a pass: it gave up after `stopGate.maxAttempts`, ran out of its overall time budget, couldn't save its attempt counter, or found the counter unreadable on a continuation. These went only to stderr before.
- README: the release checklist said `claude plugin tag` checks that `plugin.json` and the marketplace entry agree. It compares them only when the entry sets a version, and ours doesn't. The checklist now says what it does check.
- README: the `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` note overstated it. Adding an `owner/repo` marketplace already falls back to HTTPS when SSH fails; the variable is for `/plugin` installs and plugin updates, which don't fall back.
- `docs/ROADMAP.md`: the step 6 checklist said all three manifests carry the version. `plugin.json` and `package.json` do; the marketplace entry has none.

### Changed

- Policies can return a fourth verdict, `{ kind: "notice", text }`. `runHook` puts notices in the top-level `systemMessage` (shown to the user, not the model) on every event, joined one per line, capped at 1,000 characters, alongside any block or context. An empty notice is an invalid verdict and fails open.

## [0.1.0] - 2026-11-21

First release. Steps 0 to 6 of the roadmap.

### Added

- **Plugin layout** (step 0): plugin manifest and marketplace entry in `.claude-plugin/`, one hook entry point (`hooks/run.mjs`), one policy registry (`hooks/policies/index.mjs`), CI, MIT license, the design rationale and the repo's `CLAUDE.md` workflow.
- **Core runtime** (step 1): `lib/config.mjs` finds the project root, validates `.harness/config.json` and merges it over frozen defaults. `runHook` in `lib/harness.mjs` runs each event's policies, fails open on crashes and bad verdicts, and turns verdicts into Claude Code's hook JSON. `hooks/run.mjs` always exits 0, survives bad stdin and caps its output at 16 KB per field.
- **Guardrails** (step 2): `guard-bash` denies `rm -rf` on dangerous targets, force-pushes to or deletion of `main`/`master`, downloads piped or substituted into a shell, `DROP`/`TRUNCATE` sent to database clients, `mkfs`, `dd` to devices, `chmod -R /`, fork bombs and project `blockedCommands`, using a quote-, heredoc- and substitution-aware parser. `guard-paths` denies edits to `protectedPaths` (`.env*`, keys, `.git/**` plus project entries), including `**/` patterns outside the project.
- **Quality loop** (step 3): `format-on-edit` runs `verify.format` on each edited file; `verify-gate` runs lint, typecheck and test on Stop and blocks on the first failure, with a fingerprint so an unchanged tree isn't re-checked, a per-session `maxAttempts` budget, per-stage timeouts and an 840 s overall deadline. `session-context` injects the branch, dirty files, verify commands and the tail of `.harness/progress.md`. Commands check only the related files through `{files}` and `{dirs}`.
- **Workflow skills** (step 4): `harness-init`, `plan`, `verify`, `review`, `ship` and `handoff`; per-command `files` glob filters; stack detection (`lib/detect.mjs`) for Node, Python, Go and Rust; and the `bin/harness.mjs` CLI (`init [--write] [--force-config]`, `verify [--all]`).
- **Agents** (step 5): `harness:reviewer` (read-only tools, verified CONFIRMED/PLAUSIBLE findings, a verdict) and `harness:test-writer` (project-style tests, related tests only, tests and fixtures only). `verify --base <ref>` checks a committed branch.
- **Dogfood and release** (step 6): `test/e2e.test.mjs` replays a whole session through `hooks/run.mjs` exactly as `hooks/hooks.json` invokes it; a live headless dogfood run (`docs/dogfood-v0.1.0.md`); `claude plugin validate` in CI; CI on Node 22 and 24 on Ubuntu and macOS; `test/release.test.mjs` keeps the three version fields, this changelog and the README config reference in sync; README rewrite with a config reference, hook table and release checklist.

### Changed

- `guard-paths` deny reasons now say that a project config can add protected paths but can't remove the built-in ones. In the dogfood run the agent told the user to remove `.env` from `protectedPaths`, which has no effect.
- The marketplace manifest has a description, and `plugin.json` declares that the plugin reaches no network hosts, which clears the `claude plugin validate` warnings for both manifests. The version lives only in `plugin.json` (and `package.json`), not in the marketplace entry.
- The README's private-repo install notes: they now cover git credentials (an SSH agent key, or `gh auth setup-git`), `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1`, auto-update being off by default, and the manual update commands.

[Unreleased]: https://github.com/rajitharx/jj-harness/compare/harness--v0.3.0...HEAD
[0.3.0]: https://github.com/rajitharx/jj-harness/compare/harness--v0.2.0...harness--v0.3.0
[0.2.0]: https://github.com/rajitharx/jj-harness/compare/harness--v0.1.1...harness--v0.2.0
[0.1.1]: https://github.com/rajitharx/jj-harness/compare/harness--v0.1.0...harness--v0.1.1
[0.1.0]: https://github.com/rajitharx/jj-harness/releases/tag/harness--v0.1.0
