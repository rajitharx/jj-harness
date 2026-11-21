import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../lib/config.mjs";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCommand, pathArg, runStage, shellQuote, stageFiles } from "../lib/verify.mjs";
import { makeProject, writeFile } from "./helpers.mjs";

const cmd = (run) => (run === undefined ? undefined : { run });

// Prints its arguments as JSON, so tests see exactly what the shell passed.
const ARGV_SCRIPT = "console.log(JSON.stringify(process.argv.slice(2)))";
const project = (verify) => {
  const root = makeProject({ verify });
  writeFile(root, "argv.cjs", ARGV_SCRIPT);
  return loadConfig(root);
};

test("buildCommand: placeholder, appending and skipping", () => {
  const cases = [
    // [name, command, files, expected]
    ["test", "vitest related --run {files}", ["a.ts", "b/c.ts"], "vitest related --run a.ts b/c.ts"],
    ["lint", "eslint {files} --max-warnings 0", ["a.ts"], "eslint a.ts --max-warnings 0"],
    ["lint", "x {files} && y {files}", ["a"], "x a && y a"],
    ["test", "go test ./...", ["a.go"], "go test ./..."],
    ["typecheck", "tsc --noEmit", [], "tsc --noEmit"],
    ["test", "vitest related --run {files}", [], null],
    ["format", "prettier -w", ["src/a.ts"], "prettier -w src/a.ts"],
    ["format", "prettier -w {files} --log-level warn", ["a.ts"], "prettier -w a.ts --log-level warn"],
    ["format", "prettier -w", [], null],
    ["test", "", ["a"], null],
    ["test", undefined, ["a"], null],
  ];
  for (const [name, command, files, expected] of cases) {
    assert.equal(buildCommand(name, cmd(command), files), expected, `${name}: ${command} ${JSON.stringify(files)}`);
  }
});

test("buildCommand: file filters and {dirs}", () => {
  const TS = ["**/*.ts", "**/*.tsx"];
  const cases = [
    // [name, entry, files, expected]
    ["lint", { run: "eslint {files}", files: TS }, ["README.md", "src/a.ts", "b.tsx", "x.json"], "eslint src/a.ts b.tsx"],
    ["lint", { run: "eslint {files}", files: TS }, ["README.md", "package.json"], null],
    ["test", { run: "pytest {files}", files: ["**/test_*.py", "**/*_test.py"] }, ["app/x.py", "tests/test_x.py", "y_test.py"], "pytest tests/test_x.py y_test.py"],
    ["test", { run: "go test {dirs}", files: ["**/*.go"] }, ["main.go", "pkg/a/a.go", "pkg/a/b.go", "pkg/b/c.go", "go.mod"], "go test . ./pkg/a ./pkg/b"],
    ["test", { run: "go test {dirs}" }, ["-x/a.go"], "go test ./-x"],
    ["test", { run: "go test {dirs}" }, ["my dir/a.go"], "go test './my dir'"],
    ["test", { run: "go vet {dirs} && echo {files}", files: ["**/*.go"] }, ["a/x.go"], "go vet ./a && echo a/x.go"],
    ["test", { run: "go test {dirs}", files: ["**/*.go"] }, ["README.md"], null],
    ["test", { run: "go test {dirs}" }, [], null],
    // A file name holding a placeholder is not substituted a second time.
    ["lint", { run: "x {files} {dirs}" }, ["a{dirs}.ts"], "x 'a{dirs}.ts' ."],
    ["format", { run: "gofmt -w", files: ["**/*.go"] }, ["a.go", "b.md"], "gofmt -w a.go"],
    ["format", { run: "gofmt -w", files: ["**/*.go"] }, ["b.md"], null],
    // A whole-project command with a filter runs only when a matching file changed.
    ["typecheck", { run: "tsc --noEmit", files: TS }, ["a.ts"], "tsc --noEmit"],
    ["typecheck", { run: "tsc --noEmit", files: TS }, ["README.md"], null],
    ["typecheck", { run: "tsc --noEmit" }, [], "tsc --noEmit"],
  ];
  for (const [name, entry, files, expected] of cases) {
    assert.equal(buildCommand(name, entry, files), expected, `${name}: ${JSON.stringify(entry)} ${JSON.stringify(files)}`);
  }
});

test("stageFiles drops deleted and .harness/ files", () => {
  const changed = [
    { path: ".harness/config.json", deleted: false },
    { path: "a.ts", deleted: false },
    { path: "gone.ts", deleted: true },
    { path: "src/b.ts", deleted: false },
  ];
  assert.deepEqual(stageFiles(changed), ["a.ts", "src/b.ts"]);
});

test("shellQuote leaves plain paths alone and quotes the rest", () => {
  const cases = [
    ["src/a.ts", "src/a.ts"],
    ["my file.ts", "'my file.ts'"],
    ["it's.ts", "'it'\\''s.ts'"],
    ["$HOME.ts", "'$HOME.ts'"],
    ['a"b.ts', `'a"b.ts'`],
    ["a;rm -rf x", "'a;rm -rf x'"],
    ["`id`.ts", "'`id`.ts'"],
  ];
  for (const [input, expected] of cases) assert.equal(shellQuote(input), expected, input);
});

test("pathArg keeps a leading '-' from reading as an option, combined with quoting", () => {
  const cases = [
    ["-rf", "./-rf"],
    ["--x=1", "./--x=1"],
    ["--config=evil.js", "./--config=evil.js"],
    ["-", "./-"],
    ["-my file.ts", "'./-my file.ts'"],
    ["-it's.ts", "'./-it'\\''s.ts'"],
    ["--$(id).ts", "'./--$(id).ts'"],
    ["src/-rf", "src/-rf"],
    ["a-b.ts", "a-b.ts"],
    ["my file.ts", "'my file.ts'"],
  ];
  for (const [input, expected] of cases) assert.equal(pathArg(input), expected, input);
  assert.equal(buildCommand("lint", cmd("eslint {files}"), ["-rf", "--config=evil.js"]), "eslint ./-rf ./--config=evil.js");
  assert.equal(buildCommand("format", cmd("prettier -w"), ["--write=x"]), "prettier -w ./--write=x");
});

test("runStage passes awkward file names to the command intact", async () => {
  const config = project({ test: "node argv.cjs {files}", format: "node argv.cjs" });
  const files = ["plain.ts", "with space.ts", "it's.ts", 'dq"uote.ts', "$HOME.ts", "`id`.ts", "a;b.ts", "-rf", "--x=1", "-a b's"];
  const expected = files.map((f) => (f.startsWith("-") ? `./${f}` : f));
  for (const stage of ["test", "format"]) {
    const r = await runStage(stage, config, files);
    assert.equal(r.ok, true, r.output);
    assert.equal(r.skipped, false);
    assert.deepEqual(JSON.parse(r.output), expected, stage);
  }
});

test("runStage skips unconfigured stages and {files} with no files", async () => {
  const config = project({ test: "node argv.cjs {files}", typecheck: "node argv.cjs" });
  assert.deepEqual(await runStage("lint", config, ["a"]), { ok: true, skipped: true, output: "" });
  assert.deepEqual(await runStage("test", config, []), { ok: true, skipped: true, output: "" });
  const r = await runStage("typecheck", config, []);
  assert.equal(r.skipped, false, "no {files}: runs as written");
  assert.deepEqual(JSON.parse(r.output), []);
});

test("runStage reports non-zero exits with combined output", async () => {
  const config = project({ lint: `node -e "console.log('out'); console.error('err'); process.exit(3)"` });
  const r = await runStage("lint", config, []);
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
  assert.equal(r.timedOut, undefined);
  assert.match(r.output, /out/);
  assert.match(r.output, /err/);
  assert.equal(r.command, config.verify.lint.run);
});

test("runStage runs in the project root with CI=1", async () => {
  const config = project({ test: `node -e "console.log(process.cwd() + '|' + process.env.CI)"` });
  const r = await runStage("test", config, []);
  const [cwd, ci] = r.output.trim().split("|");
  assert.equal(ci, "1");
  assert.ok(cwd.endsWith(config.root.split("/").pop()), cwd);
});

test("runStage kills a command that runs past the timeout", async () => {
  const config = project({ test: `node -e "setTimeout(() => {}, 20000)"` });
  const started = Date.now();
  const r = await runStage("test", config, [], { timeoutMs: 200 });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 5000, "returned promptly");
});

test("runStage keeps only the tail of very long output", async () => {
  const config = project({ test: `node -e "process.stdout.write('x'.repeat(200000) + 'END'); process.exitCode = 1"` });
  const r = await runStage("test", config, []);
  assert.ok(r.output.length <= 64 * 1024);
  assert.ok(r.output.endsWith("END"));
});

test("runStage defaults to formatTimeoutSec for format and stopGate.timeoutSec otherwise", async () => {
  const root = makeProject({
    verify: { format: `node -e "setTimeout(() => {}, 20000)"`, test: `node -e "setTimeout(() => {}, 20000)"` },
    formatTimeoutSec: 1,
    stopGate: { timeoutSec: 1 },
  });
  const config = loadConfig(root);
  const [format, testStage] = await Promise.all([runStage("format", config, ["a.ts"]), runStage("test", config, [])]);
  assert.equal(format.timedOut, true);
  assert.equal(testStage.timedOut, true);
});

test("killing the hook process with SIGTERM also kills the running stage's process group", async () => {
  const root = makeProject();
  // The stage records its shell's pid and a background grandchild's pid, then waits.
  const stage = "sleep 30 & echo $! > grandchild.pid; echo $$ > stage.pid; wait";
  const config = { root, verify: { test: { run: stage } }, stopGate: { timeoutSec: 60 }, formatTimeoutSec: 30 };
  const verifyUrl = new URL("../lib/verify.mjs", import.meta.url).href;
  const script = `const { runStage } = await import(${JSON.stringify(verifyUrl)}); await runStage("test", ${JSON.stringify(config)}, []);`;
  const parent = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
  const exited = new Promise((resolve) => parent.on("exit", (code, signal) => resolve(signal)));

  const pidFiles = ["stage.pid", "grandchild.pid"].map((f) => join(root, f));
  await waitFor(() => pidFiles.every((f) => existsSync(f) && readFileSync(f, "utf8").trim()));
  const pids = pidFiles.map((f) => Number(readFileSync(f, "utf8").trim()));
  assert.ok(pids.every(alive), "stage running before the kill");

  parent.kill("SIGTERM");
  assert.equal(await exited, "SIGTERM", "the parent still dies of the signal");
  await waitFor(() => !pids.some(alive));
  assert.deepEqual(pids.filter(alive), [], "no stage process is left behind");
});

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}
