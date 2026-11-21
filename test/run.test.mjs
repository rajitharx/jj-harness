import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeProject, makeRepo, writeFile } from "./helpers.mjs";

const RUN = fileURLToPath(new URL("../hooks/run.mjs", import.meta.url));
const exec = (args, stdin) => spawnSync(process.execPath, [RUN, ...args], { input: stdin, encoding: "utf8" });

test("entry point always exits 0 with JSON on stdout", () => {
  const r = exec(["Stop"], JSON.stringify({ cwd: makeProject() }));
  assert.equal(r.status, 0);
  assert.doesNotThrow(() => JSON.parse(r.stdout));
});

test("entry point: SessionStart context and a Stop block from the quality loop", () => {
  const cwd = makeRepo({ verify: { lint: "exit 0", test: "echo checking {files}; exit 1" } });
  writeFile(cwd, "new file.ts", "x\n");
  writeFile(cwd, ".harness/progress.md", "- wired the gate\n");

  const start = exec(["SessionStart"], JSON.stringify({ cwd, session_id: "e2e" }));
  assert.equal(start.status, 0);
  const ctx = JSON.parse(start.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /Dirty files \(2\)/);
  assert.match(ctx, /- wired the gate/);

  const stop = exec(["Stop"], JSON.stringify({ cwd, session_id: "e2e", stop_hook_active: false }));
  assert.equal(stop.status, 0);
  const out = JSON.parse(stop.stdout);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /the test stage failed/);
  assert.match(out.reason, /^checking new file\.ts$/m, "harness files are not passed to {files}");
});

test("entry point survives garbage stdin", () => {
  const r = exec(["PreToolUse"], "not json");
  assert.equal(r.status, 0);
  assert.match(r.stderr, /could not parse hook input/);
  assert.doesNotThrow(() => JSON.parse(r.stdout));
});

test("entry point emits a block reason over 64 KB as complete, parseable JSON", () => {
  // A blockedCommands regex longer than 64 KB makes guard-bash return a reason
  // that large; the harness caps it and stdout must arrive intact.
  const pattern = "danger" + "(?:)".repeat(20_000);
  const cwd = makeProject({ blockedCommands: [pattern] });
  const r = exec(["PreToolUse"], JSON.stringify({ cwd, tool_name: "Bash", tool_input: { command: "danger" } }));
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, "deny");
  assert.ok(out.permissionDecisionReason.endsWith("…[truncated]"));
});
