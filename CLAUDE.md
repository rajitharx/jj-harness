# jj-harness

A reusable Claude Code agent harness, shipped as a plugin. The design is in `docs/design/rationale.md`; the plan and progress are in `docs/ROADMAP.md`.

## Commands

- Test: `npm test` (Node ≥20, stdlib only, no dependencies)
- Try the plugin locally: `claude --plugin-dir .`

## Code rules

- Zero runtime dependencies. Use only the Node standard library.
- `runHook` in `lib/harness.mjs` is the runtime's only public entry point. Policies return a `Verdict` and never write hook JSON themselves.
- `hooks/policies/index.mjs` is the one list of policies per event. `hooks/hooks.json` must name the same events, and `test/registry.test.mjs` enforces this.
- `lib/config.mjs` is the only module that knows the config path, schema and defaults.
- Fail open: a policy bug must never block a session.
- Every policy gets table-driven tests in `test/`.

## Task workflow

Each roadmap step (or any other task) goes through these stages:

1. **Branch**: create `rajiatha/<step-slug>` from an up-to-date `main`. Never commit to `main` directly.
2. **Implement**: one agent makes the change, following the sketch in the rationale and the step's checklist in `docs/ROADMAP.md`. If the work departs from the sketch, record why.
3. **Document**: in the same branch, tick the step's checklist items, set its status in the table, and add a completion-log entry (what shipped, how it was verified, changes from the sketch, known gaps). Update the rationale's "Next implementation step".
4. **Verify**: `npm test` must pass. Report failures with their output; never claim a pass you didn't see.
5. **Commit**: use conventional commits (`feat(scope): …`, `fix: …`, `docs: …`) and end each message with the Co-Authored-By trailer.
6. **PR**: push and open a PR to `main` with `gh pr create`. The body has a summary, the checklist items it completes, test results, and changes from the sketch.
7. **Review and merge**: a *separate* reviewer agent (not the one that implemented the change) reviews the PR diff for correctness, security, test gaps and the code rules above. It then:
   - if blocking issues remain: leaves review comments, and the implementer fixes them and pushes, then the reviewer reviews again;
   - if the PR is clean: checks out the PR branch and runs `npm test`, then squash-merges with `gh pr merge --squash --delete-branch`.
8. **Sync**: pull `main` before starting the next task.

Merge open PRs before starting new work.
