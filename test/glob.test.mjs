import { test } from "node:test";
import assert from "node:assert/strict";
import { globToRegExp, matchGlob } from "../lib/glob.mjs";

test("globToRegExp: **, *, ?, dot-files, literals and case", () => {
  const cases = [
    // [glob, path, matches]
    ["**/*.ts", "a.ts", true],
    ["**/*.ts", "src/deep/a.ts", true],
    ["**/*.ts", "src/a.tsx", false],
    ["**/*.ts", ".hidden.ts", true],
    ["src/**", "src/a/b/c", true],
    ["src/**", "srcx/a", false],
    ["data/?.csv", "data/1.csv", true],
    ["data/?.csv", "data/12.csv", false],
    ["*.sqlite", "app.sqlite", true],
    ["*.sqlite", "db/app.sqlite", false],
    ["infra/**/prod/*.tfvars", "infra/prod/x.tfvars", true],
    ["infra/**/prod/*.tfvars", "infra/a/b/prod/x.tfvars", true],
    ["infra/**/prod/*.tfvars", "infra/prod/sub/x.tfvars", false],
    ["**/test_*.py", "tests/test_api.py", true],
    ["**/test_*.py", "test_api.py", true],
    ["**/test_*.py", "tests/api_test.py", false],
    ["file(1).txt", "file(1).txt", true],
    ["a+b.txt", "aab.txt", false],
    [".env", ".ENV", true],
  ];
  for (const [glob, path, expected] of cases) {
    assert.equal(globToRegExp(glob).test(path), expected, `${glob} vs ${path}`);
  }
});

test("matchGlob returns the first matching pattern", () => {
  assert.equal(matchGlob("src/a.tsx", ["**/*.ts", "**/*.tsx"]), "**/*.tsx");
  assert.equal(matchGlob("README.md", ["**/*.ts"]), undefined);
  assert.equal(matchGlob("a.ts", []), undefined);
});
