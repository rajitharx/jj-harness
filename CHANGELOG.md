# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The per-step details, verification and known gaps are in the [completion log](docs/ROADMAP.md#completion-log).

## [Unreleased]

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
- The marketplace manifest has a description and a `version` on the `harness` entry, and `plugin.json` declares that the plugin reaches no network hosts, which clears the `claude plugin validate` warnings for both manifests.

[Unreleased]: https://github.com/rajitharx/jj-harness/compare/harness--v0.1.0...HEAD
[0.1.0]: https://github.com/rajitharx/jj-harness/releases/tag/harness--v0.1.0
