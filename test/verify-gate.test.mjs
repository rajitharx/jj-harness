import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../lib/config.mjs";
import { verifyGate } from "../hooks/policies/verify-gate.mjs";
import { bare, git, makeProject, makeRepo, writeFile } from "./helpers.mjs";

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
  return { verdict: bare(verdict), metrics: verdict.metrics, logs };
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

test("a pass tells the user which checks ran, which were skipped, and how many files each got", async () => {
  const ts = (run) => ({ run, files: ["**/*.ts"] });
  const PASS_FILES = "true {files}";
  const PASS_DIRS = "true {dirs}";
  const cases = [
    {
      name: "every stage ran: a whole-project stage has no count",
      verify: { lint: PASS_FILES, typecheck: PASS, test: PASS_FILES },
      change: (root) => (touch(root), touch(root, "README.md")),
      text: "harness: lint ✓ (2 files) typecheck ✓ test ✓ (2 files)",
    },
    {
      name: "a filter drops files: each stage shows what it received, not what changed",
      verify: { lint: ts(PASS_FILES), test: ts(PASS_FILES) },
      change: (root) => (touch(root), touch(root, "README.md"), touch(root, "docs/x.md")),
      text: "harness: lint ✓ (1 file) test ✓ (1 file)",
    },
    {
      name: "a filtered whole-project stage that ran has no count",
      verify: { lint: ts(PASS_FILES), typecheck: ts(PASS) },
      change: (root) => (touch(root), touch(root, "README.md")),
      text: "harness: lint ✓ (1 file) typecheck ✓",
    },
    {
      name: "a {dirs} stage counts the files its directories came from",
      verify: { lint: PASS_DIRS },
      change: (root) => (touch(root), touch(root, "src/b.ts"), touch(root, "README.md")),
      text: "harness: lint ✓ (3 files)",
    },
    {
      name: "a filtered stage is listed as skipped",
      verify: { lint: ts(PASS_FILES), test: PASS },
      change: (root) => touch(root, "README.md"),
      text: "harness: lint skipped test ✓",
    },
    {
      name: "only configured stages are listed",
      verify: { test: PASS_FILES },
      change: (root) => touch(root),
      text: "harness: test ✓ (1 file)",
    },
    {
      name: "nothing ran is never a pass",
      verify: { lint: ts(PASS_FILES), test: ts(PASS) },
      change: (root) => touch(root, "README.md"),
      text: "harness: no checks ran (lint skipped test skipped)",
    },
    {
      name: "only deletions: {files} stages skip, whole-project stages run",
      verify: { lint: PASS_FILES, typecheck: PASS },
      change: (root) => rmSync(join(root, "src/a.ts")),
      text: "harness: lint skipped typecheck ✓",
    },
  ];
  for (const { name, verify, change, text } of cases) {
    const root = repo(verify);
    change(root);
    assert.deepEqual((await stop(root)).verdict, { kind: "notice", text }, name);
  }
});

test("a pass saves the fingerprint; the next stop allows silently without re-running", async () => {
  const c = counter(0);
  const root = repo({ test: c.cmd });
  touch(root);
  assert.deepEqual((await stop(root)).verdict, { kind: "notice", text: "harness: test ✓" });
  assert.equal(c.runs(), 1);
  assert.deepEqual((await stop(root)).verdict, { kind: "allow" }, "no repeated notice on an unchanged tree");
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
    if (i === 2) {
      assert.match(logs.join("\n"), /gave up after 2 attempts/);
      assert.equal(
        verdict.text,
        "harness: gave up after 2 blocked stops (stopGate.maxAttempts); allowed this stop with checks still failing.",
      );
    }
  }
  assert.deepEqual(seq, ["block", "block", "notice", "block"]);
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
  assert.equal((await stop(root, { session: "A" })).verdict.kind, "notice", "A gave up");
  assert.equal((await stop(root, { session: "B" })).verdict.kind, "block", "B has its own budget");
});

test("a pass resets the session's attempt count", async () => {
  const root = repo({ test: `node -e "process.exit(require('fs').existsSync('fixed') ? 0 : 1)"` }, { maxAttempts: 2 });
  touch(root);
  assert.equal((await stop(root)).verdict.kind, "block");
  touch(root, "fixed", "");
  assert.equal((await stop(root)).verdict.kind, "notice", "passed");
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
  assert.deepEqual((await stop(root)).verdict, { kind: "notice", text: "harness: test ✓ (4 files)" });
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), ["a.ts", "b.ts", "d.ts", "dir/f g's.ts"]);
});

test("a {files} stage is skipped when only deletions changed; whole-project stages still run", async () => {
  const typecheck = counter(0);
  const root = repo({ lint: `${FAIL} {files}`, typecheck: typecheck.cmd });
  rmSync(join(root, "src/a.ts"));
  assert.equal((await stop(root)).verdict.kind, "notice");
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
  assert.deepEqual((await stop(root)).verdict, {
    kind: "notice",
    text: "harness: no checks ran (lint skipped typecheck skipped)",
  });
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
      const texts = [];
      for (let i = 0; i < 5; i++) {
        const r = await stop(root, { stop_hook_active: i > 0 });
        kinds.push(r.verdict.kind);
        texts.push(r.verdict.text);
        logs.push(...r.logs);
      }
      assert.deepEqual(kinds, Array(5).fill("notice"), name);
      assert.match(logs.join("\n"), /could not save state|counter/, name);
      assert.match(
        texts[0],
        /^harness: the test check failed, but the attempt counter in \.harness\/state could not be saved, so the gate allowed this stop/,
        name,
      );
      for (const t of texts) assert.match(t, /allowed this stop/, name);
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
  assert.deepEqual(verdict, {
    kind: "notice",
    text: "harness: checks not run: the attempt counter in .harness/state/verify-gate.json is unreadable, so the gate allowed this stop.",
  });
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

test("an overall deadline caps the stages and allows with a notice once it passes", async () => {
  const later = counter(1);
  const root = repo({ lint: `node -e "setTimeout(() => {}, 30000)"`, test: later.cmd });
  touch(root);
  const started = Date.now();
  const { verdict, logs } = await stop(root, { deadlineMs: 500 });
  assert.deepEqual(verdict, {
    kind: "notice",
    text: "harness: ran out of time at the lint check; allowed this stop with the remaining checks unfinished.",
  });
  assert.ok(Date.now() - started < 5000, "lint was cut at the deadline, not at timeoutSec");
  assert.match(logs.join("\n"), /ran out of time/);
  assert.equal(later.runs(), 0);

  const none = await stop(root, { deadlineMs: 0 });
  assert.equal(none.verdict.kind, "notice");
  assert.match(none.verdict.text, /ran out of time at the lint check/);
  assert.equal(later.runs(), 0, "no stage starts after the deadline");
});

test("a deadline notice names the checks that passed before it", async () => {
  const root = repo({ lint: PASS, test: `node -e "setTimeout(() => {}, 30000)"` });
  touch(root);
  const { verdict } = await stop(root, { deadlineMs: 1500 });
  assert.deepEqual(verdict, {
    kind: "notice",
    text: "harness: ran out of time at the test check after lint ✓; allowed this stop with the remaining checks unfinished.",
  });
});

test("silent where nothing was looked at: no changes, disabled, nothing configured, not a git repo", async () => {
  const cases = [
    ["clean tree", repo({ test: PASS })],
    ["disabled", (() => { const r = repo({ test: PASS }, { enabled: false }); touch(r); return r; })()],
    ["nothing configured", (() => { const r = repo({}); touch(r); return r; })()],
    ["not a git repo", makeProject({ verify: { test: PASS } })],
  ];
  for (const [name, root] of cases) assert.deepEqual((await stop(root)).verdict, { kind: "allow" }, name);
});

// ---------------------------------------------------------------- metrics

/** The gate's metrics with the timings dropped (ms is checked separately). */
const shape = ({ metrics }) => ({
  outcome: metrics.outcome,
  attempt: metrics.attempt,
  changedFiles: metrics.changedFiles,
  stages: metrics.stages.map(({ name, configured, ran, result, filesChecked }) => [name, configured, ran, result, filesChecked]),
});

test("metrics: every outcome records the stages, the files each checked and the attempt", async () => {
  const slow = `node -e "setTimeout(() => {}, 30000)"`;
  const never = { run: "exit 0 # {files}", files: ["**/*.py"] };
  const cases = [
    {
      name: "pass: whole-project commands count every changed file",
      root: () => repo({ lint: PASS, test: PASS }),
      expected: { outcome: "pass", attempt: 1, changedFiles: 1, stages: [["lint", true, true, "pass", 1], ["typecheck", false, false, "skipped", 0], ["test", true, true, "pass", 1]] },
    },
    {
      name: "pass: a stage with a files filter counts only the files it was given",
      root: () => {
        const r = repo({ lint: { run: "exit 0 # {files}", files: ["src/**/*.ts"] }, test: PASS });
        writeFile(r, "README.md", "changed\n");
        return r;
      },
      expected: { outcome: "pass", attempt: 1, changedFiles: 2, stages: [["lint", true, true, "pass", 1], ["typecheck", false, false, "skipped", 0], ["test", true, true, "pass", 2]] },
    },
    {
      name: "pass: a whole-project command with a files filter covers only the files that match it",
      root: () => {
        const r = repo({ lint: { run: "exit 0", files: ["src/**/*.ts"] } });
        writeFile(r, "README.md", "changed\n");
        return r;
      },
      expected: { outcome: "pass", attempt: 1, changedFiles: 2, stages: [["lint", true, true, "pass", 1], ["typecheck", false, false, "skipped", 0], ["test", false, false, "skipped", 0]] },
    },
    {
      name: "block: the failing stage is recorded as fail and later stages did not run",
      root: () => repo({ lint: FAIL, test: PASS }),
      expected: { outcome: "block", attempt: 1, changedFiles: 1, stages: [["lint", true, true, "fail", 1], ["typecheck", false, false, "skipped", 0], ["test", true, false, "skipped", 0]] },
    },
    {
      name: "block on a timeout",
      root: () => repo({ test: slow }, { timeoutSec: 1 }),
      expected: { outcome: "block", attempt: 1, changedFiles: 1, stages: [["lint", false, false, "skipped", 0], ["typecheck", false, false, "skipped", 0], ["test", true, true, "timeout", 1]] },
    },
    {
      name: "nothing-ran: every stage skipped",
      root: () => repo({ lint: never, test: never }),
      expected: { outcome: "nothing-ran", attempt: 1, changedFiles: 1, stages: [["lint", true, false, "skipped", 0], ["typecheck", false, false, "skipped", 0], ["test", true, false, "skipped", 0]] },
    },
    {
      name: "changedFiles leaves out deleted files and harness files",
      root: () => {
        const r = repo({ lint: PASS });
        rmSync(join(r, "README.md"));
        writeFile(r, ".harness/progress.md", "notes\n");
        return r;
      },
      expected: { outcome: "pass", attempt: 1, changedFiles: 1, stages: [["lint", true, true, "pass", 1], ["typecheck", false, false, "skipped", 0], ["test", false, false, "skipped", 0]] },
    },
  ];
  for (const { name, root, expected } of cases) {
    const r = root();
    touch(r);
    const result = await stop(r);
    assert.deepEqual(shape(result), expected, name);
    assert.match(result.metrics.fingerprint, /^[0-9a-f]{64}$/, name);
    assert.ok(result.metrics.stages.every((s) => Number.isInteger(s.ms) && s.ms >= 0), name);
  }
});

test("metrics: gave-up and deadline outcomes", async () => {
  const root = repo({ lint: FAIL }, { maxAttempts: 1 });
  touch(root);
  assert.equal((await stop(root)).metrics.outcome, "block");
  const gaveUp = await stop(root);
  assert.deepEqual(shape(gaveUp), {
    outcome: "gave-up",
    attempt: 2,
    changedFiles: 1,
    stages: [["lint", true, false, "skipped", 0], ["typecheck", false, false, "skipped", 0], ["test", false, false, "skipped", 0]],
  });

  const slow = repo({ lint: PASS, test: `node -e "setTimeout(() => {}, 30000)"` });
  touch(slow);
  assert.deepEqual(shape(await stop(slow, { deadlineMs: 1500 })).stages, [["lint", true, true, "pass", 1], ["typecheck", false, false, "skipped", 0], ["test", true, true, "timeout", 1]]);
  const early = await stop(slow, { deadlineMs: 0 });
  assert.equal(early.metrics.outcome, "deadline");
  assert.equal(early.metrics.stages.find((s) => s.name === "lint").ran, false, "no stage started after the deadline");
});

test("metrics: attempt counts the stops since the last pass, and the pass after blocks records it", async () => {
  const root = repo({ test: `test -f ok.flag` });
  touch(root);
  assert.equal((await stop(root)).metrics.attempt, 1);
  assert.equal((await stop(root, { stop_hook_active: true })).metrics.attempt, 2);
  writeFile(root, "ok.flag", "");
  const pass = await stop(root, { stop_hook_active: true });
  assert.deepEqual([pass.metrics.outcome, pass.metrics.attempt], ["pass", 3]);
});

test("metrics: the silent paths record nothing", async () => {
  const unchanged = repo({ test: PASS });
  touch(unchanged);
  assert.equal((await stop(unchanged)).metrics.outcome, "pass");
  assert.equal((await stop(unchanged)).metrics, undefined, "no new changes since the last pass");
  assert.equal((await stop(repo({ test: PASS }))).metrics, undefined, "clean tree");
  const none = repo({});
  touch(none);
  assert.equal((await stop(none)).metrics, undefined, "nothing configured");
  const unreadable = repo({ test: FAIL });
  touch(unreadable);
  mkdirSync(join(unreadable, ".harness/state/verify-gate.json"), { recursive: true });
  assert.equal((await stop(unreadable, { stop_hook_active: true })).metrics, undefined, "unreadable counter");
});

test("metrics: carry no paths, output or commands", async () => {
  const root = repo({ lint: FAIL });
  touch(root);
  const { metrics } = await stop(root);
  const text = JSON.stringify(metrics);
  for (const leak of ["a.ts", "src/", "boom", "first line", "echo", root]) assert.ok(!text.includes(leak), `"${leak}"`);
});
