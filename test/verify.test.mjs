import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../lib/config.mjs";
import { buildCommand, runStage, shellQuote } from "../lib/verify.mjs";
import { makeProject, writeFile } from "./helpers.mjs";

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
    assert.equal(buildCommand(name, command, files), expected, `${name}: ${command} ${JSON.stringify(files)}`);
  }
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

test("runStage passes awkward file names to the command intact", async () => {
  const config = project({ test: "node argv.cjs {files}", format: "node argv.cjs" });
  const files = ["plain.ts", "with space.ts", "it's.ts", 'dq"uote.ts', "$HOME.ts", "`id`.ts", "a;b.ts"];
  for (const stage of ["test", "format"]) {
    const r = await runStage(stage, config, files);
    assert.equal(r.ok, true, r.output);
    assert.equal(r.skipped, false);
    assert.deepEqual(JSON.parse(r.output), files, stage);
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
  assert.equal(r.command, config.verify.lint);
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
