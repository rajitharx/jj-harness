import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../lib/config.mjs";
import { detectProject } from "../lib/detect.mjs";
import { writeFile } from "./helpers.mjs";

const JS = ["**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs", "**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"];
const PY = ["**/*.py", "**/*.pyi"];
const GO = ["**/*.go"];

/** A fixture project in a temp dir: `files` maps paths to contents (objects become JSON). */
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "harness-detect-"));
  for (const [path, content] of Object.entries(files)) {
    writeFile(root, path, typeof content === "string" ? content : JSON.stringify(content));
  }
  return root;
}

const pkg = (devDependencies = {}, extra = {}) => ({ name: "app", devDependencies, ...extra });
const run = (entry) => (typeof entry === "string" ? entry : entry?.run);

// [name, files, expected stacks, expected run per stage (undefined = absent), notes that must appear]
const CASES = [
  [
    "npm + vitest + eslint flat + prettier + tsc",
    {
      "package.json": pkg({ vitest: "1", eslint: "9", prettier: "3", typescript: "5" }),
      "package-lock.json": "{}",
      "eslint.config.js": "",
      "tsconfig.json": "{}",
    },
    ["node"],
    {
      test: "npx --no vitest related --run --passWithNoTests {files}",
      lint: "npx --no eslint --no-warn-ignored {files}",
      format: "npx --no prettier --write --ignore-unknown",
      typecheck: "npx --no tsc --noEmit",
    },
    [/Package manager: npm/],
  ],
  [
    "pnpm + jest (from config file) + biome",
    { "package.json": pkg({ "@biomejs/biome": "1" }), "pnpm-lock.yaml": "", "jest.config.js": "" },
    ["node"],
    {
      test: "pnpm exec jest --findRelatedTests --passWithNoTests {files}",
      lint: "pnpm exec biome lint --no-errors-on-unmatched {files}",
      format: "pnpm exec biome format --write --no-errors-on-unmatched",
    },
    [/pnpm \(from its lockfile\)/],
  ],
  [
    "yarn + jest from scripts + legacy eslintrc",
    { "package.json": pkg({}, { scripts: { test: "jest --ci", lint: "eslint ." } }), "yarn.lock": "", ".eslintrc.json": "{}" },
    ["node"],
    { test: "yarn jest --findRelatedTests --passWithNoTests {files}", lint: "yarn eslint {files}" },
    [/legacy \.eslintrc/],
  ],
  [
    "bun + vitest config file + prettierrc",
    { "package.json": pkg(), "bun.lockb": "", "vitest.config.ts": "", ".prettierrc": "{}" },
    ["node"],
    { test: "bunx vitest related --run --passWithNoTests {files}", format: "bunx prettier --write --ignore-unknown" },
    [/bun/],
  ],
  [
    "node:test with no runner",
    { "package.json": pkg({}, { scripts: { test: 'node --test "test/**/*.test.mjs"' } }) },
    ["node"],
    { test: "node --test {files}" },
    [/runs only the changed test files/],
  ],
  [
    "node with no test runner gets no test command",
    { "package.json": pkg({ eslint: "9" }) },
    ["node"],
    { lint: "npx --no eslint --no-warn-ignored {files}" },
    [/No related-test command/, /never fall back to the full suite/],
  ],
  [
    "uv + pytest + ruff + mypy",
    {
      "pyproject.toml": '[project]\nname = "app"\n[dependency-groups]\ndev = ["pytest>=8", "ruff", "mypy"]\n',
      "uv.lock": "",
    },
    ["python"],
    {
      test: "uv run pytest {files}",
      lint: "uv run ruff check --force-exclude {files}",
      format: "uv run ruff format --force-exclude",
      typecheck: "uv run mypy .",
    },
    [/runs only changed test files/, /uv run/],
  ],
  [
    "poetry + pytest-testmon + pyright config",
    {
      "pyproject.toml": '[tool.poetry.group.dev.dependencies]\npytest = "^8"\npytest-testmon = "^2"\n',
      "poetry.lock": "",
      "pyrightconfig.json": "{}",
    },
    ["python"],
    { test: "poetry run pytest --testmon", typecheck: "poetry run pyright" },
    [/pytest-testmon/],
  ],
  [
    "bare pip: requirements files and a [tool.pytest] section",
    {
      "requirements.txt": "flask\n",
      "requirements-dev.txt": "ruff==0.6\n",
      "pyproject.toml": "[tool.pytest.ini_options]\naddopts = '-q'\n",
    },
    ["python"],
    { test: "pytest {files}", lint: "ruff check --force-exclude {files}", format: "ruff format --force-exclude" },
    [],
  ],
  [
    "python: pytest-cov alone is not pytest-testmon",
    { "requirements.txt": "pytest\npytest-cov\n" },
    ["python"],
    { test: "pytest {files}" },
    [],
  ],
  [
    "go with golangci",
    { "go.mod": "module x\n", ".golangci.yml": "" },
    ["go"],
    { format: "gofmt -w", typecheck: "go vet {dirs}", test: "go test {dirs}", lint: "golangci-lint run {dirs}" },
    [/packages with changed files/],
  ],
  [
    "go without golangci has no lint",
    { "go.mod": "module x\n" },
    ["go"],
    { format: "gofmt -w", typecheck: "go vet {dirs}", test: "go test {dirs}" },
    [],
  ],
  [
    "rust: no test command, and a note to ask",
    { "Cargo.toml": "[package]\nname = 'x'\n" },
    ["rust"],
    { format: "cargo fmt --", lint: "cargo clippy", typecheck: "cargo check" },
    [/no related-test mode/, /never add it silently/],
  ],
  [
    "several stacks: the first with commands wins, the rest go to notes",
    { "package.json": pkg({ vitest: "1" }), "go.mod": "module x\n" },
    ["node", "go"],
    { test: "npx --no vitest related --run --passWithNoTests {files}" },
    [/Also found a go project \(go\.mod\).*go test \{dirs\}.*Ask the user which stack/],
  ],
  [
    "a toolless package.json does not hide a real python project",
    { "package.json": { name: "docs-tooling" }, "pyproject.toml": '[project]\ndependencies = ["pytest"]\n' },
    ["node", "python"],
    { test: "pytest {files}" },
    [/Also found a node project/],
  ],
  [
    "invalid package.json still detects from config files",
    { "package.json": "{ nope", "vitest.config.mjs": "" },
    ["node"],
    { test: "npx --no vitest related --run --passWithNoTests {files}" },
    [/not valid JSON/],
  ],
  ["nothing recognisable", { "README.md": "hi" }, [], {}, [/No supported stack found/]],
];

for (const [name, files, stacks, expected, notePatterns] of CASES) {
  test(`detectProject: ${name}`, () => {
    const d = detectProject(fixture(files));
    assert.deepEqual(d.stacks, stacks);
    const got = Object.fromEntries(Object.entries(d.verify).map(([k, v]) => [k, run(v)]));
    assert.deepEqual(got, expected);
    for (const re of notePatterns) assert.ok(d.notes.some((n) => re.test(n)), `a note matches ${re}: ${JSON.stringify(d.notes)}`);
    // Every proposal is a valid config.
    assert.doesNotThrow(() => validateConfig({ verify: d.verify }));
  });
}

test("detectProject: file filters keep strict tools away from docs and config files", () => {
  const node = detectProject(
    fixture({ "package.json": pkg({ vitest: "1", eslint: "9" }), "eslint.config.js": "", "tsconfig.json": "{}" }),
  ).verify;
  assert.deepEqual(node.test.files, JS);
  assert.deepEqual(node.lint.files, JS);
  assert.ok(node.typecheck.files.includes("**/tsconfig*.json"));

  const py = detectProject(fixture({ "requirements.txt": "pytest\nruff\n" })).verify;
  assert.deepEqual(py.test.files, ["**/test_*.py", "**/*_test.py"]);
  assert.deepEqual(py.lint.files, PY);

  const go = detectProject(fixture({ "go.mod": "module x\n" })).verify;
  for (const stage of ["format", "typecheck", "test"]) assert.deepEqual(go[stage].files, GO, stage);

  const rust = detectProject(fixture({ "Cargo.toml": "" })).verify;
  assert.ok(rust.typecheck.files.includes("**/*.rs") && rust.typecheck.files.includes("**/Cargo.toml"));
});

test("detectProject never proposes a full-suite test command", () => {
  for (const [, files] of CASES) {
    const t = run(detectProject(fixture(files)).verify.test);
    if (t === undefined) continue;
    assert.ok(/\{files\}|\{dirs\}|--testmon/.test(t), t);
  }
});
