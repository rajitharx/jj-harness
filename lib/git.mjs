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

/**
 * Files in the working tree that differ from HEAD: modified, added, renamed
 * (new path), untracked and deleted, limited to `root` and relative to it.
 * Paths ignored by .gitignore are not listed.
 * @param {string} root
 * @returns {{ path: string, deleted: boolean }[]}  Sorted by path.
 */
export function changedFiles(root) {
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
  return [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
