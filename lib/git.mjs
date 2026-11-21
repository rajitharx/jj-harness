// Read-only git queries shared by the quality-loop policies.
// Every function throws when git is missing or `root` is not inside a repo;
// callers decide how to fail open.
import { execFileSync } from "node:child_process";

/** Run git in `root` and return stdout. Throws on a non-zero exit or a missing binary. */
function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** @param {string} root @returns {string} The current branch, or "HEAD" when detached. */
export function currentBranch(root) {
  return git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
}

/** Thrown by changedFiles when `base` doesn't name a commit, or has no merge base with HEAD. */
export class BaseRefError extends Error {}

/**
 * Files that differ, limited to `root` and relative to it: modified, added,
 * renamed (new path), untracked and deleted. Paths ignored by .gitignore are
 * not listed.
 * - Without `base`: the working tree vs HEAD (`git status`).
 * - With `base`: also the files the branch changed, `git diff <base>...HEAD`
 *   (from the merge base, so commits on `base` after the branch point don't
 *   count). The working tree wins for a path in both: a file committed on the
 *   branch and then deleted in the tree is deleted, and one the branch deleted
 *   but the tree re-created exists.
 * The Stop gate and `harness.mjs verify [--base]` both read changed files here.
 * @param {string} root
 * @param {string} [base]  A ref or commit; throws BaseRefError if it isn't one.
 * @returns {{ path: string, deleted: boolean }[]}  Sorted by path.
 */
export function changedFiles(root, base) {
  const files = new Map();
  if (base !== undefined) {
    for (const f of branchFiles(root, base)) files.set(f.path, f);
  }
  for (const f of workingTreeFiles(root)) files.set(f.path, f);
  return [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Files changed by commits in `base...HEAD`, relative to `root`. */
function branchFiles(root, base) {
  // A leading "-" would be read as an option; rev-parse --verify also rejects
  // anything that isn't a single commit.
  if (typeof base !== "string" || base === "" || base.startsWith("-")) throw new BaseRefError(`invalid base ref "${base}"`);
  try {
    git(root, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
  } catch {
    throw new BaseRefError(`unknown base ref "${base}": no such commit`);
  }
  try {
    git(root, ["merge-base", base, "HEAD"]);
  } catch {
    throw new BaseRefError(`base ref "${base}" has no common ancestor with HEAD`);
  }
  // --relative limits to `root` and makes paths relative to it. With -z,
  // name-status is "S\0path\0", or "R<score>\0old\0new\0" for renames and copies.
  const fields = git(root, ["diff", "--name-status", "-z", "--relative", `${base}...HEAD`]).split("\0");
  const out = [];
  for (let i = 0; i < fields.length; i++) {
    const status = fields[i];
    if (!status) continue;
    if (status[0] === "R" || status[0] === "C") i++; // skip the old path
    const path = fields[++i];
    if (path) out.push({ path, deleted: status[0] === "D" });
  }
  return out;
}

/** Working-tree files that differ from HEAD (`git status`), relative to `root`. */
function workingTreeFiles(root) {
  // Porcelain paths are relative to the repository top level, so when the
  // project root is a subdirectory, limit to it and strip its prefix.
  const prefix = git(root, ["rev-parse", "--show-prefix"]).trim();
  const out = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]);
  const fields = out.split("\0");
  const files = new Map();
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    const path = entry.slice(3);
    // With -z a rename or copy is "XY new\0old\0"; skip the old path.
    if (x === "R" || x === "C" || y === "R" || y === "C") i++;
    if (!path.startsWith(prefix)) continue;
    files.set(path.slice(prefix.length), { path: path.slice(prefix.length), deleted: x === "D" || y === "D" });
  }
  return files.values();
}

/**
 * Files in the index under `root`, relative to it (ls-files prints paths
 * relative to the cwd). Includes tracked files deleted from the working tree;
 * callers that need existing files filter them.
 * @param {string} root
 * @returns {string[]}  Sorted by path.
 */
export function trackedFiles(root) {
  return git(root, ["ls-files", "-z", "--", "."]).split("\0").filter(Boolean).sort();
}
