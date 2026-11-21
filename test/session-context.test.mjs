import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../lib/config.mjs";
import { sessionContext } from "../hooks/policies/session-context.mjs";
import { git, makeProject, makeRepo, writeFile } from "./helpers.mjs";

const context = async (root) => {
  const v = await sessionContext({ cwd: root, source: "startup" }, loadConfig(root));
  assert.equal(v.kind, "context");
  return v.text;
};

test("reports branch, dirty files and verify commands", async () => {
  const root = makeRepo({ verify: { test: "npx vitest related --run {files}", typecheck: "npx tsc --noEmit" } });
  git(root, "checkout", "-q", "-b", "feature/x");
  writeFile(root, "README.md", "changed\n");
  writeFile(root, "new.ts", "n\n");
  const text = await context(root);
  assert.match(text, /^Branch: feature\/x$/m);
  assert.match(text, /^Dirty files \(2\): README\.md, new\.ts$/m);
  assert.match(text, /`\{files\}`\/`\{dirs\}` = only the changed files or their directories are checked/);
  assert.match(text, /^- test: npx vitest related --run \{files\}$/m);
  assert.match(text, /^- typecheck: npx tsc --noEmit$/m);
  assert.doesNotMatch(text, /harness-init/);
});

test("shows a command's file filter", async () => {
  const root = makeRepo({ verify: { lint: { run: "npx eslint {files}", files: ["**/*.ts", "**/*.tsx"] } } });
  assert.match(await context(root), /^- lint: npx eslint \{files\} \(only for \*\*\/\*\.ts, \*\*\/\*\.tsx\)$/m);
});

test("lists at most 10 dirty files and counts the rest", async () => {
  const root = makeRepo({});
  for (let i = 0; i < 13; i++) writeFile(root, `f${String(i).padStart(2, "0")}.txt`, "x");
  const text = await context(root);
  assert.match(text, /Dirty files \(13\): f00\.txt, .*f09\.txt, … \(\+3 more\)/);
  assert.doesNotMatch(text, /f10\.txt/);
});

test("a clean tree says so; deleted files are marked", async () => {
  const root = makeRepo({});
  assert.match(await context(root), /^Working tree: clean$/m);
  rmSync(join(root, "README.md"));
  assert.match(await context(root), /Dirty files \(1\): README\.md \(deleted\)/);
});

test("includes the last 40 lines of .harness/progress.md", async () => {
  const root = makeRepo({});
  const lines = Array.from({ length: 60 }, (_, i) => `note ${i}`);
  writeFile(root, ".harness/progress.md", lines.join("\n") + "\n");
  const text = await context(root);
  assert.match(text, /Recent progress \(\.harness\/progress\.md\):/);
  assert.match(text, /^note 20$/m);
  assert.match(text, /^note 59$/m);
  assert.doesNotMatch(text, /^note 19$/m);
});

test("stays within about 2 KB even with long progress notes and many commands", async () => {
  const root = makeRepo({ verify: { lint: "l".repeat(400), test: "t".repeat(400), typecheck: "c".repeat(400) } });
  writeFile(root, ".harness/progress.md", Array.from({ length: 40 }, () => "y".repeat(200)).join("\n"));
  for (let i = 0; i < 10; i++) writeFile(root, `${"d".repeat(80)}${i}.txt`, "x");
  assert.ok((await context(root)).length <= 2048);
});

test("hints at harness-init when there is no config file", async () => {
  const root = makeRepo();
  assert.match(await context(root), /run \/harness:harness-init/);
});

test("leaves out git lines when the project is not a git repo", async () => {
  const root = makeProject({ verify: { test: "npm test" } });
  const text = await context(root);
  assert.doesNotMatch(text, /Branch:|Dirty files|Working tree/);
  assert.match(text, /- test: npm test/);
});
