import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runHook } from "../lib/harness.mjs";
import { readMetrics } from "../lib/metrics.mjs";
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

test("long reasons and context are capped under Claude Code's 10,000-character hook-string limit, with a marker", async () => {
  const big = "x".repeat(70 * 1024);
  const pre = (await run("PreToolUse", [block(big)])).output.hookSpecificOutput.permissionDecisionReason;
  assert.equal(pre.length, 9500);
  assert.ok(pre.endsWith("…[truncated]"));
  const post = (await run("PostToolUse", [ctx(big)])).output.hookSpecificOutput.additionalContext;
  assert.ok(post.length <= 9500 && post.endsWith("…[truncated]"));
  const session = (await run("SessionStart", [ctx(big)])).output.hookSpecificOutput.additionalContext;
  assert.ok(session.length <= 9500 && session.endsWith("…[truncated]"));
  assert.equal((await run("Stop", [block("short")])).output.reason, "short", "short text is untouched");
  const justUnder = "y".repeat(9500);
  assert.equal((await run("Stop", [block(justUnder)])).output.reason, justUnder, "text at the limit is untouched");
});

const note = (text) => () => ({ kind: "notice", text });

test("notice: top-level systemMessage on every event, next to any block or context", async () => {
  const cases = [
    ["PreToolUse", [note("n")], { systemMessage: "n" }],
    ["PostToolUse", [note("n")], { systemMessage: "n" }],
    ["Stop", [note("harness: test ✓")], { systemMessage: "harness: test ✓" }],
    ["SessionStart", [note("n")], { systemMessage: "n" }],
    [
      "PreToolUse",
      [block("no rm"), note("n")],
      {
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no rm" },
        systemMessage: "n",
      },
    ],
    [
      "PreToolUse",
      [ctx("c"), note("n")],
      { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "c" }, systemMessage: "n" },
    ],
    [
      "PostToolUse",
      [block("b"), ctx("c"), note("n")],
      { decision: "block", reason: "b", hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "c" }, systemMessage: "n" },
    ],
    ["Stop", [block("tests failed"), note("n")], { decision: "block", reason: "tests failed", systemMessage: "n" }],
    ["Stop", [ctx("dropped"), note("n")], { systemMessage: "n" }],
    [
      "SessionStart",
      [ctx("branch: main"), note("n")],
      { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "branch: main" }, systemMessage: "n" },
    ],
  ];
  for (const [event, list, expected] of cases) {
    assert.deepEqual((await run(event, list)).output, expected, `${event}: ${JSON.stringify(expected)}`);
  }
});

test("notice: several are joined one per line in policy order, trimmed, and never reach the agent", async () => {
  const r = await run("Stop", [note("  first\n"), allow, note("second")]);
  assert.deepEqual(r.output, { systemMessage: "first\nsecond" });
  const pre = await run("PreToolUse", [note("for the user"), ctx("for the agent")]);
  assert.equal(pre.output.hookSpecificOutput.additionalContext, "for the agent");
});

test("notice: capped at 1000 characters with a marker", async () => {
  const msg = (await run("Stop", [note("y".repeat(5000))])).output.systemMessage;
  assert.equal(msg.length, 1000);
  assert.ok(msg.endsWith("…[truncated]"));
  const joined = (await run("PostToolUse", [note("a".repeat(600)), note("b".repeat(600))])).output.systemMessage;
  assert.equal(joined.length, 1000, "the cap applies to the joined text");
  assert.equal((await run("Stop", [note("short")])).output.systemMessage, "short");
});

test("fail open: a notice with empty, blank or non-string text is an invalid verdict", async () => {
  for (const verdict of [{ kind: "notice", text: "" }, { kind: "notice", text: " \n " }, { kind: "notice" }, { kind: "notice", text: 1 }]) {
    const logs = [];
    const r = await run("Stop", [() => verdict, note("other policy")], { logs });
    assert.deepEqual(r.output, { systemMessage: "other policy" }, JSON.stringify(verdict));
    assert.match(logs[0], /invalid verdict/);
  }
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

// ---------------------------------------------------------------- metrics

// runHook names a policy's metrics after its function: guardBash -> guard-bash.
const guardBash = () => ({ kind: "block", reason: "no rm", metrics: { verdict: "deny", rule: "rm-rf-dangerous" } });
const sessionContext = () => ({ kind: "context", text: "ctx", metrics: {} });
const logFile = (root) => join(root, ".harness", "state", "metrics.jsonl");

test("metrics: a verdict's metrics are recorded with the event, the policy id and the session", async () => {
  const cwd = makeProject();
  await runHook("PreToolUse", { cwd, session_id: "s1" }, { policies: { PreToolUse: [guardBash, allow] }, log: () => {} });
  await runHook("SessionStart", { cwd }, { policies: { SessionStart: [sessionContext] }, log: () => {} });
  assert.deepEqual(readMetrics(cwd).map(({ ts, ...e }) => e), [
    { v: 1, session: "s1", event: "PreToolUse", policy: "guard-bash", verdict: "deny", rule: "rm-rf-dangerous" },
    { v: 1, session: null, event: "SessionStart", policy: "session-context" },
  ]);
});

test("metrics: a verdict without metrics records nothing, and a malformed metrics value is ignored", async () => {
  const cases = { none: allow, string: () => ({ kind: "allow", metrics: "x" }), array: () => ({ kind: "allow", metrics: [1] }), null: () => ({ kind: "allow", metrics: null }) };
  for (const [name, policy] of Object.entries(cases)) {
    const cwd = makeProject();
    const r = await run("PreToolUse", [policy], { cwd });
    assert.deepEqual(r, { exitCode: 0, output: {} }, name);
    assert.deepEqual(readMetrics(cwd), [], name);
  }
});

test("metrics: a failing log changes no hook output, and logs one stderr line per failure", async () => {
  const list = { PreToolUse: [guardBash, allow], SessionStart: [sessionContext] };
  const outputs = async (cwd, logs) => [
    await runHook("PreToolUse", { cwd, session_id: "s" }, { policies: list, log: (m) => logs.push(m) }),
    await runHook("SessionStart", { cwd }, { policies: list, log: (m) => logs.push(m) }),
  ];
  const healthy = await outputs(makeProject(), []);

  const broken = makeProject();
  mkdirSync(logFile(broken), { recursive: true }); // appends fail with EISDIR
  const logs = [];
  assert.deepEqual(await outputs(broken, logs), healthy);
  assert.equal(logs.length, 2);
  assert.ok(logs.every((m) => /^metrics: could not record/.test(m)), logs.join("\n"));

  const blocked = makeProject();
  mkdirSync(join(blocked, ".harness"));
  writeFileSync(join(blocked, ".harness", "state"), "a file where the directory should be");
  assert.deepEqual(await outputs(blocked, []), healthy);
});

test("metrics: a throwing recorder path never turns a verdict into an allow", async () => {
  // A hostile `metrics` object whose getters throw must not change the block.
  const hostile = () => ({ kind: "block", reason: "no", metrics: new Proxy({}, { ownKeys() { throw new Error("boom"); }, get() { throw new Error("boom"); } }) });
  const logs = [];
  const r = await run("PreToolUse", [hostile], { logs });
  assert.equal(r.output.hookSpecificOutput.permissionDecision, "deny");
});
