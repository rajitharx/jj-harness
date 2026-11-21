// Stack detection for harness-init: read a project's manifests and propose
// related-only verify commands. Pure apart from reading files: no network,
// no commands run. Whether the tools are installed is checked later, by the
// harness-init skill trying each command once.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A proposed `verify` entry in the config file's form: a string, or
 * `{ run, files }` when the command should only see matching files.
 * @typedef {string | { run: string, files: string[] }} ProposedCommand
 * @typedef {{ format?: ProposedCommand, lint?: ProposedCommand, typecheck?: ProposedCommand, test?: ProposedCommand }} ProposedVerify
 * @typedef {{ stacks: string[], verify: ProposedVerify, notes: string[] }} Detection
 */

const JS_EXT = ["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"];
const JS_FILES = JS_EXT.map((e) => `**/*.${e}`);
const TS_PROJECT_FILES = [...JS_FILES, "**/tsconfig*.json"];
const BIOME_FILES = [...JS_FILES, "**/*.json", "**/*.jsonc", "**/*.css"];
// node --test's own default patterns, for .js/.mjs/.cjs.
const NODE_TEST_FILES = ["js", "mjs", "cjs"].flatMap((e) => [
  `**/*.test.${e}`,
  `**/*-test.${e}`,
  `**/*_test.${e}`,
  `**/test-*.${e}`,
  `**/test.${e}`,
  `**/test/**/*.${e}`,
]);
const PY_FILES = ["**/*.py", "**/*.pyi"];
const PY_TEST_FILES = ["**/test_*.py", "**/*_test.py"];
const GO_FILES = ["**/*.go"];
const RUST_FILES = ["**/*.rs"];
const CARGO_FILES = [...RUST_FILES, "**/Cargo.toml", "Cargo.lock"];

const STAGES = ["format", "lint", "typecheck", "test"];

/**
 * Detect the project's stacks and propose verify commands for the primary one.
 *
 * Multiple stacks are not merged: one verify entry has one command and one
 * file filter, so it can't express "eslint for .ts and ruff for .py". The
 * primary stack is the first, in the order node, python, go, rust, that
 * yields any command; the others are reported in `notes` with their commands.
 * @param {string} root  Project root.
 * @returns {Detection}
 */
export function detectProject(root) {
  const project = scan(root);
  const found = DETECTORS.map((d) => d(project)).filter(Boolean);
  const primary = found.find((s) => Object.keys(s.verify).length > 0) ?? found[0];
  if (!primary) {
    return {
      stacks: [],
      verify: {},
      notes: [
        "No supported stack found (looked for package.json, pyproject.toml/setup.py/requirements*.txt, go.mod, Cargo.toml). Ask the user for the format, lint, typecheck and test commands, preferring ones that take {files} or {dirs}.",
      ],
    };
  }
  const notes = [...primary.notes];
  for (const other of found) {
    if (other === primary) continue;
    const cmds = describe(other.verify);
    notes.push(
      `Also found a ${other.stack} project (${other.manifest}). Its commands are not in the proposal, because one verify entry can't hold two stacks' commands and filters` +
        (cmds ? `; it would use: ${cmds}` : "") +
        `. Ask the user which stack the gate should check.`,
      ...other.notes.map((n) => `(${other.stack}) ${n}`),
    );
  }
  return { stacks: found.map((s) => s.stack), verify: primary.verify, notes };
}

/** Read the root's file names once; helpers read file contents lazily. */
function scan(root) {
  let names = [];
  try {
    names = readdirSync(root);
  } catch {
    // An unreadable root detects nothing.
  }
  const has = (re) => names.some((n) => (typeof re === "string" ? n === re : re.test(n)));
  const read = (name) => {
    try {
      return readFileSync(join(root, name), "utf8");
    } catch {
      return "";
    }
  };
  return { root, names, has, read };
}

/** @param {ProposedVerify} verify */
function describe(verify) {
  return STAGES.filter((s) => verify[s])
    .map((s) => `${s} \`${typeof verify[s] === "string" ? verify[s] : verify[s].run}\``)
    .join(", ");
}

/** An entry with a filter, or a plain string without one. */
const cmd = (run, files) => (files ? { run, files } : run);

const DETECTORS = [detectNode, detectPython, detectGo, detectRust];

function detectNode({ has, read }) {
  if (!has("package.json")) return null;
  const notes = [];
  let pkg = {};
  try {
    pkg = JSON.parse(read("package.json")) ?? {};
  } catch (err) {
    notes.push(`package.json is not valid JSON (${err.message}); tools were detected from config files only.`);
  }
  if (typeof pkg !== "object" || Array.isArray(pkg)) pkg = {};
  const deps = { ...objectOr(pkg.dependencies), ...objectOr(pkg.devDependencies) };
  const scripts = Object.values(objectOr(pkg.scripts))
    .filter((s) => typeof s === "string")
    .join("\n");
  const uses = (dep, fileRe, scriptRe, pkgKey) =>
    dep in deps || (fileRe && has(fileRe)) || (scriptRe && scriptRe.test(scripts)) || (pkgKey && pkgKey in pkg);

  const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has(/^bun\.lockb?$/) ? "bun" : "npm";
  // `npx --no` never downloads a missing tool: the gate must not hit the network.
  const x = { pnpm: "pnpm exec", yarn: "yarn", bun: "bunx", npm: "npx --no" }[pm];
  notes.push(`Package manager: ${pm}${pm === "npm" ? "" : " (from its lockfile)"}; tools run through \`${x}\`.`);
  if (has("pnpm-workspace.yaml") || pkg.workspaces) {
    notes.push("This is a workspace (monorepo). Commands run from the root, so the root must be able to run each tool.");
  }

  const verify = {};
  const vitest = uses("vitest", /^vitest\.config\./, /\bvitest\b/);
  const jest = uses("jest", /^jest\.config\./, /\bjest\b/, "jest");
  const nodeTest = /\bnode\b[^\n]*--test\b/.test(scripts);
  if (vitest) verify.test = cmd(`${x} vitest related --run --passWithNoTests {files}`, JS_FILES);
  else if (jest) verify.test = cmd(`${x} jest --findRelatedTests --passWithNoTests {files}`, JS_FILES);
  else if (nodeTest) {
    verify.test = cmd("node --test {files}", NODE_TEST_FILES);
    notes.push(
      "node:test has no related-test mode: `node --test {files}` runs only the changed test files, not the tests of changed source files.",
    );
  } else {
    notes.push(
      "No related-test command: no vitest, jest or `node --test` found. Ask the user for a test command that takes {files}; never fall back to the full suite.",
    );
  }

  const eslintFlat = has(/^eslint\.config\.(js|mjs|cjs|ts|mts|cts)$/);
  const eslintLegacy = has(/^\.eslintrc/) || "eslintConfig" in pkg;
  const eslint = eslintFlat || eslintLegacy || uses("eslint", null, /\beslint\b/);
  const biome = uses("@biomejs/biome", /^biome\.jsonc?$/, /\bbiome\b/);
  if (eslint) {
    if (eslintLegacy && !eslintFlat) {
      verify.lint = cmd(`${x} eslint {files}`, JS_FILES);
      notes.push("ESLint uses a legacy .eslintrc config, so `--no-warn-ignored` (flat config only) is left out.");
    } else {
      verify.lint = cmd(`${x} eslint --no-warn-ignored {files}`, JS_FILES);
    }
    if (biome) notes.push("Both ESLint and Biome found; ESLint is used for lint.");
  } else if (biome) {
    verify.lint = cmd(`${x} biome lint --no-errors-on-unmatched {files}`, BIOME_FILES);
  }

  if (uses("prettier", /^(\.prettierrc|prettier\.config\.)/, /\bprettier\b/, "prettier")) {
    // --ignore-unknown: any edited file can be passed, prettier skips what it can't parse.
    verify.format = `${x} prettier --write --ignore-unknown`;
  } else if (biome) {
    verify.format = cmd(`${x} biome format --write --no-errors-on-unmatched`, BIOME_FILES);
  }

  if (has("tsconfig.json")) verify.typecheck = cmd(`${x} tsc --noEmit`, TS_PROJECT_FILES);

  return { stack: "node", manifest: "package.json", verify, notes };
}

function detectPython({ names, has, read }) {
  const manifests = ["pyproject.toml", "setup.py", "setup.cfg", "Pipfile", "uv.lock", "poetry.lock"].filter((n) => has(n));
  // Every root requirements file, e.g. requirements.txt and requirements-dev.txt.
  const requirements = names.filter((n) => /^requirements.*\.txt$/.test(n)).sort();
  if (manifests.length === 0 && requirements.length === 0) return null;
  const text = [...manifests.filter((n) => !n.endsWith(".lock")), ...requirements, "tox.ini"].map(read).join("\n");
  const dep = (name) => new RegExp(`(?<![\\w.-])${name.replace(/[-.]/g, "\\$&")}(?![\\w-])`, "i").test(text);
  const notes = [];

  const runner = has("uv.lock") ? "uv run " : has("poetry.lock") ? "poetry run " : "";
  if (runner) notes.push(`Tools run through \`${runner.trim()}\` (from ${has("uv.lock") ? "uv.lock" : "poetry.lock"}).`);

  const verify = {};
  const pytest =
    dep("pytest") ||
    /\[tool\.pytest|\[tool:pytest\]|^\[pytest\]/m.test(text) ||
    has("pytest.ini") ||
    has("conftest.py");
  if (dep("pytest-testmon")) {
    verify.test = cmd(`${runner}pytest --testmon`, PY_FILES);
    notes.push("pytest-testmon picks the tests affected by changed code; its first run executes everything to build .testmondata.");
  } else if (pytest) {
    verify.test = cmd(`${runner}pytest {files}`, PY_TEST_FILES);
    notes.push(
      "pytest has no related-test mode: `pytest {files}` runs only changed test files. Add pytest-testmon for tests related to changed source.",
    );
  } else {
    notes.push("No pytest found. Ask the user for a test command that takes {files}; never fall back to the full suite.");
  }

  if (dep("ruff") || /\[tool\.ruff/.test(text) || has("ruff.toml") || has(".ruff.toml")) {
    // --force-exclude: keep the project's `exclude` even for files passed by name.
    verify.lint = cmd(`${runner}ruff check --force-exclude {files}`, PY_FILES);
    verify.format = cmd(`${runner}ruff format --force-exclude`, PY_FILES);
  }

  if (dep("mypy") || /\[tool\.mypy|^\[mypy\]/m.test(text) || has("mypy.ini") || has(".mypy.ini")) {
    verify.typecheck = cmd(`${runner}mypy .`, PY_FILES);
  } else if (dep("pyright") || /\[tool\.pyright/.test(text) || has("pyrightconfig.json")) {
    verify.typecheck = cmd(`${runner}pyright`, PY_FILES);
  }

  return { stack: "python", manifest: manifests[0] ?? requirements[0], verify, notes };
}

function detectGo({ has }) {
  if (!has("go.mod")) return null;
  const verify = {
    format: cmd("gofmt -w", GO_FILES),
    typecheck: cmd("go vet {dirs}", GO_FILES),
    test: cmd("go test {dirs}", GO_FILES),
  };
  if (has(/^\.golangci\.(ya?ml|toml|json)$/)) verify.lint = cmd("golangci-lint run {dirs}", GO_FILES);
  const notes = ["`go test {dirs}` tests only the packages with changed files, not packages that import them."];
  return { stack: "go", manifest: "go.mod", verify, notes };
}

function detectRust({ has }) {
  if (!has("Cargo.toml")) return null;
  return {
    stack: "rust",
    manifest: "Cargo.toml",
    verify: {
      format: cmd("cargo fmt --", RUST_FILES),
      lint: cmd("cargo clippy", CARGO_FILES),
      typecheck: cmd("cargo check", CARGO_FILES),
    },
    notes: [
      "Rust has no related-test mode, so no test command is proposed. Ask the user whether to add one (e.g. `cargo test` for the whole suite, which the gate would then run on every stop); never add it silently.",
    ],
  };
}

function objectOr(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
