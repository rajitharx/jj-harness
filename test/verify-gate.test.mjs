import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../lib/config.mjs";
import { verifyGate } from "../hooks/policies/verify-gate.mjs";
import { git, makeProject, makeRepo, writeFile } from "./helpers.mjs";

const PASS = "exit 0";
const FAIL = "echo first line; echo 'boom: expected 1 to equal 2' >&2; exit 1";

/** A command that appends one byte to a counter file outside the repo, then exits with `code`. */
function counter(code = 0) {
  const file = join(mkdtempSync(join(tmpdir(), "harness-count-")), "count");
  writeFileSync(file, "");
  return {
    cmd: `printf x >> '${file}'; exit ${code}`,
    runs: () => readFileSync(file, "utf8").length,
  };
}

/** Run the gate with a captured log. */
async function stop(root, { session = "s1", stop_hook_active = false, deadlineMs } = {}) {
  const logs = [];
  const verdict = await verifyGate({ session_id: session, stop_hook_active, cwd: root }, loadConfig(root), {
    log: (m) => logs.push(m),
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  });
  return { verdict, logs };
}

const repo = (verify, stopGate) => makeRepo({ verify, ...(stopGate ? { stopGate } : {}) }, {
  "README.md": "hello\n",
  "src/a.ts": "export const a = 1;\n",
});
const touch = (root, path = "src/a.ts", content = `// ${Math.random()}\n`) => writeFile(root, path, content);

test("allows without running anything when the tree matches HEAD", async () => {
  const c = counter(1);
  const root = repo({ test: c.cmd });
  assert.deepEqual((await stop(root)).verdict, { kind: "allow" });
  assert.equal(c.runs(), 0);
});

test("allows when disabled or when no gate commands are configured", async () => {
  const c = counter(1);
  const cases = [
    ["disabled", repo({ test: c.cmd }, { enabled: false })],
    ["no commands", repo({})],
    ["only format", repo({ format: c.cmd })],
  ];
  for (const [name, root] of cases) {
    touch(root);
    assert.deepEqual((await stop(root)).verdict, { kind: "allow" }, name);
  }
  assert.equal(c.runs(), 0);
});

test("a failing stage blocks with the stage, command and output tail, and stops there", async () => {
  const later = counter(0);
  const root = repo({ lint: FAIL, test: later.cmd });
  touch(root);
  const { verdict } = await stop(root);
  assert.equal(verdict.kind, "block");
  assert.match(verdict.reason, /the lint stage failed; it exited with code 1/);
  assert.ok(verdict.reason.includes(`Command: ${FAIL}`), verdict.reason);
  assert.match(verdict.reason, /boom: expected 1 to equal 2/);
  assert.match(verdict.reason, /gate will re-run/);
  assert.match(verdict.reason, /Attempt 1 of 3/);
  assert.equal(later.runs(), 0, "test stage did not run after lint failed");
});

test("runs lint, typecheck, test in order", async () => {
  const lint = counter(0);
  const root = repo({ test: FAIL, typecheck: `node -e "process.exit(2)"`, lint: lint.cmd });
  touch(root);
  const { verdict } = await stop(root);
  assert.equal(lint.runs(), 1);
  assert.match(verdict.reason, /the typecheck stage failed; it exited with code 2/);
});

test("output tail is capped at about 8 KB and keeps the end", async () => {
  const root = repo({ test: `node -e "console.log('BEGIN'.toLowerCase() + 'x'.repeat(50000) + 'THE-END'); process.exitCode = 1"` });
  touch(root);
  const { verdict } = await stop(root);
  assert.ok(verdict.reason.includes("THE-END"));
  assert.ok(!verdict.reason.includes("begin"), "start of the output is cut");
  assert.ok(verdict.reason.length < 9 * 1024, `reason length ${verdict.reason.length}`);
});

test("a pass saves the fingerprint; the next stop allows without re-running", async () => {
  const c = counter(0);
  const root = repo({ test: c.cmd });
  touch(root);
  assert.deepEqual((await stop(root)).verdict, { kind: "allow" });
  assert.equal(c.runs(), 1);
  assert.deepEqual((await stop(root)).verdict, { kind: "allow" });
  assert.deepEqual((await stop(root, { session: "other" })).verdict, { kind: "allow" });
  assert.equal(c.runs(), 1, "not re-run while the tree is unchanged");

  const state = JSON.parse(readFileSync(join(root, ".harness/state/verify-gate.json"), "utf8"));
  assert.match(state.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(readFileSync(join(root, ".harness/state/.gitignore"), "utf8"), "*\n");
  assert.ok(!git(root, "status", "--porcelain", "--untracked-files=all").includes(".harness/state"), "state is ignored");
});

test("a change after a pass re-runs the checks", async () => {
  const c = counter(0);
  const root = repo({ test: c.cmd });
  touch(root, "src/a.ts", "one\n");
  await stop(root);
  assert.equal(c.runs(), 1);
  const cases = [
    ["edit an already-changed file", () => touch(root, "src/a.ts", "one two\n")],
    ["add an untracked file", () => touch(root, "src/b.ts", "b\n")],
    ["delete a tracked file", () => rmSync(join(root, "README.md"))],
  ];
  let expected = 1;
  for (const [name, change] of cases) {
    change();
    await stop(root);
    assert.equal(c.runs(), ++expected, name);
    await stop(root);
    assert.equal(c.runs(), expected, `${name}: then stable`);
  }
});

test("a changed verify command invalidates the fingerprint", async () => {
  const c = counter(0);
  // Ignore the config, so editing it does not count as a tree change by itself.
  const root = makeRepo({ verify: { test: c.cmd } }, { ".gitignore": ".harness/config.json\n", "a.ts": "a\n" });
  touch(root, "a.ts");
  await stop(root);
  await stop(root);
  assert.equal(c.runs(), 1);
  writeFile(root, ".harness/config.json", JSON.stringify({ verify: { test: c.cmd, lint: PASS } }));
  await stop(root);
  assert.equal(c.runs(), 2);
});

test("gives up after maxAttempts consecutive blocks, then resets for the next turn", async () => {
  const root = repo({ test: FAIL }, { maxAttempts: 2 });
  touch(root);
  const seq = [];
  for (let i = 0; i < 4; i++) {
    const { verdict, logs } = await stop(root, { stop_hook_active: i > 0 });
    seq.push(verdict.kind);
    if (i === 2) assert.match(logs.join("\n"), /gave up after 2 attempts/);
  }
  assert.deepEqual(seq, ["block", "block", "allow", "block"]);
});

test("stop_hook_active alone does not bypass the gate", async () => {
  const root = repo({ test: FAIL });
  touch(root);
  assert.equal((await stop(root, { stop_hook_active: true })).verdict.kind, "block");
});

test("attempts are counted per session", async () => {
  const root = repo({ test: FAIL }, { maxAttempts: 1 });
  touch(root);
  assert.equal((await stop(root, { session: "A" })).verdict.kind, "block");
  assert.equal((await stop(root, { session: "A" })).verdict.kind, "allow", "A gave up");
  assert.equal((await stop(root, { session: "B" })).verdict.kind, "block", "B has its own budget");
});

test("a pass resets the session's attempt count", async () => {
  const root = repo({ test: `node -e "process.exit(require('fs').existsSync('fixed') ? 0 : 1)"` }, { maxAttempts: 2 });
  touch(root);
  assert.equal((await stop(root)).verdict.kind, "block");
  touch(root, "fixed", "");
  assert.equal((await stop(root)).verdict.kind, "allow");
  rmSync(join(root, "fixed"));
  assert.equal((await stop(root)).verdict.kind, "block");
  assert.equal((await stop(root)).verdict.kind, "block", "count restarted from 0 after the pass");
});

test("{files} receives only changed, non-deleted files, root-relative", async () => {
  const out = join(mkdtempSync(join(tmpdir(), "harness-argv-")), "argv.json");
  const script = `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)))`;
  const root = makeRepo(
    { verify: { test: "node argv.cjs {files}" } },
    { "argv.cjs": script, "a.ts": "a\n", "c.ts": "c\n", "e.ts": "e\n", "keep.ts": "k\n" },
  );
  touch(root, "a.ts", "a2\n");
  touch(root, "b.ts", "new\n");
  git(root, "mv", "c.ts", "d.ts");
  rmSync(join(root, "e.ts"));
  touch(root, "dir/f g's.ts", "untracked\n");
  touch(root, ".harness/progress.md", "- harness files are not source\n");
  assert.deepEqual((await stop(root)).verdict, { kind: "allow" });
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), ["a.ts", "b.ts", "d.ts", "dir/f g's.ts"]);
});

test("a {files} stage is skipped when only deletions changed; whole-project stages still run", async () => {
  const typecheck = counter(0);
  const root = repo({ lint: `${FAIL} {files}`, typecheck: typecheck.cmd });
  rmSync(join(root, "src/a.ts"));
  assert.deepEqual((await stop(root)).verdict, { kind: "allow" });
  assert.equal(typecheck.runs(), 1);
});

test("file filters: a docs-only change skips filtered stages and never reaches strict tools", async () => {
  const lint = counter(1);
  const typecheck = counter(1);
  const root = repo({
    lint: { run: `${lint.cmd} {files}`, files: ["**/*.ts"] },
    typecheck: { run: typecheck.cmd, files: ["**/*.ts"] },
  });
  touch(root, "README.md", "docs only\n");
  assert.deepEqual((await stop(root)).verdict, { kind: "allow" });
  assert.equal(lint.runs() + typecheck.runs(), 0);
  touch(root, "src/a.ts");
  assert.equal((await stop(root)).verdict.kind, "block", "a matching change runs the filtered stage");
  assert.equal(lint.runs(), 1);
});

test("a stage that runs past stopGate.timeoutSec fails as timed out", async () => {
  const root = repo({ test: `node -e "setTimeout(() => {}, 30000)"` }, { timeoutSec: 1 });
  touch(root);
  const { verdict } = await stop(root);
  assert.equal(verdict.kind, "block");
  assert.match(verdict.reason, /the test stage failed; it timed out after 1s/);
});

test("fails open when the project is not a git repo", async () => {
  const root = makeProject({ verify: { test: FAIL } });
  const { verdict, logs } = await stop(root);
  assert.deepEqual(verdict, { kind: "allow" });
  assert.match(logs.join("\n"), /could not list changed files/);
});

test("a corrupt state file is treated as empty", async () => {
  const root = repo({ test: FAIL });
  touch(root);
  writeFile(root, ".harness/state/verify-gate.json", "{ not json");
  writeFile(root, ".harness/state/.gitignore", "*\n");
  assert.equal((await stop(root)).verdict.kind, "block");
  assert.ok(existsSync(join(root, ".harness/state/verify-gate.json")));
});

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

test("stays bounded when the state can't be saved: allows instead of blocking forever", async () => {
  const cases = [
    ["read-only .harness", (root) => chmodSync(join(root, ".harness"), 0o555), isRoot],
    ["a directory at the state file", (root) => mkdirSync(join(root, ".harness/state/verify-gate.json"), { recursive: true }), false],
  ];
  for (const [name, breakState, skip] of cases) {
    if (skip) continue; // root ignores file permissions
    const root = repo({ test: FAIL });
    touch(root);
    breakState(root);
    try {
      const kinds = [];
      const logs = [];
      for (let i = 0; i < 5; i++) {
        const r = await stop(root, { stop_hook_active: i > 0 });
        kinds.push(r.verdict.kind);
        logs.push(...r.logs);
      }
      assert.deepEqual(kinds, Array(5).fill("allow"), name);
      assert.match(logs.join("\n"), /could not save state|counter/, name);
    } finally {
      chmodSync(join(root, ".harness"), 0o755);
    }
  }
});

test("backstop: an unreadable counter on a continuation allows without running", async () => {
  const c = counter(1);
  const root = repo({ test: c.cmd });
  touch(root);
  mkdirSync(join(root, ".harness/state/verify-gate.json"), { recursive: true });
  const { verdict, logs } = await stop(root, { stop_hook_active: true });
  assert.deepEqual(verdict, { kind: "allow" });
  assert.equal(c.runs(), 0);
  assert.match(logs.join("\n"), /unreadable/);
});

test("writes .harness/state/.gitignore even when the directory already exists", async () => {
  const root = repo({ test: PASS });
  mkdirSync(join(root, ".harness/state"));
  writeFile(root, ".harness/state/notes.txt", "x");
  touch(root);
  await stop(root);
  assert.equal(readFileSync(join(root, ".harness/state/.gitignore"), "utf8"), "*\n");
  assert.ok(!git(root, "status", "--porcelain", "--untracked-files=all").includes(".harness/state"));
});

test("an overall deadline caps the stages and allows once it passes", async () => {
  const later = counter(1);
  const root = repo({ lint: `node -e "setTimeout(() => {}, 30000)"`, test: later.cmd });
  touch(root);
  const started = Date.now();
  const { verdict, logs } = await stop(root, { deadlineMs: 500 });
  assert.deepEqual(verdict, { kind: "allow" });
  assert.ok(Date.now() - started < 5000, "lint was cut at the deadline, not at timeoutSec");
  assert.match(logs.join("\n"), /ran out of time/);
  assert.equal(later.runs(), 0);

  const none = await stop(root, { deadlineMs: 0 });
  assert.deepEqual(none.verdict, { kind: "allow" });
  assert.equal(later.runs(), 0, "no stage starts after the deadline");
});
