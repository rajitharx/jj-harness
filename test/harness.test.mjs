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

test("PreToolUse: context only is passed through as additionalContext", async () => {
  const r = await run("PreToolUse", [allow, ctx("note: lockfile changed")]);
  assert.deepEqual(r.output, {
    hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "note: lockfile changed" },
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

test("SessionStart: a block is shown as context, ahead of other context", async () => {
  const r = await run("SessionStart", [ctx("branch: main"), block("config invalid")]);
  assert.deepEqual(r.output, {
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "config invalid\n\nbranch: main" },
  });
});

test("long reasons and context are capped at 16 KB with a marker", async () => {
  const big = "x".repeat(70 * 1024);
  const pre = (await run("PreToolUse", [block(big)])).output.hookSpecificOutput.permissionDecisionReason;
  assert.equal(pre.length, 16 * 1024);
  assert.ok(pre.endsWith("…[truncated]"));
  const post = (await run("PostToolUse", [ctx(big)])).output.hookSpecificOutput.additionalContext;
  assert.ok(post.length <= 16 * 1024 && post.endsWith("…[truncated]"));
  const session = (await run("SessionStart", [ctx(big)])).output.hookSpecificOutput.additionalContext;
  assert.ok(session.length <= 16 * 1024 && session.endsWith("…[truncated]"));
  assert.equal((await run("Stop", [block("short")])).output.reason, "short", "short text is untouched");
});

test("policies receive input and resolved config", async () => {
  const cwd = makeProject({ verify: { test: "npm test" } });
  let seen;
  await runHook("Stop", { cwd, stop_hook_active: false }, {
    policies: { Stop: [(input, config) => ((seen = { input, config }), { kind: "allow" })] },
  });
  assert.equal(seen.input.stop_hook_active, false);
  assert.deepEqual(seen.config.verify.test, { run: "npm test" });
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

test("fail open: block with an empty or whitespace reason is an invalid verdict", async () => {
  for (const reason of ["", "   \n"]) {
    const logs = [];
    const r = await run("PreToolUse", [block(reason)], { logs });
    assert.deepEqual(r.output, {});
    assert.match(logs[0], /invalid verdict/);
  }
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
