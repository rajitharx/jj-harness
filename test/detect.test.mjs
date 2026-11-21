import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, validateConfig } from "../lib/config.mjs";
import { detectProject } from "../lib/detect.mjs";
import { runStage } from "../lib/verify.mjs";
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
      test: "npx --no -- vitest related --run --passWithNoTests {files}",
      lint: "npx --no -- eslint --no-warn-ignored {files}",
      format: "npx --no -- prettier --write --ignore-unknown",
      typecheck: "npx --no -- tsc --noEmit",
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
    { test: "bunx --no-install vitest related --run --passWithNoTests {files}", format: "bunx --no-install prettier --write --ignore-unknown" },
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
    { lint: "npx --no -- eslint --no-warn-ignored {files}" },
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
    { format: "rustfmt --edition 2021", lint: "cargo clippy", typecheck: "cargo check" },
    [/no related-test mode/, /never add it silently/],
  ],
  [
    "rust: rustfmt gets the edition from Cargo.toml",
    { "Cargo.toml": '[package]\nname = "x"\nedition = "2024"\n' },
    ["rust"],
    { format: "rustfmt --edition 2024", lint: "cargo clippy", typecheck: "cargo check" },
    [/rustfmt --edition 2024/],
  ],
  [
    "several stacks: the first with commands wins, the rest go to notes",
    { "package.json": pkg({ vitest: "1" }), "go.mod": "module x\n" },
    ["node", "go"],
    { test: "npx --no -- vitest related --run --passWithNoTests {files}" },
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
    { test: "npx --no -- vitest related --run --passWithNoTests {files}" },
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

// [name, files, the directory detectProject runs in, expected rustfmt edition, a note that must appear]
const WS = '[workspace]\nmembers = ["crates/*"]\n\n[workspace.package]\nedition = "2024"\n';
const RUST_EDITIONS = [
  ["no edition", { "Cargo.toml": '[package]\nname = "x"\n' }, ".", "2021", /default; Cargo.toml sets no edition/],
  ["[package] edition", { "Cargo.toml": '[package]\nname = "x"\nedition = "2018"\n' }, ".", "2018", /\(from Cargo\.toml\)/],
  [
    "a comment with no space before # after the value",
    { "Cargo.toml": '[package]\nname = "a#b" # c\nedition = "2018"#old\n' },
    ".",
    "2018",
    /\(from Cargo\.toml\)/,
  ],
  [
    "[package] edition wins over [workspace.package] in the same file",
    { "Cargo.toml": '[workspace.package]\nedition = "2024"\n\n[package]\nname = "x"\nedition = "2018"\n' },
    ".",
    "2018",
    /from Cargo\.toml/,
  ],
  [
    "edition.workspace = true in a root package that is also the workspace",
    { "Cargo.toml": '[package]\nname = "x"\nedition.workspace = true\n\n' + WS },
    ".",
    "2024",
    /from \[workspace\.package\] in Cargo\.toml/,
  ],
  [
    "virtual workspace manifest",
    { "Cargo.toml": WS },
    ".",
    "2024",
    /from \[workspace\.package\] in Cargo\.toml/,
  ],
  [
    "member with edition.workspace = true finds the parent workspace",
    { "Cargo.toml": WS, "crates/a/Cargo.toml": '[package]\nname = "a"\nedition.workspace = true # inherit\n' },
    "crates/a",
    "2024",
    /from \[workspace\.package\] in \.\.\/\.\.\/Cargo\.toml/,
  ],
  [
    "member with the inline-table form",
    { "Cargo.toml": WS, "crates/a/Cargo.toml": '[package]\nname = "a"\nedition = { workspace = true }\n' },
    "crates/a",
    "2024",
    /\.\.\/\.\.\/Cargo\.toml/,
  ],
  [
    "member skips a parent Cargo.toml that is not a workspace",
    {
      "Cargo.toml": WS,
      "crates/Cargo.toml": '[package]\nname = "mid"\nedition = "2015"\n',
      "crates/a/Cargo.toml": '[package]\nname = "a"\nedition.workspace = true\n',
    },
    "crates/a",
    "2024",
    /\.\.\/\.\.\/Cargo\.toml/,
  ],
  [
    "member with package.workspace pointing at the root",
    {
      "ws/Cargo.toml": '[workspace]\n[workspace.package]\nedition = "2018"\n',
      "Cargo.toml": WS,
      "ws/m/Cargo.toml": '[package]\nname = "m"\nworkspace = "../../"\nedition.workspace = true\n',
    },
    "ws/m",
    "2024",
    /\.\.\/\.\.\/Cargo\.toml/,
  ],
  [
    "member inherits but no workspace edition exists",
    { "crates/a/Cargo.toml": '[package]\nname = "a"\nedition.workspace = true\n' },
    "crates/a",
    "2021",
    /default; the workspace edition was not found/,
  ],
  [
    "edition keys in other tables are ignored",
    {
      "Cargo.toml":
        "[package]\nname = \"x\"\nedition.workspace = true\n\n[target.'cfg(unix)'.dependencies]\nedition = \"2015\"\n\n[[bin]]\nedition = \"2015\"\n\n" +
        WS,
    },
    ".",
    "2024",
    /from \[workspace\.package\]/,
  ],
];

for (const [name, files, dir, edition, note] of RUST_EDITIONS) {
  test(`detectProject: rustfmt edition: ${name}`, () => {
    const d = detectProject(join(fixture(files), dir));
    assert.equal(run(d.verify.format), `rustfmt --edition ${edition}`);
    assert.ok(d.notes.some((n) => note.test(n)), `a note matches ${note}: ${JSON.stringify(d.notes)}`);
  });
}

test("detectProject never proposes a full-suite test command", () => {
  for (const [, files] of CASES) {
    const t = run(detectProject(fixture(files)).verify.test);
    if (t === undefined) continue;
    assert.ok(/\{files\}|\{dirs\}|--testmon/.test(t), t);
  }
});

const hasNpx = (() => {
  try {
    execFileSync("npx", ["--version"], { stdio: "ignore", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
})();

// String tables can't tell whether npx hands the tool its own flags (it didn't
// with `npx --no tsc --noEmit`: npm parsed --noEmit). Run the generated
// commands against stub tools that print the argv they received.
test("generated npm commands pass every flag through npx to the tool", { skip: !hasNpx && "npx not on PATH" }, async () => {
  const stubs = ["tsc", "jest", "vitest", "eslint", "prettier"];
  const project = (devDependencies, extra = {}) => {
    const root = fixture({
      "package.json": { name: "app", devDependencies },
      "package-lock.json": "{}",
      "tsconfig.json": "{}",
      "eslint.config.js": "",
      "src/a.ts": "export {};\n",
      ...extra,
    });
    for (const tool of stubs) {
      const bin = join(root, "node_modules", ".bin", tool);
      writeFile(root, `node_modules/.bin/${tool}`, `#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`);
      chmodSync(bin, 0o755);
    }
    const { verify } = detectProject(root);
    writeFile(root, ".harness/config.json", JSON.stringify({ verify }));
    return loadConfig(root);
  };
  const jestProject = project({ jest: "29", eslint: "9", prettier: "3", typescript: "5" });
  const vitestProject = project({ vitest: "2" });

  const cases = [
    // [config, stage, argv the stub must receive]
    [jestProject, "typecheck", ["--noEmit"]],
    [jestProject, "test", ["--findRelatedTests", "--passWithNoTests", "src/a.ts"]],
    [jestProject, "lint", ["--no-warn-ignored", "src/a.ts"]],
    [jestProject, "format", ["--write", "--ignore-unknown", "src/a.ts"]],
    [vitestProject, "test", ["related", "--run", "--passWithNoTests", "src/a.ts"]],
  ];
  const results = await Promise.all(cases.map(([config, stage]) => runStage(stage, config, ["src/a.ts"], { timeoutMs: 60_000 })));
  cases.forEach(([config, stage, argv], i) => {
    const r = results[i];
    assert.equal(r.ok, true, `${stage}: ${r.command}\n${r.output}`);
    assert.match(r.command, /^npx --no -- /);
    const printed = r.output.trim().split("\n").filter((l) => l.startsWith("["));
    assert.deepEqual(printed.map((l) => JSON.parse(l)), [argv], `${stage}: ${r.command}\n${r.output}`);
  });
});
