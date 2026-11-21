import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../lib/config.mjs";
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
  assert.equal(out.config.verify.test.run, "npx --no vitest related --run --passWithNoTests {files}");
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
  assert.match(first.stdout, /^created  \.harness\/config\.json$/m);
  assert.match(first.stdout, /^created  CLAUDE\.md$/m);
  assert.match(first.stdout, /^created  AGENTS\.md$/m);
  assert.match(first.stdout, /^created  \.harness\/progress\.md$/m);

  const config = loadConfig(root);
  assert.equal(config.verify.test.run, "npx --no vitest related --run --passWithNoTests {files}");
  const claude = readFileSync(join(root, "CLAUDE.md"), "utf8");
  const name = root.split("/").pop();
  assert.ok(claude.startsWith(`# ${name}\n`), "project name filled");
  assert.match(claude, /- Test: `npx --no vitest related --run --passWithNoTests \{files\}` \(only for `\*\*\/\*\.js`/);
  assert.match(claude, /- Format: not configured/);
  assert.doesNotMatch(claude, /\{\{/, "every placeholder filled");
  assert.match(readFileSync(join(root, "AGENTS.md"), "utf8"), /\[CLAUDE\.md\]\(CLAUDE\.md\)/);

  const before = snapshot(root);
  const second = await cli(root, "init", "--write");
  assert.equal(second.code, 0, second.stderr);
  assert.equal((second.stdout.match(/^unchanged/gm) ?? []).length, 4, second.stdout);
  assert.deepEqual(snapshot(root), before);
});

test("init --write merges a marker block into existing CLAUDE.md and AGENTS.md, keeping user content byte for byte", async () => {
  const userClaude = "# My project\r\n\r\nHand-written rules. Keep `{{these}}` braces.\r\n<!-- not a harness marker -->"; // no trailing newline
  const userAgents = "# Agents\n\nUse tabs.\n";
  const root = nodeRepo({ "CLAUDE.md": userClaude, "AGENTS.md": userAgents });

  const r = await cli(root, "init", "--write");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^updated  CLAUDE\.md \(appended the harness block\)$/m);
  const claude = readFileSync(join(root, "CLAUDE.md"), "utf8");
  assert.ok(claude.startsWith(`${userClaude}\n\n<!-- harness:start -->`), "user content kept, block appended");
  assert.ok(claude.endsWith("<!-- harness:end -->\n"));
  assert.doesNotMatch(claude, /## Project notes/, "only the block is merged, not the whole template");
  assert.ok(readFileSync(join(root, "AGENTS.md"), "utf8").startsWith(`${userAgents}\n<!-- harness:start -->`));

  // Edit around the block, then change the config: only the block is replaced.
  const edited = claude.replace("<!-- harness:start -->", "Before the block.\n<!-- harness:start -->") + "After the block.\n";
  writeFile(root, "CLAUDE.md", edited);
  const custom = JSON.parse(readFileSync(join(root, ".harness/config.json"), "utf8"));
  custom.verify.lint = { run: "npx --no eslint {files}", files: ["**/*.ts"] };
  writeFile(root, ".harness/config.json", JSON.stringify(custom));

  const again = await cli(root, "init", "--write");
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /^kept     \.harness\/config\.json/m);
  assert.match(again.stdout, /^updated  CLAUDE\.md \(replaced the harness block\)$/m);
  const merged = readFileSync(join(root, "CLAUDE.md"), "utf8");
  const [head] = edited.split("<!-- harness:start -->");
  const [, rest] = edited.split("<!-- harness:end -->");
  assert.ok(merged.startsWith(`${head}<!-- harness:start -->`), "text before the block untouched");
  assert.ok(merged.endsWith(`<!-- harness:end -->${rest}`), "text after the block untouched");
  assert.match(merged, /- Lint: `npx --no eslint \{files\}` \(only for `\*\*\/\*\.ts`\)/, "block describes the kept config");
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
  assert.match(kept.stdout, /^kept     \.harness\/config\.json \(exists and differs from the proposal; pass --force-config to replace it\)$/m);
  assert.equal(readFileSync(join(root, ".harness/config.json"), "utf8"), mine, "byte-identical");
  assert.match(readFileSync(join(root, "CLAUDE.md"), "utf8"), /- Test: `make test-related FILES=\{files\}`/);

  const forced = await cli(root, "init", "--write", "--force-config");
  assert.equal(forced.code, 0, forced.stderr);
  assert.match(forced.stdout, /^replaced \.harness\/config\.json$/m);
  assert.equal(loadConfig(root).verify.test.run, "npx --no vitest related --run --passWithNoTests {files}");
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
  assert.match(none.stdout, /^verify: nothing ran$/m);

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
});
