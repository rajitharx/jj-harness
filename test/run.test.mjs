import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeProject } from "./helpers.mjs";

const RUN = fileURLToPath(new URL("../hooks/run.mjs", import.meta.url));
const exec = (args, stdin) => spawnSync(process.execPath, [RUN, ...args], { input: stdin, encoding: "utf8" });

test("entry point always exits 0 with JSON on stdout", () => {
  const r = exec(["Stop"], JSON.stringify({ cwd: makeProject() }));
  assert.equal(r.status, 0);
  assert.doesNotThrow(() => JSON.parse(r.stdout));
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
