# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The per-step details, verification and known gaps are in the [completion log](docs/ROADMAP.md#completion-log).

## [Unreleased]

## [0.1.1] - 2026-11-21

### Fixed

- **A passing Stop gate was silent.** In the v0.1.0 dogfood run the agent told the user it hadn't run the checks, though the gate had run and passed. The agent's last message is written before Stop fires, so the gate now tells the user directly: a pass shows `harness: lint ✓ typecheck skipped test ✓ (2 changed files)`, and a run where every stage was skipped shows `harness: no checks ran (…)`, never a pass. A Stop with no new changes since the last pass stays silent.
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

[Unreleased]: https://github.com/rajitharx/jj-harness/compare/harness--v0.1.1...HEAD
[0.1.1]: https://github.com/rajitharx/jj-harness/compare/harness--v0.1.0...harness--v0.1.1
[0.1.0]: https://github.com/rajitharx/jj-harness/releases/tag/harness--v0.1.0
