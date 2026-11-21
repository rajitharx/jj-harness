import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../lib/config.mjs";
import { makeProject } from "./helpers.mjs";

test("defaults when no config file exists", () => {
  const root = makeProject();
  const c = loadConfig(root);
  assert.equal(c.root, root);
  assert.deepEqual(c.verify, {});
  assert.ok(c.protectedPaths.includes(".env"));
  assert.deepEqual(c.blockedCommands, []);
  assert.deepEqual(c.stopGate, { enabled: true, maxAttempts: 3 });
});

test("finds the project root from a nested cwd", () => {
  const root = makeProject({ verify: { test: "npm test" } });
  const nested = join(root, "src", "deep");
  mkdirSync(nested, { recursive: true });
  const c = loadConfig(nested);
  assert.equal(realpathSync(c.root), realpathSync(root));
  assert.equal(c.verify.test, "npm test");
});

test("merges project values over defaults; empty verify commands are dropped", () => {
  const c = loadConfig(
    makeProject({
      verify: { lint: "npm run lint", typecheck: "" },
      protectedPaths: ["secrets/**"],
      blockedCommands: ["terraform destroy"],
      stopGate: { maxAttempts: 5 },
    }),
  );
  assert.deepEqual(c.verify, { lint: "npm run lint" });
  assert.ok(c.protectedPaths.includes("secrets/**"));
  assert.ok(c.protectedPaths.includes(".env"), "defaults are extended, not replaced");
  assert.deepEqual(c.blockedCommands, ["terraform destroy"]);
  assert.deepEqual(c.stopGate, { enabled: true, maxAttempts: 5 });
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
  ["protectedPaths not strings", { protectedPaths: [1] }],
  ["bad regex", { blockedCommands: ["("] }],
  ["bad maxAttempts", { stopGate: { maxAttempts: 0 } }],
  ["bad enabled", { stopGate: { enabled: "yes" } }],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() => loadConfig(makeProject(config)), ConfigError);
  });
}
