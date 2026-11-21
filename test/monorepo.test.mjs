// Monorepo and .NET support: detection across package directories, and the
// `cwd` / array-of-entries form of verify commands that detection proposes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, validateConfig } from "../lib/config.mjs";
import { detectProject } from "../lib/detect.mjs";
import { planStage, runStage } from "../lib/verify.mjs";
import { sessionContext } from "../hooks/policies/session-context.mjs";
import { verifyGate } from "../hooks/policies/verify-gate.mjs";
import { makeRepo, writeFile } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../bin/harness.mjs", import.meta.url));
const DOTNET = ["**/*.cs", "**/*.razor", "**/*.cshtml", "**/*.csproj", "**/*.props", "**/*.targets"];

/** A fixture project in a temp dir: `files` maps paths to contents (objects become JSON). */
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "harness-mono-"));
  for (const [path, content] of Object.entries(files)) {
    writeFile(root, path, typeof content === "string" ? content : JSON.stringify(content));
  }
  return root;
}

const entries = (stage) => (stage === undefined ? [] : Array.isArray(stage) ? stage : [stage]);
const runOf = (e) => (typeof e === "string" ? e : e.run);
/** `{ stage: [[cwd, run], …] }`, the shape the tables below compare. */
const shape = (verify) =>
  Object.fromEntries(Object.entries(verify).map(([k, v]) => [k, entries(v).map((e) => [e.cwd ?? ".", runOf(e)])]));

// The OnLah layout: two npm apps and a .NET backend, no root package.json.
const ONLAH = {
  "apps/mobile/package.json": { scripts: { typecheck: "tsc --noEmit", test: "jest", check: "npm run typecheck" }, devDependencies: { jest: "1", typescript: "5" } },
  "apps/mobile/tsconfig.json": "{}",
  "apps/web/package.json": { scripts: { test: "vitest run", build: "tsc --noEmit && vite build" }, devDependencies: { vitest: "1" } },
  "apps/web/tsconfig.json": "{}",
  "apps/backend/OnLah.sln": "",
  "apps/backend/global.json": '{ "sdk": { "version": "10.0.100" } }',
  "apps/backend/src/Api/Api.csproj": "<Project />",
};

// [name, files, expected stacks, expected packages, expected verify as { stage: [[cwd, run]] }, notes that must appear]
const CASES = [
  [
    "monorepo: two npm apps and a .NET project, no root manifest",
    ONLAH,
    ["dotnet", "node"],
    [
      ["apps/backend", ["dotnet"]],
      ["apps/mobile", ["node"]],
      ["apps/web", ["node"]],
    ],
    {
      test: [
        ["apps/backend", "dotnet test"],
        ["apps/mobile", "npx --no -- jest --findRelatedTests --passWithNoTests {files}"],
        ["apps/web", "npx --no -- vitest related --run --passWithNoTests {files}"],
      ],
      typecheck: [
        ["apps/mobile", "npx --no -- tsc --noEmit"],
        ["apps/web", "npx --no -- tsc --noEmit"],
      ],
    },
    [/Monorepo: found 3 packages: apps\/backend \(dotnet\), apps\/mobile \(node\), apps\/web \(node\)/, /\[apps\/backend\] `dotnet test` has no related-test mode/],
  ],
  [
    "single stack at the root (no regression)",
    { "package.json": { devDependencies: { vitest: "1" } }, "tsconfig.json": "{}" },
    ["node"],
    [[".", ["node"]]],
    { test: [[".", "npx --no -- vitest related --run --passWithNoTests {files}"]], typecheck: [[".", "npx --no -- tsc --noEmit"]] },
    [/Package manager: npm/],
  ],
  ["empty repo", { "README.md": "hi" }, [], [], {}, [/No supported stack found \(looked in the root, its subdirectories/]],
  [
    "subdirectories without a manifest are not packages",
    { "src/index.ts": "", "docs/guide.md": "", "scripts/run.sh": "" },
    [],
    [],
    {},
    [/No supported stack found/],
  ],
  [
    "services/ and packages/ children are packages, deeper directories are not",
    { "services/api/go.mod": "module x\n", "packages/ui/package.json": { devDependencies: { vitest: "1" } }, "services/api/internal/x/go.mod": "module y\n" },
    ["node", "go"],
    [
      ["packages/ui", ["node"]],
      ["services/api", ["go"]],
    ],
    {
      format: [["services/api", "gofmt -w"]],
      typecheck: [["services/api", "go vet {dirs}"]],
      test: [
        ["packages/ui", "npx --no -- vitest related --run --passWithNoTests {files}"],
        ["services/api", "go test {dirs}"],
      ],
    },
    [],
  ],
  [
    "an immediate subdirectory (not under apps/) is a package",
    { "web/package.json": { devDependencies: { vitest: "1" } }, "go.mod": "module x\n" },
    ["go", "node"],
    [
      [".", ["go"]],
      ["web", ["node"]],
    ],
    {
      format: [[".", "gofmt -w"]],
      typecheck: [[".", "go vet {dirs}"]],
      test: [
        [".", "go test {dirs}"],
        ["web", "npx --no -- vitest related --run --passWithNoTests {files}"],
      ],
    },
    [/Monorepo: found 2 packages/],
  ],
  [
    "node_modules, build output and dot directories are never packages",
    {
      "node_modules/left-pad/package.json": "{}",
      "dist/package.json": "{}",
      "obj/App.csproj": "",
      ".cache/package.json": "{}",
      "app/package.json": { devDependencies: { vitest: "1" } },
    },
    ["node"],
    [["app", ["node"]]],
    { test: [["app", "npx --no -- vitest related --run --passWithNoTests {files}"]] },
    [],
  ],
  [
    "a package inherits the root's lockfile",
    { "pnpm-lock.yaml": "", "apps/web/package.json": { devDependencies: { vitest: "1" } } },
    ["node"],
    [["apps/web", ["node"]]],
    { test: [["apps/web", "pnpm exec vitest related --run --passWithNoTests {files}"]] },
    [/\[apps\/web\] Package manager: pnpm \(from its lockfile\)/],
  ],
  [
    "a nested package of the root's stack is left out: the root's commands already see it",
    { "package.json": { devDependencies: { vitest: "1", eslint: "9" } }, "eslint.config.js": "", "e2e/package.json": { devDependencies: { vitest: "1" } } },
    ["node"],
    [[".", ["node"]]],
    {
      lint: [[".", "npx --no -- eslint --no-warn-ignored {files}"]],
      test: [[".", "npx --no -- vitest related --run --passWithNoTests {files}"]],
    },
    [/Left out e2e: a node project like the root/, /pass `--packages` with the root/],
  ],
  [
    "a bare workspace root covers nothing: every package gets its own commands",
    {
      "package.json": { private: true },
      "packages/a/package.json": { devDependencies: { vitest: "1" } },
      "apps/web/package.json": { devDependencies: { vitest: "1" } },
    },
    ["node"],
    [
      [".", ["node"]],
      ["apps/web", ["node"]],
      ["packages/a", ["node"]],
    ],
    {
      test: [
        ["apps/web", "npx --no -- vitest related --run --passWithNoTests {files}"],
        ["packages/a", "npx --no -- vitest related --run --passWithNoTests {files}"],
      ],
    },
    [/Monorepo: found 3 packages/],
  ],
  [
    "a root with only lint does not cover a package's tests",
    { "package.json": { devDependencies: { eslint: "9" } }, "eslint.config.js": "", "web/package.json": { devDependencies: { vitest: "1" } } },
    ["node"],
    [
      [".", ["node"]],
      ["web", ["node"]],
    ],
    {
      // web inherits the root's eslint config, so it lints too; the overlap note says so.
      lint: [
        [".", "npx --no -- eslint --no-warn-ignored {files}"],
        ["web", "npx --no -- eslint --no-warn-ignored {files}"],
      ],
      test: [["web", "npx --no -- vitest related --run --passWithNoTests {files}"]],
    },
    [/The root and web are both node projects/],
  ],
  [
    "a Rust crate with a nested fuzz crate stays one crate",
    { "Cargo.toml": '[package]\nname = "x"\nedition = "2021"\n', "fuzz/Cargo.toml": '[package]\nname = "x-fuzz"\n' },
    ["rust"],
    [[".", ["rust"]]],
    {
      format: [[".", "rustfmt --edition 2021"]],
      lint: [[".", "cargo clippy"]],
      typecheck: [[".", "cargo check"]],
    },
    [/Left out fuzz: a rust project like the root/],
  ],
  [
    "a root solution with src/ and tests/ projects is one dotnet test, not three",
    { "App.sln": "", "src/App.csproj": "", "tests/App.Tests.csproj": "" },
    ["dotnet"],
    [[".", ["dotnet"]]],
    { test: [[".", "dotnet test"]] },
    [/Left out src, tests: dotnet projects like the root, whose commands already see their files/],
  ],
  [
    "a root of one stack keeps packages of other stacks",
    { "go.mod": "module x\n", "web/package.json": { devDependencies: { vitest: "1" } }, "tools/go.mod": "module t\n" },
    ["go", "node"],
    [
      [".", ["go"]],
      ["web", ["node"]],
    ],
    {
      format: [[".", "gofmt -w"]],
      typecheck: [[".", "go vet {dirs}"]],
      test: [
        [".", "go test {dirs}"],
        ["web", "npx --no -- vitest related --run --passWithNoTests {files}"],
      ],
    },
    [/Monorepo: found 2 packages: \. \(go\), web \(node\)/, /Left out tools: a go project like the root/],
  ],
  [
    ".NET: a solution",
    { "App.sln": "" },
    ["dotnet"],
    [[".", ["dotnet"]]],
    { test: [[".", "dotnet test"]] },
    [/`dotnet test` has no related-test mode: it builds and runs every test/, /Optional, not proposed: `dotnet build`/],
  ],
  [".NET: an .slnx solution", { "App.slnx": "" }, ["dotnet"], [[".", ["dotnet"]]], { test: [[".", "dotnet test"]] }, []],
  [".NET: a lone project", { "App.csproj": "" }, ["dotnet"], [[".", ["dotnet"]]], { test: [[".", "dotnet test"]] }, []],
  [
    ".NET: a solution and a project in one directory need an explicit target",
    { "B.sln": "", "A.sln": "", "A.csproj": "" },
    ["dotnet"],
    [[".", ["dotnet"]]],
    { test: [[".", "dotnet test A.sln"]] },
    [/MSB1011.*names A\.sln/],
  ],
  [
    ".NET: global.json with the Microsoft.Testing.Platform runner",
    { "App.sln": "", "global.json": '{ "test": { "runner": "Microsoft.Testing.Platform" } }' },
    ["dotnet"],
    [[".", ["dotnet"]]],
    { test: [[".", "dotnet test"]] },
    [/Microsoft\.Testing\.Platform runner.*--solution/],
  ],
];

for (const [name, files, stacks, packages, expected, notePatterns] of CASES) {
  test(`detectProject: ${name}`, () => {
    const d = detectProject(fixture(files));
    assert.deepEqual(d.stacks, stacks);
    assert.deepEqual(
      d.packages.map((p) => [p.path, p.stacks]),
      packages,
    );
    assert.deepEqual(shape(d.verify), expected);
    for (const re of notePatterns) assert.ok(d.notes.some((n) => re.test(n)), `a note matches ${re}: ${JSON.stringify(d.notes)}`);
    if (name.startsWith("a bare workspace root")) assert.ok(!d.notes.some((n) => /may run twice/.test(n)), "a root with no commands overlaps nothing");
    // Every proposal is a valid config, and packages' entries all carry a cwd.
    assert.doesNotThrow(() => validateConfig({ verify: d.verify }));
    for (const e of Object.values(d.verify).flatMap(entries)) {
      if (e.cwd !== undefined) assert.ok(d.packages.some((p) => p.path === e.cwd), `cwd ${e.cwd} is a package`);
    }
  });
}

test("detectProject: a single stack keeps its plain, unwrapped entries", () => {
  const d = detectProject(fixture({ "go.mod": "module x\n" }));
  assert.deepEqual(d.verify.test, { run: "go test {dirs}", files: ["**/*.go"] });
  assert.equal(d.verify.test.cwd, undefined);
});

test("detectProject: package entries keep their file filters and gain the package as cwd", () => {
  const { verify } = detectProject(fixture(ONLAH));
  const web = verify.test.find((e) => e.cwd === "apps/web");
  assert.deepEqual(web.files, ["**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs", "**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"]);
  assert.deepEqual(verify.test.find((e) => e.cwd === "apps/backend").files, DOTNET);
});

test("detectProject: only keeps the named packages, and says about ones it can't find", () => {
  const root = fixture(ONLAH);
  const d = detectProject(root, { only: ["apps/web", "apps/nope"] });
  assert.deepEqual(d.packages.map((p) => p.path), ["apps/web"]);
  assert.deepEqual(shape(d.verify), {
    test: [["apps/web", "npx --no -- vitest related --run --passWithNoTests {files}"]],
    typecheck: [["apps/web", "npx --no -- tsc --noEmit"]],
  });
  assert.ok(d.notes.some((n) => /No package found at apps\/nope; found: apps\/backend, apps\/mobile, apps\/web/.test(n)));
  assert.ok(!d.notes.some((n) => /Ask the user which packages/.test(n)), "already chosen");

  const none = detectProject(root, { only: ["nope"] });
  assert.deepEqual(none.verify, {});
  assert.ok(none.notes.some((n) => /No supported stack found/.test(n)));
});

test("detectProject: a package that is a symlink is not followed", () => {
  const root = fixture({ "real/package.json": { devDependencies: { vitest: "1" } } });
  symlinkSync(join(root, "real"), join(root, "link"));
  assert.deepEqual(detectProject(root).packages.map((p) => p.path), ["real"]);
});

test("detectProject: a package whose manifest yields no commands is still listed, with its notes", () => {
  const d = detectProject(fixture({ "tools/package.json": {} }));
  assert.deepEqual(d.packages, [{ path: "tools", stacks: ["node"] }]);
  assert.deepEqual(d.verify, {});
  assert.ok(d.notes.some((n) => /\[tools\] No related-test command/.test(n)));
});

test("detectProject: --packages keeps a package the root covers, with the overlap note", () => {
  const root = fixture({ "App.sln": "", "src/App.csproj": "", "tests/App.Tests.csproj": "" });
  const d = detectProject(root, { only: [".", "src"] });
  assert.deepEqual(shape(d.verify), { test: [[".", "dotnet test"], ["src", "dotnet test"]] });
  assert.ok(d.notes.some((n) => /The root and src are both dotnet projects/.test(n)), JSON.stringify(d.notes));
  // Only the package: no root entry at all.
  assert.deepEqual(shape(detectProject(root, { only: ["tests"] }).verify), { test: [["tests", "dotnet test"]] });
});

const files2 = () => Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`services/p${String(i).padStart(2, "0")}/go.mod`, "module x\n"]));

test("detectProject: more than 40 packages are capped, with a note", () => {
  const d = detectProject(fixture(files2()));
  assert.equal(d.packages.length, 40);
  assert.ok(d.notes.some((n) => /Found 45 packages; only the first 40/.test(n)));
  // An explicit choice reaches a package past the cap.
  assert.deepEqual(detectProject(fixture(files2()), { only: ["services/p44"] }).packages.map((p) => p.path), ["services/p44"]);
});

// ---------------------------------------------------------------- cwd in the runtime

// [name, entry, changed files, expected command, file count, cwd]
const PLANS = [
  ["files are relative to cwd", { run: "t {files}", cwd: "apps/web" }, ["apps/web/src/a.ts", "apps/mobile/b.ts"], "t src/a.ts", 1, "apps/web"],
  ["the filter globs see cwd-relative paths", { run: "t {files}", files: ["src/**/*.ts"], cwd: "apps/web" }, ["apps/web/src/a.ts", "apps/web/README.md"], "t src/a.ts", 1, "apps/web"],
  ["a root-anchored glob matches nothing outside it", { run: "t {files}", files: ["**/*.ts"], cwd: "apps/web" }, ["apps/mobile/b.ts"], null],
  ["{dirs} are relative to cwd", { run: "go test {dirs}", cwd: "svc" }, ["svc/a/x.go", "svc/y.go"], "go test ./a .", 2, "svc"],
  ["a whole-project command runs once something under cwd changed", { run: "dotnet test", cwd: "apps/backend" }, ["apps/backend/A.cs"], "dotnet test", undefined, "apps/backend"],
  ["a whole-project command is skipped when only other paths changed", { run: "dotnet test", cwd: "apps/backend" }, ["apps/web/a.ts", "apps/backendish/x.cs"], null],
  ["a whole-project command with a filter needs a matching file", { run: "dotnet test", files: ["**/*.cs"], cwd: "apps/backend" }, ["apps/backend/README.md"], null],
  ["a filter matches a file directly in cwd", { run: "dotnet test", files: DOTNET, cwd: "apps/backend" }, ["apps/backend/Program.cs"], "dotnet test", undefined, "apps/backend"],
  ["a file named like cwd is not below it", { run: "t {files}", cwd: "apps" }, ["apps"], null],
  ["with no cwd nothing changes", { run: "t {files}" }, ["a/b.ts"], "t a/b.ts", 1, undefined],
];

for (const [name, entry, files, command, fileCount, cwd] of PLANS) {
  test(`planStage with cwd: ${name}`, () => {
    const plan = planStage("test", entry, files);
    if (command === null) return assert.equal(plan, null);
    assert.equal(plan.command, command);
    assert.equal(plan.fileCount, fileCount);
    assert.equal(plan.cwd, cwd);
  });
}

test("planStage with cwd: format appends cwd-relative paths", () => {
  assert.equal(planStage("format", { run: "prettier -w", cwd: "web" }, ["web/a.ts", "api/b.ts"]).command, "prettier -w a.ts");
});

/** A committed project with two apps and a root README. */
function packagesProject(verify) {
  const root = makeRepo({ verify }, { "apps/web/src/a.ts": "a\n", "apps/mobile/src/b.ts": "b\n", "README.md": "x\n" });
  return { root, config: loadConfig(root) };
}
test("runStage runs each entry in its own directory with cwd-relative paths, in order", async () => {
  const { config } = packagesProject({
    test: [
      { run: `node -e "console.log('web', process.cwd().endsWith('apps/web'), process.argv[1])" {files}`, cwd: "apps/web" },
      { run: `node -e "console.log('mobile', process.cwd().endsWith('apps/mobile'), process.argv[1])" {files}`, cwd: "apps/mobile" },
    ],
  });
  const r = await runStage("test", config, ["apps/mobile/src/b.ts", "apps/web/src/a.ts"]);
  assert.equal(r.ok, true);
  assert.equal(r.fileCount, 2);
  assert.equal(r.commands.length, 2);
  assert.match(r.commands[0], /^\(in apps\/web\) node -e .* src\/a\.ts$/);
  assert.match(r.commands[1], /^\(in apps\/mobile\) node -e .* src\/b\.ts$/);
});

test("runStage skips entries with nothing under their cwd, and the whole stage when none ran", async () => {
  const { config } = packagesProject({
    test: [
      { run: "exit 1", cwd: "apps/web" },
      { run: "exit 0", cwd: "apps/mobile" },
    ],
  });
  const only = await runStage("test", config, ["apps/mobile/src/b.ts"]);
  assert.equal(only.ok, true);
  assert.equal(only.skipped, false);
  assert.deepEqual(only.commands, ["(in apps/mobile) exit 0"]);
  const none = await runStage("test", config, ["README.md"]);
  assert.deepEqual([none.ok, none.skipped], [true, true]);
});

test("runStage stops at the first failing entry and names its package", async () => {
  const { config } = packagesProject({
    lint: [
      { run: "echo web-broke; exit 3", cwd: "apps/web" },
      { run: "echo SHOULD-NOT-RUN; exit 0", cwd: "apps/mobile" },
    ],
  });
  const r = await runStage("lint", config, ["apps/web/src/a.ts", "apps/mobile/src/b.ts"]);
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
  assert.equal(r.cwd, "apps/web");
  assert.match(r.output, /web-broke/);
  assert.doesNotMatch(r.output, /SHOULD-NOT-RUN/);
});

test("runStage's time limit covers all entries of a stage", async () => {
  const { config } = packagesProject({
    test: [
      { run: "sleep 0.4", cwd: "apps/web" },
      { run: "sleep 5", cwd: "apps/mobile" },
    ],
  });
  const started = Date.now();
  const r = await runStage("test", config, ["apps/web/src/a.ts", "apps/mobile/src/b.ts"], { timeoutMs: 1200 });
  assert.equal(r.timedOut, true);
  assert.equal(r.cwd, "apps/mobile");
  assert.ok(Date.now() - started < 4000, "did not wait for the second entry's full sleep");
});

test("a root entry and package entries mix in one stage", async () => {
  const { config } = packagesProject({
    format: ["echo root-fmt", { run: "echo web-fmt", cwd: "apps/web" }],
  });
  const r = await runStage("format", config, ["apps/web/src/a.ts"]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.commands, ["echo root-fmt apps/web/src/a.ts", "(in apps/web) echo web-fmt src/a.ts"]);
});

// ---------------------------------------------------------------- policies

test("verify-gate runs a package's command from its directory and blocks naming it", async () => {
  const root = makeRepo(
    { verify: { test: [{ run: "node -e \"process.exit(require('fs').existsSync('marker') ? 0 : 1)\"", cwd: "apps/web" }] } },
    { "apps/web/src/a.ts": "a\n", "apps/mobile/b.ts": "b\n" },
  );
  writeFile(root, "apps/mobile/b.ts", "changed\n");
  const untouched = await verifyGate({ session_id: "s", cwd: root }, loadConfig(root), { log() {} });
  assert.equal(untouched.kind, "notice");
  assert.match(untouched.text, /no checks ran \(test skipped\)/);

  writeFile(root, "apps/web/src/a.ts", "changed\n");
  const blocked = await verifyGate({ session_id: "s", cwd: root }, loadConfig(root), { log() {} });
  assert.equal(blocked.kind, "block");
  assert.match(blocked.reason, /^Command: \(in apps\/web\) node -e /m);

  writeFile(root, "apps/web/marker", "");
  const passed = await verifyGate({ session_id: "s", cwd: root }, loadConfig(root), { log() {} });
  assert.equal(passed.kind, "notice");
  assert.match(passed.text, /test ✓/);
});

test("session-context lists every entry of a stage with its directory and filter", async () => {
  const root = makeRepo({
    verify: {
      test: [
        { run: "dotnet test", files: ["**/*.cs"], cwd: "apps/backend" },
        { run: "vitest related --run {files}", cwd: "apps/web" },
      ],
      lint: "eslint .",
    },
  });
  const v = await sessionContext({ cwd: root, source: "startup" }, loadConfig(root));
  assert.match(v.text, /^- test: dotnet test \(in apps\/backend; only for \*\*\/\*\.cs\)$/m);
  assert.match(v.text, /^- test: vitest related --run \{files\} \(in apps\/web\)$/m);
  assert.match(v.text, /^- lint: eslint \.$/m);
});

// ---------------------------------------------------------------- CLI

function cli(cwd, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const monorepo = () => makeRepo(undefined, Object.fromEntries(Object.entries(ONLAH).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])));

test("init in a monorepo with no root manifest proposes per-package commands and lists the packages", async () => {
  const root = monorepo();
  const r = await cli(root, "init");
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.stacks, ["dotnet", "node"]);
  assert.deepEqual(out.packages.map((p) => p.path), ["apps/backend", "apps/mobile", "apps/web"]);
  assert.deepEqual(out.config.verify.test.map((e) => e.cwd), ["apps/backend", "apps/mobile", "apps/web"]);
  assert.ok(out.notes.some((n) => /Monorepo: found 3 packages/.test(n)));
});

test("init --packages keeps only the named packages; --write stores them and CLAUDE.md lists each", async () => {
  const root = monorepo();
  const dry = JSON.parse((await cli(root, "init", "--packages", "apps/web,./apps/backend/")).stdout);
  assert.deepEqual(dry.packages.map((p) => p.path), ["apps/backend", "apps/web"]);

  const w = await cli(root, "init", "--write", "--packages", "apps/web,apps/backend");
  assert.equal(w.code, 0, w.stderr);
  assert.match(w.stdout, /\/reload-plugins/);
  const config = loadConfig(root);
  assert.deepEqual(entries(config.verify.test).map((e) => e.cwd), ["apps/backend", "apps/web"]);
  assert.equal(config.verify.typecheck.cwd, "apps/web");
  const claude = readFileSync(join(root, "CLAUDE.md"), "utf8");
  assert.match(claude, /- Test:\n {2}- `dotnet test` \(in `apps\/backend`; only for `\*\*\/\*\.cs`, `\*\*\/\*\.razor`, `\*\*\/\*\.cshtml`, … 3 more\)\n {2}- `npx --no -- vitest related[^`]*` \(in `apps\/web`/);
  // Re-running is a no-op.
  const again = await cli(root, "init", "--write", "--packages", "apps/web,apps/backend");
  assert.match(again.stdout, /unchanged {2,}\.harness\/config\.json|unchanged\s+CLAUDE\.md/);
});

test("init --packages ./ means the root", async () => {
  const root = makeRepo(undefined, { "go.mod": "module x\n", "web/package.json": "{}" });
  const out = JSON.parse((await cli(root, "init", "--packages", "./")).stdout);
  assert.deepEqual(out.packages.map((p) => p.path), ["."]);
  assert.deepEqual(out.config.verify.test.cwd, undefined);
});

test("init in an empty repo still reports no stack and an empty verify config", async () => {
  const root = makeRepo(undefined, { "README.md": "hi\n" });
  const out = JSON.parse((await cli(root, "init")).stdout);
  assert.deepEqual([out.stacks, out.packages, out.config.verify], [[], [], {}]);
  assert.match(out.notes[0], /No supported stack found/);
});

test("verify runs a package's command from its directory through the CLI", async () => {
  const root = makeRepo(
    { verify: { test: [{ run: "node -e \"console.log('ran in', require('path').basename(process.cwd()))\"", cwd: "apps/web" }] } },
    { "apps/web/a.ts": "a\n", "x/b.ts": "b\n" },
  );
  writeFile(root, "apps/web/a.ts", "changed\n");
  const r = await cli(root, "verify");
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^ok {7}test: \(in apps\/web\) node -e /m);
  assert.match(r.stdout, /verify: passed/);
});
