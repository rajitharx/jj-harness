# jj-harness

A reusable agent harness for Claude Code, shipped as a plugin. Install it once and every project gets:

- **Guardrails**: blocks destructive shell commands and edits to secrets, keys and `.git/`.
- **Verification loop**: runs format on every edit, and runs lint, typecheck and test before the agent can stop.
- **Session memory**: injects branch, dirty files and the last progress note at session start.
- **Workflow skills**: `harness-init`, `plan`, `verify`, `review`, `ship`, `handoff`.
- **Agents**: `reviewer` (read-only), `test-writer`.

> Status: **in progress**. Progress and a per-step completion log are in [`docs/ROADMAP.md`](docs/ROADMAP.md); the design is in [`docs/design/rationale.md`](docs/design/rationale.md).

## Install

```sh
/plugin marketplace add rajitharx/jj-harness
/plugin install harness@jj-harness
```

Then, in any project:

```
/harness:harness-init
```

That writes `.harness/config.json`, which is the only file the harness reads per project:

```json
{
  "verify": { "format": "npx prettier -w", "lint": "npm run lint", "typecheck": "npx tsc --noEmit", "test": "npm test" },
  "protectedPaths": ["secrets/**"],
  "blockedCommands": ["terraform destroy"],
  "stopGate": { "enabled": true, "maxAttempts": 3 }
}
```

## Develop

```sh
npm test
claude --plugin-dir .   # try the plugin locally
```
