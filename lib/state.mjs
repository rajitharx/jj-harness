// The harness's local, uncommitted state directory: <root>/.harness/state/.
// Owned here so every writer (verify-gate, metrics) creates it the same way.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STATE_DIR = join(".harness", "state");

/**
 * Create the state directory if needed and keep it out of the consumer's
 * commits (a self-ignoring .gitignore), even when the directory already existed.
 * Throws when it can't be created; callers decide how to fail open.
 * @param {string} root
 * @returns {string} Absolute path of the directory.
 */
export function ensureStateDir(root) {
  const dir = join(root, STATE_DIR);
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  return dir;
}
