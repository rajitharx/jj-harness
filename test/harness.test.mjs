import { test } from "node:test";
import assert from "node:assert/strict";
import { runHook } from "../lib/harness.mjs";
import { makeProject } from "./helpers.mjs";

const allow = () => ({ kind: "allow" });
const block = (reason) => () => ({ kind: "block", reason });
const ctx = (text) => () => ({ kind: "context", text });
const run = (event, list, { cwd = makeProject(), logs = [] } = {}) =>
  runHook(event, { cwd }, { policies: { [event]: list }, log: (m) => logs.push(m) });

test("all-allow produces empty output", async () => {
  for (const e of ["PreToolUse", "PostToolUse", "Stop", "SessionStart"]) {
    assert.deepEqual(await run(e, [allow, allow]), { exitCode: 0, output: {} });
  }
});

test("PreToolUse: any block denies, reasons joined", async () => {
  const r = await run("PreToolUse", [allow, block("no rm"), block("no .env")]);
  assert.deepEqual(r.output, {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no rm\nno .env" },
  });
});

test("PostToolUse: block and context both surface", async () => {
  const r = await run("PostToolUse", [block("formatter failed"), ctx("formatted a.js")]);
  assert.deepEqual(r.output, {
    decision: "block",
    reason: "formatter failed",
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "formatted a.js" },
  });
});

test("Stop: block carries reason, context is dropped", async () => {
  assert.deepEqual((await run("Stop", [block("tests failed")])).output, { decision: "block", reason: "tests failed" });
  assert.deepEqual((await run("Stop", [ctx("ignored")])).output, {});
});

test("SessionStart: contexts concatenated in policy order", async () => {
  const r = await run("SessionStart", [ctx("branch: main"), ctx("2 dirty files")]);
  assert.deepEqual(r.output, {
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "branch: main\n\n2 dirty files" },
  });
});

test("policies receive input and resolved config", async () => {
  const cwd = makeProject({ verify: { test: "npm test" } });
  let seen;
  await runHook("Stop", { cwd, stop_hook_active: false }, {
    policies: { Stop: [(input, config) => ((seen = { input, config }), { kind: "allow" })] },
  });
  assert.equal(seen.input.stop_hook_active, false);
  assert.equal(seen.config.verify.test, "npm test");
});

test("fail open: throwing policy is logged and treated as allow", async () => {
  const logs = [];
  const boom = () => { throw new Error("kaboom"); };
  const r = await run("PreToolUse", [boom], { logs });
  assert.deepEqual(r.output, {});
  assert.match(logs[0], /boom failed on PreToolUse: kaboom/);
});

test("fail open: invalid verdict shape is logged and treated as allow", async () => {
  const logs = [];
  const r = await run("PreToolUse", [() => ({ kind: "block" })], { logs });
  assert.deepEqual(r.output, {});
  assert.match(logs[0], /invalid verdict/);
});

test("invalid config falls back to defaults and still runs policies", async () => {
  const logs = [];
  let config;
  await run("Stop", [(_, c) => ((config = c), { kind: "allow" })], { cwd: makeProject("{ broken"), logs });
  assert.match(logs[0], /invalid JSON.*falling back to defaults/);
  assert.ok(config.protectedPaths.includes(".env"));
});

test("unknown event is ignored", async () => {
  const logs = [];
  const r = await runHook("Nope", {}, { policies: {}, log: (m) => logs.push(m) });
  assert.deepEqual(r, { exitCode: 0, output: {} });
  assert.match(logs[0], /unknown hook event/);
});
