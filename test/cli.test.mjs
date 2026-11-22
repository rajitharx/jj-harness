import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../lib/config.mjs";
import { recordMetric } from "../lib/metrics.mjs";
import { git, makeRepo, writeFile } from "./helpers.mjs";

const CLI = fileURLToPath(new URL("../bin/harness.mjs", import.meta.url));

/** Spawn the CLI in `cwd`; resolves with { code, stdout, stderr }. */
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

/** A committed node project the detector recognises (vitest + tsconfig). */
function nodeRepo(extra = {}) {
  return makeRepo(undefined, {
    "package.json": JSON.stringify({ name: "app", devDependencies: { vitest: "1" } }),
    "tsconfig.json": "{}",
    ...extra,
  });
}

/** Every file under root except .git, with its content. */
function snapshot(root) {
  const files = {};
  const walk = (dir) => {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (rel === ".git") continue;
      if (e.isDirectory()) walk(rel);
      else files[rel] = readFileSync(join(root, rel), "utf8");
    }
  };
  walk("");
  return files;
}

test("init without --write prints the proposal and writes nothing", async () => {
  const root = nodeRepo();
  const before = snapshot(root);
  const r = await cli(root, "init");
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.stacks, ["node"]);
  assert.equal(out.config.verify.test.run, "npx --no -- vitest related --run --passWithNoTests {files}");
  assert.equal(out.config.stopGate.enabled, true, "built on templates/config.json");
  assert.ok(out.notes.length > 0);
  assert.deepEqual(
    out.changes.map((c) => [c.path, c.action]),
    [
      [".harness/config.json", "would create"],
      ["CLAUDE.md", "would create"],
      ["AGENTS.md", "would create"],
      [".harness/progress.md", "would create"],
    ],
  );
  assert.deepEqual(snapshot(root), before);
});

test("init --write creates the files and is idempotent", async () => {
  const root = nodeRepo();
  const first = await cli(root, "init", "--write");
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /^created   \.harness\/config\.json$/m);
  assert.match(first.stdout, /^created   CLAUDE\.md$/m);
  assert.match(first.stdout, /^created   AGENTS\.md$/m);
  assert.match(first.stdout, /^created   \.harness\/progress\.md$/m);

  const config = loadConfig(root);
  assert.equal(config.verify.test.run, "npx --no -- vitest related --run --passWithNoTests {files}");
  const claude = readFileSync(join(root, "CLAUDE.md"), "utf8");
  const name = root.split("/").pop();
  assert.ok(claude.startsWith(`# ${name}\n`), "project name filled");
  assert.match(claude, /- Test: `npx --no -- vitest related --run --passWithNoTests \{files\}` \(only for `\*\*\/\*\.js`/);
  assert.match(claude, /- Format: not configured/);
  assert.doesNotMatch(claude, /\{\{/, "every placeholder filled");
  assert.match(readFileSync(join(root, "AGENTS.md"), "utf8"), /\[CLAUDE\.md\]\(CLAUDE\.md\)/);

  const before = snapshot(root);
  const second = await cli(root, "init", "--write");
  assert.equal(second.code, 0, second.stderr);
  assert.equal((second.stdout.match(/^unchanged/gm) ?? []).length, 4, second.stdout);
  assert.match(second.stdout, /^unchanged \.harness\/config\.json$/m, "the action and the path are separated");
  assert.deepEqual(snapshot(root), before);
});

test("init --write merges a marker block into existing CLAUDE.md and AGENTS.md, keeping user content byte for byte", async () => {
  const userClaude = "# My project\r\n\r\nHand-written rules. Keep `{{these}}` braces.\r\n<!-- not a harness marker -->"; // no trailing newline
  const userAgents = "# Agents\n\nUse tabs.\n";
  const root = nodeRepo({ "CLAUDE.md": userClaude, "AGENTS.md": userAgents });

  const r = await cli(root, "init", "--write");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^updated   CLAUDE\.md \(appended the harness block\)$/m);
  const claude = readFileSync(join(root, "CLAUDE.md"), "utf8");
  assert.ok(claude.startsWith(`${userClaude}\n\n<!-- harness:start -->`), "user content kept, block appended");
  assert.ok(claude.endsWith("<!-- harness:end -->\n"));
  assert.doesNotMatch(claude, /## Project notes/, "only the block is merged, not the whole template");
  assert.ok(readFileSync(join(root, "AGENTS.md"), "utf8").startsWith(`${userAgents}\n<!-- harness:start -->`));

  // Edit around the block, then change the config: only the block is replaced.
  const edited = claude.replace("<!-- harness:start -->", "Before the block.\n<!-- harness:start -->") + "After the block.\n";
  writeFile(root, "CLAUDE.md", edited);
  const custom = JSON.parse(readFileSync(join(root, ".harness/config.json"), "utf8"));
  custom.verify.lint = { run: "npx --no -- eslint {files}", files: ["**/*.ts"] };
  writeFile(root, ".harness/config.json", JSON.stringify(custom));

  const again = await cli(root, "init", "--write");
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /^kept      \.harness\/config\.json/m);
  assert.match(again.stdout, /^updated   CLAUDE\.md \(replaced the harness block\)$/m);
  const merged = readFileSync(join(root, "CLAUDE.md"), "utf8");
  const [head] = edited.split("<!-- harness:start -->");
  const [, rest] = edited.split("<!-- harness:end -->");
  assert.ok(merged.startsWith(`${head}<!-- harness:start -->`), "text before the block untouched");
  assert.ok(merged.endsWith(`<!-- harness:end -->${rest}`), "text after the block untouched");
  assert.match(merged, /- Lint: `npx --no -- eslint \{files\}` \(only for `\*\*\/\*\.ts`\)/, "block describes the kept config");
});

test("init --write refuses broken markers and writes nothing", async () => {
  const root = nodeRepo({ "CLAUDE.md": "# x\n<!-- harness:end -->\n<!-- harness:start -->\n" });
  const before = snapshot(root);
  const r = await cli(root, "init", "--write");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /refused  CLAUDE\.md/);
  assert.match(r.stderr, /Nothing was written/);
  assert.deepEqual(snapshot(root), before);
});

test("init --write keeps an existing config unless --force-config", async () => {
  const mine = `{ "verify": { "test": "make test-related FILES={files}" } }\n`;
  const root = nodeRepo({ ".harness/config.json": mine });

  const dry = JSON.parse((await cli(root, "init")).stdout);
  assert.equal(dry.changes[0].action, "would keep");

  const kept = await cli(root, "init", "--write");
  assert.equal(kept.code, 0, kept.stderr);
  assert.match(kept.stdout, /^kept      \.harness\/config\.json \(exists and differs from the proposal; pass --force-config to replace it\)$/m);
  assert.equal(readFileSync(join(root, ".harness/config.json"), "utf8"), mine, "byte-identical");
  assert.match(readFileSync(join(root, "CLAUDE.md"), "utf8"), /- Test: `make test-related FILES=\{files\}`/);

  const forced = await cli(root, "init", "--write", "--force-config");
  assert.equal(forced.code, 0, forced.stderr);
  assert.match(forced.stdout, /^replaced  \.harness\/config\.json$/m);
  assert.equal(loadConfig(root).verify.test.run, "npx --no -- vitest related --run --passWithNoTests {files}");
});

test("init --write refuses an invalid existing config without --force-config", async () => {
  const root = nodeRepo({ ".harness/config.json": "{ nope" });
  const r = await cli(root, "init", "--write");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /refused  \.harness\/config\.json: the existing file is invalid/);
  assert.equal(readFileSync(join(root, ".harness/config.json"), "utf8"), "{ nope");
  assert.equal(existsSync(join(root, "AGENTS.md")), false);
  assert.equal((await cli(root, "init", "--write", "--force-config")).code, 0);
});

// Records the files a stage received, one JSON array per line, in calls.log.
const RECORD = `node -e "require('fs').appendFileSync('calls.log', JSON.stringify(process.argv.slice(1)) + '\\\\n')" --`;

const verifyRepo = (verify) =>
  makeRepo({ verify }, { "src/a.ts": "a\n", "src/b.ts": "b\n", "README.md": "r\n", ".gitignore": "calls.log\n" });
const calls = (root) =>
  existsSync(join(root, "calls.log"))
    ? readFileSync(join(root, "calls.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

test("verify: passes on changed files, fails with exit 1 and the output tail", async () => {
  const root = verifyRepo({ test: { run: `${RECORD} {files}`, files: ["**/*.ts"] }, typecheck: "exit 0" });
  writeFile(root, "src/a.ts", "a2\n");
  writeFile(root, "README.md", "docs\n");
  const ok = await cli(root, "verify");
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /^verify: 2 changed files/m);
  assert.match(ok.stdout, /^skipped  lint \(no command configured\)$/m);
  assert.match(ok.stdout, /^ok       typecheck: exit 0$/m);
  assert.match(ok.stdout, /^ok       test: node -e .* -- src\/a\.ts$/m);
  assert.match(ok.stdout, /^verify: passed$/m);
  assert.deepEqual(calls(root), [["src/a.ts"]], "README.md filtered out");

  const failing = verifyRepo({ lint: "echo lint-broke >&2; exit 3", test: "exit 0" });
  writeFile(failing, "src/a.ts", "x\n");
  const bad = await cli(failing, "verify");
  assert.equal(bad.code, 1);
  assert.match(bad.stdout, /^FAILED   lint: echo lint-broke >&2; exit 3 \(exit 3\)$/m);
  assert.match(bad.stdout, /^lint-broke$/m);
  assert.match(bad.stdout, /^ok       test: exit 0$/m, "later stages still run and report");
  assert.match(bad.stdout, /^verify: failed \(lint\)$/m);
});

test("verify: nothing changed skips {files} stages; --all checks every tracked file", async () => {
  const root = verifyRepo({ test: { run: `${RECORD} {files}`, files: ["**/*.ts"] } });
  writeFile(root, "src/new.ts", "untracked\n");
  rmSync(join(root, "src/b.ts"));
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "change");
  const none = await cli(root, "verify");
  assert.equal(none.code, 0);
  assert.match(none.stdout, /^skipped  test \(no matching changed files\)$/m);
  assert.match(none.stdout, /^verify: nothing ran \(no check executed; not a pass\)$/m);

  writeFile(root, "src/untracked.ts", "u\n");
  rmSync(join(root, "src/new.ts"));
  const all = await cli(root, "verify", "--all");
  assert.equal(all.code, 0, all.stdout);
  assert.match(all.stdout, /--all: every tracked file/);
  assert.deepEqual(calls(root), [["src/a.ts", "src/untracked.ts"]], "tracked + new files, not deleted ones");
});

test("verify: exit 2 for an invalid config or outside a git repo; usage errors are exit 2", async () => {
  const broken = makeRepo({ verify: { test: 1 } });
  const r = await cli(broken, "verify");
  assert.equal(r.code, 2);
  assert.match(r.stderr, /verify\.test must be a string/);

  const notGit = makeRepo({ verify: { test: "exit 0" } });
  rmSync(join(notGit, ".git"), { recursive: true, force: true });
  writeFile(notGit, ".git/placeholder", "");
  const ng = await cli(notGit, "verify");
  assert.equal(ng.code, 2);
  assert.match(ng.stderr, /could not list files with git/);

  assert.equal((await cli(notGit, "bogus")).code, 2);
  assert.equal((await cli(notGit)).code, 2);
  assert.equal((await cli(notGit, "verify", "--force")).code, 2);
  const help = await cli(notGit, "--help");
  assert.equal(help.code, 0);
  assert.match(help.stdout, /init \[--write\] \[--force-config\]/);
  assert.match(help.stdout, /verify \[--all \| --base <ref>\]/);
  assert.match(help.stdout, /0 passed, or nothing ran \(no check executed, which is\s+not a pass\)/);
});

/**
 * A repo on branch `feat` off `main`. `main` has src/a.ts, src/b.ts, src/gone.ts,
 * src/keep.ts and README.md; `feat` commits an edit to src/b.ts, a new src/c.ts, a rename
 * of src/a.ts to src/moved.ts, a deleted src/gone.ts and a README edit. The
 * tree is clean.
 */
function branchRepo(verify) {
  const root = makeRepo(
    { verify },
    {
      "src/a.ts": "a\n",
      "src/b.ts": "b\n",
      "src/gone.ts": "g\n",
      "src/keep.ts": "k\n",
      "README.md": "r\n",
      ".gitignore": "calls.log\n",
    },
  );
  git(root, "branch", "-M", "main");
  git(root, "checkout", "-q", "-b", "feat");
  writeFile(root, "src/b.ts", "b2\n");
  writeFile(root, "src/c.ts", "c\n");
  git(root, "mv", "src/a.ts", "src/moved.ts");
  git(root, "rm", "-q", "src/gone.ts");
  writeFile(root, "README.md", "r2\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "feat");
  return root;
}

test("verify --base: a committed branch with a clean tree is checked, and a failure exits 1", async () => {
  const root = branchRepo({ test: { run: "echo related-test-broke >&2; exit 1", files: ["**/*.ts"] } });

  const plain = await cli(root, "verify");
  assert.equal(plain.code, 0, "without --base, nothing differs from HEAD");
  assert.match(plain.stdout, /^verify: 0 changed files/m);
  assert.match(plain.stdout, /^verify: nothing ran \(no check executed; not a pass\)$/m);

  for (const args of [["--base", "main"], ["--base=main"]]) {
    const r = await cli(root, "verify", ...args);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^verify: 4 changed files \(main\.\.\.HEAD plus the working tree\)/m);
    assert.match(r.stdout, /^FAILED   test: .*\(exit 1\)$/m);
    assert.match(r.stdout, /^related-test-broke$/m);
    assert.match(r.stdout, /^verify: failed \(test\)$/m);
  }
});

test("verify --base: {files} gets only the branch's files plus working-tree edits, never deleted ones", async () => {
  const root = branchRepo({ test: { run: `${RECORD} {files}`, files: ["**/*.ts"] } });
  // Commits on main after the branch point are not the branch's changes.
  git(root, "checkout", "-q", "main");
  writeFile(root, "src/main-only.ts", "m\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "main moves on");
  git(root, "checkout", "-q", "feat");

  const branch = await cli(root, "verify", "--base", "main");
  assert.equal(branch.code, 0, branch.stdout + branch.stderr);
  assert.deepEqual(calls(root), [["src/b.ts", "src/c.ts", "src/moved.ts"]], "renamed to the new path, deleted and main-only left out");

  // Union with the working tree: an edit to a file the branch didn't touch, a
  // new untracked file, and deleting (uncommitted) a file the branch added.
  rmSync(join(root, "calls.log"));
  writeFile(root, "src/keep.ts", "k2\n");
  writeFile(root, "src/untracked.ts", "u\n");
  rmSync(join(root, "src/c.ts"));
  const union = await cli(root, "verify", "--base", "main");
  assert.equal(union.code, 0, union.stdout + union.stderr);
  assert.deepEqual(calls(root), [["src/b.ts", "src/keep.ts", "src/moved.ts", "src/untracked.ts"]]);
});

test("verify --base: a project root in a repo subdirectory sees only its own files, relative to it", async () => {
  const top = makeRepo(undefined, {
    "app/.harness/config.json": JSON.stringify({ verify: { test: { run: `${RECORD} {files}`, files: ["**/*.ts"] } } }),
    "app/src/a.ts": "a\n",
    "other/x.ts": "x\n",
    ".gitignore": "calls.log\n",
  });
  git(top, "branch", "-M", "main");
  git(top, "checkout", "-q", "-b", "feat");
  writeFile(top, "app/src/a.ts", "a2\n");
  writeFile(top, "other/x.ts", "x2\n");
  git(top, "add", "-A");
  git(top, "commit", "-q", "-m", "feat");
  const r = await cli(join(top, "app"), "verify", "--base", "main");
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(calls(join(top, "app")), [["src/a.ts"]]);
});

test("verify --base: a bad ref, a missing value or --all with --base exits 2 with a clear message", async () => {
  const root = branchRepo({ test: "exit 0" });
  const cases = [
    [["--base", "no-such-branch"], /verify --base: unknown base ref "no-such-branch": no such commit/],
    [["--base", "-rf"], /verify --base: invalid base ref "-rf"/],
    [["--base"], /verify: --base needs a value/],
    [["--base="], /verify: --base needs a value/],
    [["--base", "main", "--base", "main"], /verify: --base given twice/],
    [["--all", "--base", "main"], /--all and --base can't be combined/],
  ];
  for (const [args, re] of cases) {
    const r = await cli(root, "verify", ...args);
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, re, args.join(" "));
    assert.doesNotMatch(r.stdout, /^verify: (passed|nothing ran)/m);
  }

  // A ref with no common ancestor (an orphan branch).
  git(root, "checkout", "-q", "--orphan", "lonely");
  git(root, "commit", "-q", "-m", "orphan");
  git(root, "checkout", "-q", "feat");
  const orphan = await cli(root, "verify", "--base", "lonely");
  assert.equal(orphan.code, 2);
  assert.match(orphan.stderr, /no common ancestor/);
});

// ---------------------------------------------------------------- stats

const stage = (name, result, filesChecked) => ({ name, configured: true, ran: result === "pass" || result === "fail", result, filesChecked, ms: 4 });
const fp = "a".repeat(64);
/** Write metric entries as if recorded at `iso`. */
const record = (root, iso, entry) => recordMetric(root, entry, { now: new Date(iso), log: () => {} });
const gate = (session, outcome, changedFiles, stages) => ({ event: "Stop", policy: "verify-gate", session, fingerprint: fp, changedFiles, stages, outcome, attempt: 1 });

function statsFixture() {
  const root = makeRepo();
  const day = (d, t) => `2026-11-${d}T${t}:00Z`;
  record(root, day("20", "09:00"), { event: "SessionStart", policy: "session-context", session: "old-session" });
  record(root, day("20", "09:05"), gate("old-session", "pass", 4, [stage("lint", "pass", 4)]));
  record(root, day("22", "07:40"), { event: "SessionStart", policy: "session-context", session: "new-session" });
  record(root, day("22", "07:50"), gate("new-session", "block", 10, [stage("lint", "fail", 8)]));
  record(root, day("22", "08:00"), gate("new-session", "pass", 10, [stage("lint", "pass", 8), stage("test", "pass", 6)]));
  return root;
}

test("stats: no data is exit 0 with one line, in text and JSON modes", async () => {
  const root = makeRepo();
  assert.deepEqual(await cli(root, "stats"), { code: 0, stdout: "stats: no data\n", stderr: "" });
  const json = await cli(root, "stats", "--json");
  assert.equal(json.code, 0);
  assert.deepEqual(JSON.parse(json.stdout).sessions, []);
  assert.equal((await cli(root, "stats", "--session", "nope")).stdout, "stats: no data\n");
  assert.equal((await cli(root, "stats", "--since", "24h")).stdout, "stats: no data\n");
});

test("stats: the default reports the most recent session that has a gate run", async () => {
  const root = statsFixture();
  const r = await cli(root, "stats");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, "");
  assert.equal(
    r.stdout,
    [
      "harness stats — session new-sess… (2026-11-22 07:40 → 08:00 UTC)",
      "verification coverage   80%  (8/10 changed files checked by ≥1 stage)",
      "stages                  lint ✓ 8/10 · test ✓ 6/10",
      "gate                    2 stops · 1 block · final: pass after 1 block",
      "caught                  1 failure fixed before stop (lint 1)",
      "format-on-edit          no edits recorded",
      "guards                  0 bash denies · 0 path denies",
      "",
    ].join("\n"),
  );
  assert.equal((await cli(root, "stats", "--last")).stdout, r.stdout);
});

test("stats: --session picks one session, --json has the documented shape", async () => {
  const root = statsFixture();
  const r = await cli(root, "stats", "--session", "old-session", "--json");
  assert.equal(r.code, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.scope, "session");
  assert.deepEqual(report.sessions.map((s) => s.session), ["old-session"]);
  assert.deepEqual(report.sessions[0].coverage, { percent: 100, checked: 4, changed: 4, noChecksRan: false });
  assert.equal((await cli(root, "stats", "--session=old-session", "--json")).stdout, r.stdout, "--opt=value works");
});

test("stats: --since reports totals and a line per session", async () => {
  const root = statsFixture();
  const r = await cli(root, "stats", "--since", "2026-11-01");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^harness stats: 2 sessions$/m);
  assert.match(r.stdout, /^gate {20}3 stops · 1 block$/m);
  assert.match(r.stdout, /^ {2}old-sess… .*coverage 100% · 1 stop · 0 blocks · final pass · caught 0$/m);
  assert.match(r.stdout, /^ {2}new-sess… .*coverage 80% · 2 stops · 1 block · final pass · caught 1$/m);
  const only = JSON.parse((await cli(root, "stats", "--since", "2026-11-21", "--json")).stdout);
  assert.deepEqual(only.sessions.map((s) => s.session), ["new-session"]);
  assert.equal(only.scope, "since");
});

test("stats: skips a damaged log line and reads the rest", async () => {
  const root = statsFixture();
  const file = join(root, ".harness/state/metrics.jsonl");
  writeFileSync(file, `garbage\n{"v":9,"ts":"2026-11-22T09:00:00Z"}\n${readFileSync(file, "utf8")}`);
  const r = await cli(root, "stats");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /session new-sess…/);
});

test("stats: usage errors and an unreadable state dir are exit 2", async () => {
  const root = statsFixture();
  const cases = [
    [["stats", "--bogus"], /unknown argument --bogus/],
    [["stats", "extra"], /unknown argument extra/],
    [["stats", "--session"], /--session needs a value/],
    [["stats", "--since"], /--since needs a value/],
    [["stats", "--session", "a", "--session", "b"], /--session given twice/],
    [["stats", "--since", "last week"], /--since needs a duration/],
    [["stats", "--since", "7d", "--last"], /--last and --since can't be combined/],
    [["stats", "--session", "x", "--since", "7d"], /--session and --since can't be combined/],
    [["stats", "--last", "--session", "x"], /--last and --session can't be combined/],
  ];
  for (const [args, message] of cases) {
    const r = await cli(root, ...args);
    assert.equal(r.code, 2, args.join(" "));
    assert.equal(r.stdout, "", args.join(" "));
    assert.match(r.stderr, message, args.join(" "));
    assert.match(r.stderr, /usage: harness\.mjs/, args.join(" "));
  }
  const broken = makeRepo();
  mkdirSync(join(broken, ".harness/state/metrics.jsonl"), { recursive: true });
  const r = await cli(broken, "stats");
  assert.equal(r.code, 2);
  assert.match(r.stderr, /stats: could not read the metrics log/);
  assert.equal(r.stdout, "");
});

test("stats: runs from a subdirectory of the project", async () => {
  const root = statsFixture();
  mkdirSync(join(root, "src"));
  assert.match((await cli(join(root, "src"), "stats")).stdout, /session new-sess…/);
});
