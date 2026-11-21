# Dogfood report: v0.1.0 (2026-11-21)

Three headless Claude Code sessions with this plugin loaded from a checkout, run against a throwaway fixture repo. The goal was to confirm that a real Claude Code (2.1.330) loads the plugin, fires each hook with the input the policies expect, honours the JSON they return, and exposes the skills and agents under `harness:`.

## Setup

- **Fixture**: a fresh git repo under the system temp dir (`$TMPDIR/harness-dogfood-*/fixture`), outside this repo, with one commit containing `README.md`, `package.json`, `src/a.js`, three stub verify commands and `.harness/config.json`:

  ```json
  {
    "verify": {
      "format": "node stubs/format.mjs",
      "lint": { "run": "node stubs/lint.mjs {files}", "files": ["src/**/*.js"] },
      "test": { "run": "node stubs/test.mjs {files}", "files": ["src/**/*.js"] }
    },
    "stopGate": { "enabled": true, "maxAttempts": 2, "timeoutSec": 30 }
  }
  ```

  Each stub appends `<time> <stage> <args as JSON>` to a `stub.log` next to the fixture (outside the repo, so it never counts as a change). The test stub exits 1 if a file it's given contains `FAIL`. No real tools, no network.
- **Command**, run with cwd = the fixture (`<prompt>` varies; session (c) also passed `--allowedTools "Bash(node *)"` so the `verify` skill could run the CLI):

  ```sh
  claude -p --plugin-dir <this repo> --setting-sources project,local \
    --max-turns 4 --max-budget-usd 1 --permission-mode acceptEdits \
    --no-session-persistence --output-format stream-json --verbose \
    --include-hook-events --debug-file ../debug-<x>.log "<prompt>"
  ```

  `--include-hook-events` (with `stream-json`) puts every hook's stdout, stderr and exit code in the stream, which is the evidence quoted below. `--setting-sources project,local` keeps the user's own plugins and hooks out. `acceptEdits` lets edits through without prompts while Bash stays denied unless allowed.

## Results

| # | Prompt | Hooks that fired | Result | Cost |
| - | ------ | ---------------- | ------ | ---- |
| a | `Write the text hello to a file named .env` | SessionStart, PreToolUse:Write, Stop | ✅ denied, no file written | $0.063 |
| b | `Create src/b.js exporting 1` | SessionStart, PreToolUse:Write, PostToolUse:Write, Stop | ✅ formatted and gated on `src/b.js` only | $0.056 |
| c | `/harness:verify` (with `src/c.js` containing `FAIL` left in the tree) | SessionStart, PreToolUse:Bash ×2, Stop (block), PreToolUse:Edit, PostToolUse:Edit | ✅ skill ran the CLI; the gate blocked live and the agent fixed the file | $0.078 |

### Plugin loading

The debug log shows `--plugin-dir … is one plugin: .claude-plugin at its top marks it`, `Read hooks.json for plugin harness (enabled=true)` and `Loading hooks from plugin: harness`. The stream's `init` message lists the plugin as `{"name":"harness","source":"harness@inline","version":"0.1.0"}`, the skills and slash commands `harness:handoff`, `harness:harness-init`, `harness:plan`, `harness:review`, `harness:ship`, `harness:verify`, and the agents `harness:reviewer`, `harness:test-writer`. `claude --plugin-dir . plugin details harness` reports 6 skills, 2 agents, 4 hooks and about 835 always-on tokens.

### (a) guard-paths

SessionStart returned the context block:

```json
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"## Harness session context\nBranch: main\nWorking tree: clean\nVerify commands (`{files}`/`{dirs}` = only the changed files or their directories are checked):\n- format: node stubs/format.mjs\n- lint: node stubs/lint.mjs {files} (only for src/**/*.js)\n- test: node stubs/test.mjs {files} (only for src/**/*.js)\nlint, typecheck and test re-run before you can stop if files changed."}}
```

The model called `Write {"file_path":".../fixture/.env","content":"hello\n"}`. PreToolUse:Write returned `permissionDecision: "deny"` with the reason `Blocked Write on …/fixture/.env: it matches the protected path pattern ".env" (config.protectedPaths). …`. Claude Code turned that into an error tool result (`PreToolUse:Write hook error: Blocked Write on …`), and the model reported the block, said it hadn't tried to get around it through Bash, and suggested the user create the file. No `.env` exists afterwards. Stop returned `{}` (nothing changed).

**Issue found and fixed**: the model also told the user to "remove `.env` from `protectedPaths` in `.harness/config.json`". That can't work, because project entries only add to the built-in list. The deny reason now ends with "(A project's .harness/config.json can add protected paths but can't remove the built-in ones: .env files, keys and .git.)", and `test/guard-paths.test.mjs` asserts it for every blocked path.

### (b) format-on-edit and the Stop gate

The model wrote `src/b.js` (`export default 1;`). PreToolUse:Write → `{}`, PostToolUse:Write → `{}`, Stop → `{}`. `stub.log`:

```
2026-11-21T10:03:59.336Z format ["src/b.js"]
2026-11-21T10:04:00.531Z lint ["src/b.js"]
2026-11-21T10:04:00.619Z test ["src/b.js"]
```

The formatter got exactly the edited file, and the gate's lint and test got only `src/b.js` (not `src/a.js` or the stubs). `.harness/state/verify-gate.json` holds the fingerprint of the passing tree and no attempts.

**Observation**: the model's final message said "I haven't run the lint or test checks on it". A passing gate is silent: Stop has no context channel, so neither the model nor the user sees that the checks ran and passed. Not a bug; recorded as a follow-up.

### (c) `/harness:verify` and a live Stop block

`src/c.js` (`export const c = "FAIL";`) was added to the tree before the session, so SessionStart reported `Dirty files (2): src/b.js, src/c.js`. The skill loaded from its base directory and the model ran:

```
node "<this repo>/skills/verify/../../bin/harness.mjs" verify
```

The output, quoted exactly by the model as the skill requires:

```
verify: 2 changed files in …/fixture
ok       lint: node stubs/lint.mjs src/b.js src/c.js
skipped  typecheck (no command configured)
FAILED   test: node stubs/test.mjs src/b.js src/c.js (exit 1)
not ok - src/c.js
verify: failed (test)
```

Following the skill, it didn't fix anything and offered to. Then the Stop hook returned:

```json
{"decision":"block","reason":"Verify gate: the test stage failed; it exited with code 1.\nCommand: node stubs/test.mjs src/b.js src/c.js\nOutput (last 8 KB):\nnot ok - src/c.js\n\nFix the failure, then finish again: the gate will re-run lint, typecheck and test on the changed files. (Attempt 1 of 2.)"}
```

Claude Code fed it back as `Stop hook feedback: …` and the session continued (it also emitted a `stop-hook-error` notification, "stop hook problem", which is how it labels any blocking Stop). The model read `src/c.js` and the stub, changed `"FAIL"` to `"PASS"` with Edit (PreToolUse:Edit `{}`, PostToolUse:Edit `{}`, `format ["src/c.js"]` in the log), re-ran `verify` and got `verify: passed`. Then the session hit `--max-turns 4` (`error_max_turns`) before its final Stop, so the post-fix "allow" wasn't observed live. `test/e2e.test.mjs` covers that step.

## Not exercised live

- Destructive Bash (`rm -rf /` and the rest): deliberately left to `test/e2e.test.mjs` and `test/guard-bash.test.mjs`, never sent to a live session.
- The `maxAttempts` give-up and the `stop_hook_active` continuation: covered by `test/e2e.test.mjs`.
- The `harness:reviewer` and `harness:test-writer` agents were loaded (listed in `init.agents`) but not invoked, to stay within three sessions. `/harness:review`, `/harness:ship`, `/harness:plan`, `/harness:handoff` and `/harness:harness-init` were listed but not run.
- Installing from the marketplace (`/plugin marketplace add rajitharx/jj-harness`): not run here. It needs git credentials for the private repo.

## Validation

`claude plugin validate .` (2.1.330), before → after this step:

| Check | Before | After |
| ----- | ------ | ----- |
| marketplace.json | ⚠ no marketplace description | ✔ passes `--strict` (`metadata.description` added; the `harness` entry now has `version`) |
| plugin | ⚠ `CLAUDE.md` at the plugin root isn't loaded as context | ⚠ same, accepted: it's this repo's development guide |
| hosts | "Hosts not declared: list what these parts reach under `network.hosts`" | cleared with `"network": { "hosts": [] }` (the plugin makes no network calls) |
| plugin-directory checks (informational) | ⚠ `ICON_MISSING` | ⚠ same, accepted: the plugin isn't submitted to the public directory |

Result: `✔ Validation passed with warnings`, exit 0, no errors. `claude plugin validate` also runs with an empty `HOME` and no credentials (`npm install @anthropic-ai/claude-code` into a temp prefix, then `env -i … claude plugin validate .`), so CI runs it.
