import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, loadConfig, stageEntries, validateConfig } from "../lib/config.mjs";
import { makeProject } from "./helpers.mjs";

test("defaults when no config file exists", () => {
  const root = makeProject();
  const c = loadConfig(root);
  assert.equal(c.root, root);
  assert.deepEqual(c.verify, {});
  assert.ok(c.protectedPaths.includes(".env"));
  assert.deepEqual(c.blockedCommands, []);
  assert.deepEqual(c.stopGate, { enabled: true, maxAttempts: 3, timeoutSec: 300 });
  assert.equal(c.formatTimeoutSec, 30);
});

test("finds the project root from a nested cwd", () => {
  const root = makeProject({ verify: { test: "npm test" } });
  const nested = join(root, "src", "deep");
  mkdirSync(nested, { recursive: true });
  const c = loadConfig(nested);
  assert.equal(realpathSync(c.root), realpathSync(root));
  assert.deepEqual(c.verify.test, { run: "npm test" });
});

test("merges project values over defaults; empty verify commands are dropped", () => {
  const c = loadConfig(
    makeProject({
      verify: { lint: "npm run lint", typecheck: "" },
      protectedPaths: ["secrets/**"],
      blockedCommands: ["terraform destroy"],
      stopGate: { maxAttempts: 5, timeoutSec: 60 },
      formatTimeoutSec: 10,
    }),
  );
  assert.deepEqual(c.verify, { lint: { run: "npm run lint" } });
  assert.ok(c.protectedPaths.includes("secrets/**"));
  assert.ok(c.protectedPaths.includes(".env"), "defaults are extended, not replaced");
  assert.deepEqual(c.blockedCommands, ["terraform destroy"]);
  assert.deepEqual(c.stopGate, { enabled: true, maxAttempts: 5, timeoutSec: 60 });
  assert.equal(c.formatTimeoutSec, 10);
});

test("verify entries: strings and { run, files } normalize to one shape", () => {
  const c = loadConfig(
    makeProject({
      verify: {
        format: "prettier --write",
        lint: { run: "eslint {files}", files: ["**/*.ts", "**/*.tsx"] },
        typecheck: { run: "tsc --noEmit" },
        test: { run: "  ", files: ["**/*.ts"] },
      },
    }),
  );
  assert.deepEqual(c.verify, {
    format: { run: "prettier --write" },
    lint: { run: "eslint {files}", files: ["**/*.ts", "**/*.tsx"] },
    typecheck: { run: "tsc --noEmit" },
  });
  assert.throws(() => c.verify.lint.files.push("x"), "filters are frozen too");
});

test("validateConfig checks a raw object without reading a file", () => {
  assert.doesNotThrow(() => validateConfig({ verify: { test: { run: "go test {dirs}", files: ["**/*.go"] } } }));
  assert.throws(() => validateConfig({ verify: { test: { files: ["x"] } } }, "proposal"), /proposal: verify\.test\.run/);
});

test("result is frozen", () => {
  const c = loadConfig(makeProject());
  assert.throws(() => c.protectedPaths.push("x"));
  assert.throws(() => { c.stopGate.enabled = false; });
});

for (const [name, config] of [
  ["invalid JSON", "{ nope"],
  ["non-object root", "[]"],
  ["unknown verify key", { verify: { build: "make" } }],
  ["non-string verify command", { verify: { test: 1 } }],
  ["empty verify array", { verify: { test: [] } }],
  ["verify array holding a number", { verify: { test: ["npm test", 1] } }],
  ["verify array entry with unknown key", { verify: { test: [{ run: "x", dir: "a" }] } }],
  ["nested verify array", { verify: { test: [["npm test"]] } }],
  ["verify entry without run", { verify: { test: { files: ["**/*.ts"] } } }],
  ["verify entry with non-string run", { verify: { test: { run: 1 } } }],
  ["verify entry with unknown key", { verify: { test: { run: "x", dir: "a" } } }],
  ["cwd that is not a string", { verify: { test: { run: "x", cwd: 1 } } }],
  ["absolute cwd", { verify: { test: { run: "x", cwd: "/etc" } } }],
  ["windows drive cwd", { verify: { test: { run: "x", cwd: "C:/work" } } }],
  ["cwd climbing out of the project", { verify: { test: { run: "x", cwd: "../other" } } }],
  ["cwd climbing out in the middle", { verify: { test: { run: "x", cwd: "apps/../../other" } } }],
  ["cwd with a backslash", { verify: { test: { run: "x", cwd: "apps\\web" } } }],
  ["cwd on one entry of an array", { verify: { test: [{ run: "x", cwd: "ok" }, { run: "y", cwd: "../no" }] } }],
  ["verify files not an array", { verify: { lint: { run: "x {files}", files: "**/*.ts" } } }],
  ["verify files empty", { verify: { lint: { run: "x {files}", files: [] } } }],
  ["verify files with a non-string", { verify: { lint: { run: "x {files}", files: [1] } } }],
  ["verify files with an empty glob", { verify: { lint: { run: "x {files}", files: [""] } } }],
  ["protectedPaths not strings", { protectedPaths: [1] }],
  ["allowPaths not strings", { allowPaths: [".env.example", 1] }],
  ["allowPaths not an array", { allowPaths: ".env.example" }],
  ["bad regex", { blockedCommands: ["("] }],
  ["bad maxAttempts", { stopGate: { maxAttempts: 0 } }],
  ["bad enabled", { stopGate: { enabled: "yes" } }],
  ["zero timeoutSec", { stopGate: { timeoutSec: 0 } }],
  ["fractional timeoutSec", { stopGate: { timeoutSec: 1.5 } }],
  ["string timeoutSec", { stopGate: { timeoutSec: "300" } }],
  ["zero formatTimeoutSec", { formatTimeoutSec: 0 }],
  ["fractional formatTimeoutSec", { formatTimeoutSec: 2.5 }],
  ["unknown stopGate key", { stopGate: { maxAttempt: 2 } }],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() => loadConfig(makeProject(config)), ConfigError);
  });
}

// [name, written verify stage, expected normalized stage]
for (const [name, written, expected] of [
  ["a cwd is cleaned", { run: "x", cwd: "./apps//web/" }, { run: "x", cwd: "apps/web" }],
  ["a cwd of . means the root", { run: "x", cwd: "." }, { run: "x" }],
  ["cwd and files together", { run: "x {files}", files: ["**/*.ts"], cwd: "web" }, { run: "x {files}", files: ["**/*.ts"], cwd: "web" }],
  ["an array of one is unwrapped", [{ run: "x", cwd: "a" }], { run: "x", cwd: "a" }],
  [
    "an array keeps its order and drops empty commands",
    ["root", { run: " ", cwd: "gone" }, { run: "y", cwd: "b" }, { run: "z", files: ["**/*.go"], cwd: "c" }],
    [{ run: "root" }, { run: "y", cwd: "b" }, { run: "z", files: ["**/*.go"], cwd: "c" }],
  ],
]) {
  test(`normalizes ${name}`, () => {
    assert.deepEqual(loadConfig(makeProject({ verify: { test: written } })).verify.test, expected);
  });
}

test("a stage whose commands are all empty is dropped", () => {
  assert.deepEqual(loadConfig(makeProject({ verify: { test: ["", { run: "" }] } })).verify, {});
});

test("stageEntries gives one list for a single entry, an array or no stage", () => {
  assert.deepEqual(stageEntries(undefined), []);
  assert.deepEqual(stageEntries({ run: "x" }), [{ run: "x" }]);
  assert.deepEqual(stageEntries([{ run: "x" }, { run: "y" }]), [{ run: "x" }, { run: "y" }]);
});
