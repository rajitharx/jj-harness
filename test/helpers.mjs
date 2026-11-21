import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Make a throwaway project dir, optionally with a .harness/config.json. */
export function makeProject(config) {
  const root = mkdtempSync(join(tmpdir(), "harness-test-"));
  mkdirSync(join(root, ".git"));
  if (config !== undefined) {
    mkdirSync(join(root, ".harness"));
    writeFileSync(join(root, ".harness", "config.json"), typeof config === "string" ? config : JSON.stringify(config));
  }
  return root;
}

/**
 * Make a real git repo (via makeProject) with `files` committed, so the
 * working tree starts clean. Identity is set locally so commits work on CI.
 * @param {object} [config]  Written to .harness/config.json and committed.
 * @param {Record<string, string>} [files]
 */
export function makeRepo(config, files = { "README.md": "hello\n" }) {
  const root = makeProject(config);
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  git(root, "config", "commit.gpgsign", "false");
  for (const [path, content] of Object.entries(files)) writeFile(root, path, content);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

/** Run git in `root`; throws on failure. */
export function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Write `content` to `root/path`, creating parent directories. */
export function writeFile(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
