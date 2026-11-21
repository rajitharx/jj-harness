---
name: harness-init
description: Set up the harness in the current project. Detects the stack, writes .harness/config.json and a project CLAUDE.md/AGENTS.md from templates. Use for 'init harness', 'set up harness', or first run in a new repo.
---

# harness-init

> Sketch — body not implemented yet.

1. Detect stack from manifests (package.json, pyproject.toml, go.mod, Cargo.toml...).
2. Propose verify commands (format, lint, typecheck, test) and confirm they run.
3. Write `.harness/config.json`, `CLAUDE.md` (from templates/CLAUDE.md), `AGENTS.md` symlink/pointer, `.harness/progress.md`.
4. Never overwrite an existing CLAUDE.md; merge a harness section instead.
