// End-to-end: one simulated Claude Code session against a fixture git project.
// Every hook is spawned the way hooks/hooks.json declares it (the same shell
// command, with ${CLAUDE_PLUGIN_ROOT} set), fed realistic hook input JSON, and
// its stdout is compared with the exact JSON shape Claude Code reads. The
// verify commands are small node stubs that log their arguments to a file
// outside the repo, so the test can see what each stage was given.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { git, makeRepo, writeFile } from "./helpers.mjs";

const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOOKS = JSON.parse(readFileSync(join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8")).hooks;

// Each stub appends `<stage> <args as JSON>` to $STUB_LOG. The test stub fails
// when any file it is given contains the word FAIL.
const STUB = (stage, failOn) => `import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.STUB_LOG, ${JSON.stringify(stage)} + " " + JSON.stringify(args) + "\\n");
${failOn ? `const bad = args.filter((f) => readFileSync(f, "utf8").includes("FAIL"));
if (bad.length) { console.log("not ok - " + bad.join(", ") + " is broken"); process.exit(1); }
console.log("ok - " + args.length + " file(s)");` : ""}
`;

const CONFIG = {
  verify: {
    format: "node stubs/format.mjs",
    lint: { run: "node stubs/lint.mjs {files}", files: ["src/**/*.js"] },
    test: { run: "node stubs/test.mjs {files}", files: ["src/**/*.js"] },
  },
  stopGate: { enabled: true, maxAttempts: 2, timeoutSec: 30 },
};

function fixture() {
  const root = makeRepo(CONFIG, {
    "README.md": "# fixture\n",
    "src/a.js": "export const a = 1;\n",
    "src/b.js": "export const b = 2;\n",
    "src/c.js": "export const c = 3;\n",
    "stubs/format.mjs": STUB("format", false),
    "stubs/lint.mjs": STUB("lint", false),
    "stubs/test.mjs": STUB("test", true),
  });
  const log = join(mkdtempSync(join(tmpdir(), "harness-e2e-log-")), "stub.log");
  writeFileSync(log, "");
  return { root, log };
}

/** Stub invocations so far, as [stage, args] pairs. */
function calls(log) {
  return readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf(" ");
      return [line.slice(0, i), JSON.parse(line.slice(i + 1))];
    });
}

/**
 * Fire one hook event the way Claude Code does: pick the hooks.json entry
 * whose matcher accepts the tool, run its command through the shell in the
 * project dir, and parse stdout.
 */
function fire(event, input, { root, log }) {
  const entry = HOOKS[event].find((e) => !e.matcher || new RegExp(`^(?:${e.matcher})$`).test(input.tool_name ?? ""));
  assert.ok(entry, `hooks.json routes ${event}${input.tool_name ? ` for ${input.tool_name}` : ""}`);
  const [hook] = entry.hooks;
  assert.equal(hook.type, "command");
  const payload = {
    session_id: "e2e-session",
    transcript_path: join(root, "..", "transcript.jsonl"),
    cwd: root,
    permission_mode: "default",
    hook_event_name: event,
    ...input,
  };
  const r = spawnSync(hook.command, {
    cwd: root,
    shell: true,
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: (hook.timeout ?? 60) * 1000,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      CLAUDE_PROJECT_DIR: root,
      STUB_LOG: log,
      // `node` in the hook command must be the node running this test.
      PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
    },
  });
  assert.equal(r.status, 0, `${event} exited ${r.status}: ${r.stderr}`);
  return { out: JSON.parse(r.stdout), stderr: r.stderr };
}

const tool = (tool_name, tool_input, extra = {}) => ({ tool_name, tool_input, tool_use_id: "toolu_e2e", ...extra });
const stop = (ctx, stop_hook_active = false) => fire("Stop", { stop_hook_active }, ctx);

test("e2e: one session through SessionStart, guards, format-on-edit and the Stop gate", () => {
  const ctx = fixture();
  const { root, log } = ctx;
  writeFile(root, "docs/notes.md", "draft\n"); // dirty before the session starts

  // 1. SessionStart: branch, dirty files and verify commands as additionalContext.
  {
    const { out } = fire("SessionStart", { source: "startup" }, ctx);
    assert.deepEqual(Object.keys(out), ["hookSpecificOutput"]);
    assert.deepEqual(Object.keys(out.hookSpecificOutput).sort(), ["additionalContext", "hookEventName"]);
    assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
    const ctxText = out.hookSpecificOutput.additionalContext;
    const branch = git(root, "rev-parse", "--abbrev-ref", "HEAD").trim();
    assert.ok(ctxText.split("\n").includes(`Branch: ${branch}`), ctxText);
    assert.match(ctxText, /^Dirty files \(1\): docs\/notes\.md$/m);
    assert.match(ctxText, /^- format: node stubs\/format\.mjs$/m);
    assert.match(ctxText, /^- test: node stubs\/test\.mjs \{files\} \(only for src\/\*\*\/\*\.js\)$/m);
    assert.doesNotMatch(ctxText, /harness-init/, "a configured project is not told to run init");
  }

  // 2. PreToolUse: destructive Bash and a secret write are denied; a normal edit passes.
  {
    const { out } = fire("PreToolUse", tool("Bash", { command: "rm -rf /", description: "clean up" }), ctx);
    assert.deepEqual(Object.keys(out), ["hookSpecificOutput"]);
    assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /^Blocked `rm -rf \/`/);
    assert.deepEqual(Object.keys(out.hookSpecificOutput).sort(), ["hookEventName", "permissionDecision", "permissionDecisionReason"]);
  }
  {
    const { out } = fire("PreToolUse", tool("Write", { file_path: join(root, ".env"), content: "SECRET=1\n" }), ctx);
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /protected path pattern "\.env"/);
  }
  const editA = { file_path: join(root, "src/a.js"), old_string: "export const a = 1;", new_string: "export const a = 'FAIL';" };
  assert.deepEqual(fire("PreToolUse", tool("Edit", editA), ctx).out, {}, "allow is an empty object");
  assert.deepEqual(calls(log), [], "PreToolUse runs no verify command");

  // 3. PostToolUse: Claude Code has applied the edit; the formatter runs on exactly that file.
  writeFile(root, "src/a.js", "export const a = 'FAIL';\n");
  {
    const { out } = fire("PostToolUse", tool("Edit", editA, { tool_response: { filePath: editA.file_path, success: true } }), ctx);
    assert.deepEqual(out, {}, "a passing formatter is silent");
    assert.deepEqual(calls(log), [["format", ["src/a.js"]]]);
  }

  // 4. Stop with a failing related test: block, naming the stage and command;
  //    lint and test got only the changed source file (not docs/notes.md, not b.js/c.js).
  {
    const { out } = stop(ctx);
    assert.deepEqual(Object.keys(out).sort(), ["decision", "reason"]);
    assert.equal(out.decision, "block");
    assert.match(out.reason, /^Verify gate: the test stage failed; it exited with code 1\.$/m);
    assert.match(out.reason, /^Command: node stubs\/test\.mjs src\/a\.js$/m);
    assert.match(out.reason, /not ok - src\/a\.js is broken/);
    assert.match(out.reason, /Attempt 1 of 2/);
    assert.deepEqual(calls(log).slice(1), [
      ["lint", ["src/a.js"]],
      ["test", ["src/a.js"]],
    ]);
  }

  // 5. The agent fixes the file; the continuation Stop passes and tells the
  //    user so (typecheck isn't configured, so it isn't listed). A second Stop
  //    with nothing new changed allows silently without running anything.
  writeFile(root, "src/a.js", "export const a = 10;\n");
  assert.deepEqual(stop(ctx, true).out, { systemMessage: "harness: lint ✓ test ✓ (2 changed files)" });
  const ran = calls(log).length;
  assert.deepEqual(calls(log).slice(-2), [["lint", ["src/a.js"]], ["test", ["src/a.js"]]]);
  assert.deepEqual(stop(ctx).out, {});
  assert.equal(calls(log).length, ran, "unchanged tree since the last pass: no stub ran again");
});

test("e2e: the Stop gate gives up after maxAttempts, then a new turn gets a fresh budget", () => {
  const ctx = fixture();
  writeFile(ctx.root, "src/b.js", "export const b = 'FAIL';\n");

  const first = stop(ctx);
  assert.equal(first.out.decision, "block");
  assert.match(first.out.reason, /Attempt 1 of 2/);
  const second = stop(ctx, true);
  assert.equal(second.out.decision, "block");
  assert.match(second.out.reason, /Attempt 2 of 2/);

  const third = stop(ctx, true);
  assert.deepEqual(
    third.out,
    { systemMessage: "harness: gave up after 2 blocked stops (stopGate.maxAttempts); allowed this stop with checks still failing." },
    "gives up: allow, and the user is told",
  );
  assert.match(third.stderr, /gave up after 2 attempts/);
  assert.equal(calls(ctx.log).filter(([s]) => s === "test").length, 2, "giving up runs nothing");

  const nextTurn = stop(ctx);
  assert.equal(nextTurn.out.decision, "block");
  assert.match(nextTurn.out.reason, /Attempt 1 of 2/);
  assert.deepEqual(calls(ctx.log).at(-1), ["test", ["src/b.js"]]);
});

test("e2e: stop_hook_active with an unreadable attempt counter allows instead of looping", () => {
  const ctx = fixture();
  writeFile(ctx.root, "src/c.js", "export const c = 'FAIL';\n");
  writeFile(ctx.root, ".harness/state/verify-gate.json", "{ not json");

  const continuation = stop(ctx, true);
  assert.deepEqual(Object.keys(continuation.out), ["systemMessage"], "allows, telling only the user");
  assert.match(continuation.out.systemMessage, /^harness: checks not run: the attempt counter .* is unreadable/);
  assert.match(continuation.stderr, /attempt counter is unreadable and this is a continuation/);
  assert.deepEqual(calls(ctx.log), [], "nothing ran");

  // A fresh (non-continuation) Stop still checks, and rewrites the state.
  const fresh = stop(ctx);
  assert.equal(fresh.out.decision, "block");
  assert.deepEqual(calls(ctx.log), [["lint", ["src/c.js"]], ["test", ["src/c.js"]]]);
  assert.equal(JSON.parse(readFileSync(join(ctx.root, ".harness/state/verify-gate.json"), "utf8")).attempts["e2e-session"], 1);
});

test("e2e: a project without .harness/config.json gets guards and an init hint, and the gate stays out of the way", () => {
  const root = makeRepo(undefined, { "src/a.js": "x\n" });
  const ctx = { root, log: join(mkdtempSync(join(tmpdir(), "harness-e2e-log-")), "unused.log") };
  const start = fire("SessionStart", { source: "startup" }, ctx).out.hookSpecificOutput.additionalContext;
  assert.match(start, /No \.harness\/config\.json yet: run \/harness:harness-init/);
  assert.equal(
    fire("PreToolUse", tool("Edit", { file_path: join(root, ".git/config"), old_string: "a", new_string: "b" }), ctx).out
      .hookSpecificOutput.permissionDecision,
    "deny",
  );
  writeFile(root, "src/a.js", "y\n");
  assert.deepEqual(fire("PostToolUse", tool("Write", { file_path: join(root, "src/a.js"), content: "y\n" }), ctx).out, {});
  assert.deepEqual(stop(ctx).out, {});
});
