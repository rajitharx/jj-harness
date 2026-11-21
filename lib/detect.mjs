// Stack detection for harness-init: read a project's manifests and propose
// related-only verify commands. Pure apart from reading files: no network,
// no commands run. Whether the tools are installed is checked later, by the
// harness-init skill trying each command once.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * A proposed `verify` entry in the config file's form: a string, or
 * `{ run, files, cwd }` when the command should only see matching files, or
 * run in a package directory. A stage holds one entry, or an array of them in
 * a repo with several packages.
 * @typedef {string | { run: string, files?: string[], cwd?: string }} ProposedCommand
 * @typedef {{ format?: ProposedCommand | ProposedCommand[], lint?: ProposedCommand | ProposedCommand[], typecheck?: ProposedCommand | ProposedCommand[], test?: ProposedCommand | ProposedCommand[] }} ProposedVerify
 * @typedef {{ path: string, stacks: string[] }} DetectedPackage  `path` is root-relative, `.` for the root.
 * @typedef {{ stacks: string[], packages: DetectedPackage[], verify: ProposedVerify, notes: string[] }} Detection
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
const DOTNET_FILES = ["**/*.cs", "**/*.razor", "**/*.cshtml", "**/*.csproj", "**/*.props", "**/*.targets"];
const CARGO_FILES = [...RUST_FILES, "**/Cargo.toml", "Cargo.lock"];

const STAGES = ["format", "lint", "typecheck", "test"];

// Directories never worth looking into for a package.
const SKIP_DIRS = new Set(["node_modules", "bin", "obj", "dist", "build", "out", "target", "vendor", "coverage", "venv", "__pycache__"]);
// Directories whose children are packages too (one level deeper).
const CONTAINER_DIRS = ["apps", "packages", "services"];
const MAX_PACKAGES = 40;

/**
 * Detect the project's stacks and propose verify commands.
 *
 * The root and every package directory are looked at the same way. A package
 * is an immediate subdirectory of the root, or an immediate subdirectory of
 * `apps/`, `packages/` or `services/`, that holds a manifest. Within one
 * directory, stacks are not merged: one verify entry has one command and one
 * file filter, so it can't express "eslint for .ts and ruff for .py". The
 * directory's primary stack is the first, in the order node, python, go, rust,
 * dotnet, that yields any command; the others are reported in `notes` with
 * their commands.
 *
 * Across directories, commands are merged per stage: the root's stay as they
 * are, and each package's get `cwd` set to the package, so they run there and
 * see only its files. A repo with a single stack at the root gets exactly the
 * proposal it always did.
 * @param {string} root  Project root.
 * @param {{ only?: string[] }} [options]  `only`: keep just these packages (root-relative paths, `.` for the root).
 * @returns {Detection}
 */
export function detectProject(root, { only } = {}) {
  const top = scan(root);
  const rootResult = analyze(top);
  const packages = packageDirs(root)
    .map((path) => ({ path, ...analyze(scan(join(root, path), top)) }))
    .filter((p) => p.found.length > 0);

  if (packages.length === 0 && !only) {
    if (!rootResult.primary) return { stacks: [], packages: [], verify: {}, notes: [NO_STACK_NOTE] };
    return {
      stacks: rootResult.found.map((s) => s.stack),
      packages: [{ path: ".", stacks: rootResult.found.map((s) => s.stack) }],
      verify: rootResult.primary.verify,
      notes: rootResult.notes,
    };
  }

  const units = [...(rootResult.found.length ? [{ path: ".", ...rootResult }] : []), ...packages];
  const notes = [];
  let chosen;
  if (only) {
    // An explicit choice is taken as it is, even a package the root already covers.
    chosen = units.filter((u) => only.includes(u.path));
    const unknown = only.filter((p) => !units.some((u) => u.path === p));
    if (unknown.length) notes.push(`No package found at ${unknown.join(", ")}; found: ${units.map((u) => u.path).join(", ") || "none"}.`);
  } else {
    // A package of the root's own stack (a nested docs/ or fuzz/ project, the projects of a
    // solution) is covered by the root's commands, which have no cwd and see every file.
    const rootStack = rootResult.primary?.stack;
    // Only when the root really proposes those stages: a bare workspace root with no tools of its own covers nothing.
    const rootVerify = rootResult.primary?.verify ?? {};
    const covered = packages.filter(
      (p) => p.primary && p.primary.stack === rootStack && STAGES.every((st) => !p.primary.verify[st] || rootVerify[st]),
    );
    chosen = units.filter((u) => !covered.includes(u));
    if (covered.length) {
      const many = covered.length > 1;
      notes.push(
        `Left out ${covered.map((p) => p.path).join(", ")}: ${many ? "" : "a "}${rootStack} project${many ? "s" : ""} like the root, whose commands already see ${many ? "their" : "its"} files, so ${many ? "they" : "it"} would run the same checks twice. ` +
          `To check ${many ? "them" : "it"} separately, pass \`--packages\` with the root (\`.\`) and ${many ? "their paths" : "its path"}.`,
      );
    }
    if (chosen.length > MAX_PACKAGES) {
      notes.push(`Found ${chosen.length} packages; only the first ${MAX_PACKAGES} are proposed. Pass \`--packages\` to choose others.`);
      chosen = chosen.slice(0, MAX_PACKAGES);
    }
  }
  if (chosen.length === 0) return { stacks: [], packages: [], verify: {}, notes: [...notes, NO_STACK_NOTE] };

  if (chosen.some((u) => u.path !== ".")) {
    notes.unshift(
      `Monorepo: found ${chosen.length} package${chosen.length === 1 ? "" : "s"}: ${chosen.map((u) => `${u.path} (${u.found.map((s) => s.stack).join(", ")})`).join(", ")}. ` +
        "Each package's commands run in its own directory (`cwd`), get only its changed files (`{files}`, `{dirs}` and `files` globs are relative to it), and are skipped when nothing under it changed. " +
        (only ? "" : "Ask the user which packages the Stop gate should check, then re-run `init --packages <paths>` with those."),
    );
  }
  /** @type {Record<string, ProposedCommand[]>} */
  const stages = {};
  for (const u of chosen) {
    const inRoot = u.path === ".";
    notes.push(...u.notes.map((n) => (inRoot ? n : `[${u.path}] ${n}`)));
    for (const stage of STAGES) {
      const entry = u.primary?.verify[stage];
      if (entry) (stages[stage] ??= []).push(inRoot ? entry : inDir(entry, u.path));
    }
  }
  // Only with an explicit --packages: a root project's commands have no `cwd`, so they also see every package's files.
  const rootUnit = chosen.find((u) => u.path === "." && u.primary && Object.keys(u.primary.verify).length > 0);
  for (const u of chosen) {
    if (u === rootUnit || !u.primary || u.primary.stack !== rootUnit?.primary.stack) continue;
    notes.push(
      `The root and ${u.path} are both ${u.primary.stack} projects: the root's commands also see ${u.path}'s files, so they may run twice. Drop one of the two if that is not wanted.`,
    );
  }
  const verify = Object.fromEntries(Object.entries(stages).map(([k, list]) => [k, list.length === 1 ? list[0] : list]));
  return {
    stacks: [...new Set(chosen.flatMap((u) => u.found.map((s) => s.stack)))],
    packages: chosen.map((u) => ({ path: u.path, stacks: u.found.map((s) => s.stack) })),
    verify,
    notes,
  };
}

const NO_STACK_NOTE =
  "No supported stack found (looked in the root, its subdirectories and apps/*, packages/*, services/* for package.json, pyproject.toml/setup.py/requirements*.txt, go.mod, Cargo.toml, *.sln/*.slnx/*.csproj). Ask the user for the format, lint, typecheck and test commands, preferring ones that take {files} or {dirs}.";

/** The stacks found in one directory, its primary stack, and the notes about them. */
function analyze(project) {
  const found = DETECTORS.map((d) => d(project)).filter(Boolean);
  const primary = found.find((s) => Object.keys(s.verify).length > 0) ?? found[0];
  if (!primary) return { found, primary, notes: [] };
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
  return { found, primary, notes };
}

/** A proposed entry, run in (and scoped to) the package at `path`. */
function inDir(entry, path) {
  return typeof entry === "string" ? { run: entry, cwd: path } : { ...entry, cwd: path };
}

/** Root-relative paths of the directories that may be packages: sorted, POSIX, symlinks and tool directories left out. */
function packageDirs(root) {
  const children = (rel) => {
    try {
      return readdirSync(join(root, rel), { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !SKIP_DIRS.has(d.name))
        .map((d) => (rel ? `${rel}/${d.name}` : d.name))
        .sort();
    } catch {
      return [];
    }
  };
  const top = children("");
  const deeper = top.filter((d) => CONTAINER_DIRS.includes(d)).flatMap(children);
  return [...new Set([...top, ...deeper])].sort();
}

/**
 * Read a directory's file names once; helpers read file contents lazily.
 * `hasUp` also looks in `parent`, for what a package inherits from the repo
 * root: lockfiles and tool configs.
 */
function scan(root, parent) {
  let names = [];
  try {
    names = readdirSync(root);
  } catch {
    // An unreadable directory detects nothing.
  }
  const has = (re) => names.some((n) => (typeof re === "string" ? n === re : re.test(n)));
  const read = (name) => {
    try {
      return readFileSync(join(root, name), "utf8");
    } catch {
      return "";
    }
  };
  return { root, names, has, hasUp: (re) => has(re) || (parent?.has(re) ?? false), read };
}

/** @param {ProposedVerify} verify */
function describe(verify) {
  return STAGES.filter((s) => verify[s])
    .map((s) => `${s} \`${typeof verify[s] === "string" ? verify[s] : verify[s].run}\``)
    .join(", ");
}

/** An entry with a filter, or a plain string without one. */
const cmd = (run, files) => (files ? { run, files } : run);

const DETECTORS = [detectNode, detectPython, detectGo, detectRust, detectDotnet];

function detectNode({ has, hasUp, read }) {
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
    dep in deps || (fileRe && hasUp(fileRe)) || (scriptRe && scriptRe.test(scripts)) || (pkgKey && pkgKey in pkg);

  const pm = hasUp("pnpm-lock.yaml") ? "pnpm" : hasUp("yarn.lock") ? "yarn" : hasUp(/^bun\.lockb?$/) ? "bun" : "npm";
  // `npx --no` never downloads a missing tool (the gate must not hit the network).
  // npm reads `--no` as taking a value, so `--` is required: without it the
  // tool's own flags (`--noEmit`, `--write`) are parsed by npm and dropped.
  const x = { pnpm: "pnpm exec", yarn: "yarn", bun: "bunx --no-install", npm: "npx --no --" }[pm];
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

  const eslintFlat = hasUp(/^eslint\.config\.(js|mjs|cjs|ts|mts|cts)$/);
  const eslintLegacy = hasUp(/^\.eslintrc/) || "eslintConfig" in pkg;
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

function detectRust({ root, has, read }) {
  if (!has("Cargo.toml")) return null;
  // rustfmt on the edited file, not `cargo fmt -- <file>` (which formats the whole
  // crate). rustfmt can't read Cargo.toml, so pass the crate's edition.
  const { edition, from } = rustEdition(root, read("Cargo.toml"));
  return {
    stack: "rust",
    manifest: "Cargo.toml",
    verify: {
      format: cmd(`rustfmt --edition ${edition}`, RUST_FILES),
      lint: cmd("cargo clippy", CARGO_FILES),
      typecheck: cmd("cargo check", CARGO_FILES),
    },
    notes: [
      `Format runs \`rustfmt --edition ${edition}\` (${from}) on the edited file; rustfmt also formats the out-of-line modules that file declares. Workspace members with a different edition need their own rustfmt.toml \`edition\`.`,
      "Rust has no related-test mode, so no test command is proposed. Ask the user whether to add one (e.g. `cargo test` for the whole suite, which the gate would then run on every stop); never add it silently.",
    ],
  };
}

function detectDotnet({ names, read }) {
  const solutions = names.filter((n) => /\.(sln|slnx)$/i.test(n)).sort();
  const projects = names.filter((n) => /\.csproj$/i.test(n)).sort();
  if (solutions.length === 0 && projects.length === 0) return null;
  // `dotnet test` with no argument needs exactly one project or solution file in the directory.
  const target = solutions[0] ?? projects[0];
  const ambiguous = solutions.length + projects.length > 1;
  const notes = [
    "`dotnet test` has no related-test mode: it builds and runs every test whenever a .cs, .csproj, .razor or props/targets file changes, and the Stop gate would run it on every stop. Confirm that with the user before keeping it; narrow it with a `--filter` expression, or drop the stage, if the suite is slow.",
    "Optional, not proposed: `dotnet build` as a typecheck, and `dotnet format --verify-no-changes` as a lint (both are slow, and `dotnet format` needs a project or solution argument).",
  ];
  if (ambiguous) {
    notes.push(
      `${[...solutions, ...projects].join(", ")} are all in this directory, so \`dotnet test\` alone would fail (MSB1011); the command names ${target}.`,
    );
  }
  if (/Microsoft\.Testing\.Platform/.test(read("global.json"))) {
    notes.push(
      "global.json selects the Microsoft.Testing.Platform runner. In that mode `dotnet test` takes `--solution` or `--project` instead of a bare path, so check the command with the user.",
    );
  }
  return {
    stack: "dotnet",
    manifest: target,
    verify: { test: cmd(ambiguous ? `dotnet test ${target}` : "dotnet test", DOTNET_FILES) },
    notes,
  };
}

/**
 * The edition rustfmt should use for the crate at `root`:
 * - `[package] edition`;
 * - when the package says `edition.workspace = true` (or
 *   `edition = { workspace = true }`), `[workspace.package] edition` from the
 *   workspace root: this manifest, the `package.workspace` path, or else the
 *   nearest parent Cargo.toml with a `[workspace]` table, as Cargo finds it;
 * - for a virtual manifest, its own `[workspace.package] edition`;
 * - 2021 when none is found.
 * @param {string} root
 * @param {string} manifest  The root Cargo.toml's text.
 * @returns {{ edition: string, from: string }}
 */
function rustEdition(root, manifest) {
  const own = cargoTables(manifest);
  const pkg = own.package;
  if (pkg && !inheritsEdition(pkg)) {
    const e = tomlEdition(pkg.edition);
    return e ? { edition: e, from: "from Cargo.toml" } : { edition: "2021", from: "default; Cargo.toml sets no edition" };
  }
  const ws = isWorkspace(own) ? { tables: own, path: "Cargo.toml" } : pkg ? findWorkspaceRoot(root, pkg.workspace) : null;
  const e = tomlEdition(ws?.tables["workspace.package"]?.edition);
  if (e) return { edition: e, from: `from [workspace.package] in ${ws.path}` };
  return {
    edition: "2021",
    from: pkg ? "default; the workspace edition was not found" : "default; Cargo.toml sets no edition",
  };
}

const tomlString = (v) => /^"([^"]*)"$|^'([^']*)'$/.exec(v ?? "")?.slice(1).find((s) => s !== undefined);
const tomlEdition = (v) => /^\d{4}$/.exec(tomlString(v) ?? "")?.[0];
const inheritsEdition = (pkg) =>
  pkg["edition.workspace"] === "true" || /^\{\s*workspace\s*=\s*true\s*\}$/.test(pkg.edition ?? "");
const isWorkspace = (tables) => Object.keys(tables).some((h) => h === "workspace" || h.startsWith("workspace."));

/**
 * The workspace root manifest for a member at `root`: the `package.workspace`
 * path if set, else the nearest parent directory whose Cargo.toml has a
 * `[workspace]` table. Path is relative to `root`, for the note.
 */
function findWorkspaceRoot(root, explicit) {
  const at = (dir) => {
    const text = readText(join(dir, "Cargo.toml"));
    if (text === null) return null;
    const tables = cargoTables(text);
    return isWorkspace(tables) ? { tables, path: relative(root, join(dir, "Cargo.toml")) } : null;
  };
  const path = tomlString(explicit);
  if (path) return at(resolve(root, path));
  for (let dir = dirname(resolve(root)); ; dir = dirname(dir)) {
    const found = at(dir);
    if (found || dirname(dir) === dir) return found;
  }
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Just enough TOML for Cargo.toml's simple keys: `{ "<table>": { "<key>": "<raw value>" } }`,
 * with top-level keys under "". Array tables (`[[bin]]`) and quoted headers
 * (`[target.'cfg(unix)'.dependencies]`) get a throwaway table, so their keys
 * never land in `package`.
 */
function cargoTables(text) {
  const tables = { "": {} };
  let current = tables[""];
  const dotted = /[\w-]+(?:\s*\.\s*[\w-]+)*/.source;
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw).trim();
    if (line.startsWith("[")) {
      const h = new RegExp(`^\\[\\s*(${dotted})\\s*\\]$`).exec(line);
      current = h ? (tables[h[1].replace(/\s+/g, "")] ??= {}) : {};
      continue;
    }
    const kv = new RegExp(`^(${dotted})\\s*=\\s*(.+)$`).exec(line);
    if (kv) current[kv[1].replace(/\s+/g, "")] = kv[2].trim();
  }
  return tables;
}

/**
 * `line` up to its first `#` outside a quoted string. Tracks basic ("…",
 * with `\` escapes) and literal ('…') strings on the line, so
 * `edition = "2018"#old` and `name = "a#b"` both read right.
 */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}

function objectOr(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
